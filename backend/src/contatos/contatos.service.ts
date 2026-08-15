import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Contato, Lista, Paginado } from "@disparoy/dominio";
import { z } from "zod";
import {
  importacaoContatosSchema,
  listaEntradaSchema,
  normalizarTelefone,
} from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import {
  COLUNAS_CONTATO,
  paraContato,
  paraLista,
  type LinhaContato,
  type LinhaLista,
} from "../comum/mapeadores";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { empresaParaEscrita, noEscopo } from "../comum/escopo";

type Importacao = z.infer<typeof importacaoContatosSchema>;

/** Contatos são gravados em blocos: 20 mil num INSERT só estoura limites. */
const TAMANHO_LOTE = 500;

export interface ConsultaContatos {
  pagina?: number;
  porPagina?: number;
  busca?: string;
  /** `elegiveis` = pode receber agora; `sem_opt_in`/`opt_out` para revisão. */
  situacao?: "todos" | "elegiveis" | "sem_opt_in" | "opt_out";
}

@Injectable()
export class ContatosService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
  ) {}

  // ------------------------------------------------------------------------
  // Contatos
  // ------------------------------------------------------------------------

  async listar(usuario: UsuarioAutenticado, q: ConsultaContatos = {}): Promise<Paginado<Contato>> {
    const pagina = Math.max(q.pagina ?? 1, 1);
    const porPagina = Math.min(Math.max(q.porPagina ?? 25, 5), 200);
    const de = (pagina - 1) * porPagina;

    let consulta = noEscopo(
      this.supabase
        .tabela("contatos")
        .select(COLUNAS_CONTATO, { count: "exact" })
        .order("criado_em", { ascending: false })
        .range(de, de + porPagina - 1),
      usuario,
    );

    switch (q.situacao) {
      case "elegiveis":
        consulta = consulta.eq("opt_in", true).is("opt_out_em", null);
        break;
      case "sem_opt_in":
        consulta = consulta.eq("opt_in", false).is("opt_out_em", null);
        break;
      case "opt_out":
        consulta = consulta.not("opt_out_em", "is", null);
        break;
      default:
        break;
    }

    if (q.busca) {
      const alvo = q.busca.replace(/[,()]/g, " ");
      consulta = consulta.or(`nome.ilike.%${alvo}%,telefone.ilike.%${alvo}%`);
    }

    const { data, error, count } = await consulta;
    if (error) throw new Error(`Falha ao listar contatos: ${error.message}`);

    const total = count ?? 0;
    return {
      itens: (data as unknown as LinhaContato[]).map(paraContato),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.max(Math.ceil(total / porPagina), 1),
    };
  }

  /**
   * Importa contatos com consentimento registrado.
   *
   * O `upsert` por telefone é o comportamento certo: reimportar a mesma
   * planilha atualiza nome e variáveis em vez de duplicar a pessoa. O que
   * NUNCA é sobrescrito é o `opt_out_em` — quem pediu para sair continua fora,
   * mesmo aparecendo de novo num arquivo.
   *
   * O conflito é por `(empresa_id, telefone)`, nunca só por telefone. Com a
   * chave global, a segunda empresa a importar um número que a primeira já
   * tinha não criava linha nova: ela ASSUMIA a linha da primeira, herdava nome,
   * tags e variáveis, e a incluía nas próprias listas. Cada `empresa_id` daqui
   * para baixo existe por causa disso.
   */
  async importar(
    usuario: UsuarioAutenticado,
    dados: Importacao,
    ip: string,
  ): Promise<{ importados: number; atualizados: number; ignorados: number; listaId: string | null }> {
    const validos = dados.contatos.filter((c) => c.valido && c.telefone);
    if (validos.length === 0) {
      throw new BadRequestException("Nenhum contato válido na importação.");
    }

    const empresaId = empresaParaEscrita(usuario);

    // Quem já pediu saída não volta pela importação. A busca é no escopo da
    // empresa: o opt-out de um contato de OUTRO cliente não diz nada sobre o
    // consentimento que esta empresa registrou para o mesmo número.
    const telefones = validos.map((c) => c.telefone);
    const jaExistentes = await this.buscarPorTelefones(empresaId, telefones);
    const saiu = new Set(
      jaExistentes.filter((c) => c.optOutEm !== null).map((c) => c.telefone),
    );
    const conhecidos = new Set(jaExistentes.map((c) => c.telefone));

    const aGravar = validos.filter((c) => !saiu.has(c.telefone));
    const agora = new Date().toISOString();

    for (let i = 0; i < aGravar.length; i += TAMANHO_LOTE) {
      const lote = aGravar.slice(i, i + TAMANHO_LOTE).map((c) => ({
        empresa_id: empresaId,
        telefone: c.telefone,
        nome: c.nome,
        tags: dados.tags,
        opt_in: true,
        opt_in_origem: dados.consentimento.origem,
        opt_in_em: dados.consentimento.obtidoEm,
        variaveis: c.variaveis,
        criado_por: usuario.id,
        atualizado_em: agora,
      }));

      const { error } = await this.supabase
        .tabela("contatos")
        .upsert(lote, { onConflict: "empresa_id,telefone" });
      if (error) throw new Error(`Falha ao gravar contatos: ${error.message}`);
    }

    const listaId = await this.resolverLista(usuario, empresaId, dados);
    if (listaId) {
      await this.vincularALista(empresaId, listaId, aGravar.map((c) => c.telefone));
    }

    const atualizados = aGravar.filter((c) => conhecidos.has(c.telefone)).length;
    const importados = aGravar.length - atualizados;

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "contatos.importados",
      tipoEntidade: "contato",
      entidadeId: listaId,
      entidadeRotulo: `${aGravar.length} contatos importados`,
      ip,
      detalhes: {
        importados,
        atualizados,
        ignoradosPorOptOut: saiu.size,
        invalidos: dados.contatos.length - validos.length,
        origemConsentimento: dados.consentimento.origem,
      },
    });

    return { importados, atualizados, ignorados: saiu.size, listaId };
  }

  async obter(usuario: UsuarioAutenticado, id: string): Promise<Contato> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("contatos").select(COLUNAS_CONTATO).eq("id", id),
      usuario,
    ).maybeSingle();

    if (error) throw new Error(`Falha ao carregar contato: ${error.message}`);
    if (!data) throw new NotFoundException("Contato não encontrado.");
    return paraContato(data as unknown as LinhaContato);
  }

  /** Registra a saída do contato e o tira das campanhas ainda não enviadas. */
  async registrarOptOut(
    usuario: UsuarioAutenticado | null,
    telefone: string,
    motivo: string,
    ip?: string,
  ): Promise<boolean> {
    const normalizado = normalizarTelefone(telefone);
    if (!normalizado.valido) return false;

    /*
     * `p_empresa_id` nulo significa TODAS as empresas, e é o que o webhook usa:
     * o pedido chega por WhatsApp sem que se resolva de qual canal veio. Para
     * o opt-out essa é a direção segura — marcar demais tira alguém de uma
     * campanha, marcar de menos manda mensagem para quem pediu para parar.
     *
     * Pelo painel a empresa é conhecida e vai junto: o clique de um cliente não
     * pode apagar o consentimento que outro registrou para o mesmo número.
     */
    const { data, error } = await this.supabase.db.rpc("registrar_opt_out", {
      p_telefone: normalizado.e164,
      p_motivo: motivo,
      p_empresa_id: usuario?.empresaId ?? null,
    });
    if (error) throw new Error(`Falha ao registrar opt-out: ${error.message}`);
    // Agora devolve QUANTAS linhas marcou: zero é "já estava fora, ou telefone
    // desconhecido nesta empresa".
    if (!data || Number(data) === 0) return false;

    await this.auditoria.registrar({
      usuarioId: usuario?.id ?? null,
      usuarioNome: usuario?.nome ?? "Sistema",
      acao: "contato.opt_out",
      tipoEntidade: "contato",
      // A função devolve uma contagem, não mais o id de um contato: o mesmo
      // telefone pode existir em várias empresas e não há UMA entidade a
      // apontar. O telefone no rótulo é o que identifica o caso na trilha.
      entidadeId: null,
      entidadeRotulo: normalizado.e164,
      ip,
      detalhes: { motivo, contatosMarcados: Number(data) },
    });

    return true;
  }

  /**
   * Exclusão definitiva a pedido do titular (direito ao esquecimento).
   *
   * Apaga o contato; as mensagens já enviadas continuam no histórico com o
   * telefone gravado na linha, porque são registro de operação — mas nada mais
   * liga aquele número a um cadastro.
   */
  async excluir(usuario: UsuarioAutenticado, id: string, ip: string): Promise<void> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("contatos").delete().eq("id", id),
      usuario,
    )
      .select("telefone")
      .maybeSingle();

    if (error) throw new Error(`Falha ao excluir contato: ${error.message}`);
    if (!data) throw new NotFoundException("Contato não encontrado.");

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "contato.excluido",
      tipoEntidade: "contato",
      entidadeId: id,
      entidadeRotulo: (data as { telefone: string }).telefone,
      ip,
      detalhes: { motivo: "solicitação do titular" },
    });
  }

  // ------------------------------------------------------------------------
  // Listas
  // ------------------------------------------------------------------------

  async listarListas(usuario: UsuarioAutenticado): Promise<Lista[]> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("listas").select("id, nome, descricao, criada_em"),
      usuario,
    ).order("criada_em", { ascending: false });

    if (error) throw new Error(`Falha ao listar listas: ${error.message}`);
    const linhas = (data ?? []) as unknown as LinhaLista[];

    // Duas contagens por lista: o total e — o que realmente importa — quantos
    // podem legalmente receber agora.
    return Promise.all(
      linhas.map(async (l) => {
        const [{ count }, { data: elegiveis }] = await Promise.all([
          this.supabase
            .tabela("lista_contatos")
            .select("contato_id", { count: "exact", head: true })
            .eq("lista_id", l.id),
          this.supabase.db.rpc("contatos_elegiveis_da_lista", { p_lista_id: l.id }),
        ]);
        return paraLista(l, count ?? 0, Number(elegiveis ?? 0));
      }),
    );
  }

  async criarLista(
    usuario: UsuarioAutenticado,
    dados: z.infer<typeof listaEntradaSchema>,
    ip: string,
  ): Promise<Lista> {
    const { data, error } = await this.supabase
      .tabela("listas")
      .insert({
        nome: dados.nome,
        descricao: dados.descricao,
        criado_por: usuario.id,
        empresa_id: empresaParaEscrita(usuario),
      })
      .select("id, nome, descricao, criada_em")
      .single();

    if (error) throw new Error(`Falha ao criar lista: ${error.message}`);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "lista.criada",
      tipoEntidade: "lista",
      entidadeId: (data as { id: string }).id,
      entidadeRotulo: dados.nome,
      ip,
    });

    return paraLista(data as unknown as LinhaLista, 0, 0);
  }

  async excluirLista(usuario: UsuarioAutenticado, id: string, ip: string): Promise<void> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("listas").delete().eq("id", id),
      usuario,
    )
      .select("nome")
      .maybeSingle();

    // 23503: campanha aponta para a lista com ON DELETE RESTRICT.
    if (error?.code === "23503") {
      throw new BadRequestException(
        "Esta lista está vinculada a uma campanha e não pode ser excluída.",
      );
    }
    if (error) throw new Error(`Falha ao excluir lista: ${error.message}`);
    if (!data) throw new NotFoundException("Lista não encontrada.");

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "lista.excluida",
      tipoEntidade: "lista",
      entidadeId: id,
      entidadeRotulo: (data as { nome: string }).nome,
      ip,
    });
  }

  // ------------------------------------------------------------------------
  // Apoio
  // ------------------------------------------------------------------------

  private async buscarPorTelefones(empresaId: string, telefones: string[]): Promise<Contato[]> {
    const encontrados: Contato[] = [];
    for (let i = 0; i < telefones.length; i += TAMANHO_LOTE) {
      const { data } = await this.supabase
        .tabela("contatos")
        .select(COLUNAS_CONTATO)
        .eq("empresa_id", empresaId)
        .in("telefone", telefones.slice(i, i + TAMANHO_LOTE));
      encontrados.push(...((data ?? []) as unknown as LinhaContato[]).map(paraContato));
    }
    return encontrados;
  }

  /**
   * A lista de destino da importação.
   *
   * `dados.listaId` chega do cliente e por isso é CONFERIDO, não aceitado: sem
   * esta checagem, bastava mandar o id de uma lista de outra empresa para
   * despejar a própria importação dentro dela.
   */
  private async resolverLista(
    usuario: UsuarioAutenticado,
    empresaId: string,
    dados: Importacao,
  ): Promise<string | null> {
    if (dados.listaId) {
      const { data, error } = await this.supabase
        .tabela("listas")
        .select("id")
        .eq("id", dados.listaId)
        .eq("empresa_id", empresaId)
        .maybeSingle();

      if (error) throw new Error(`Falha ao conferir a lista: ${error.message}`);
      if (!data) throw new NotFoundException("Lista não encontrada.");
      return dados.listaId;
    }
    if (!dados.novaLista) return null;

    const { data, error } = await this.supabase
      .tabela("listas")
      .insert({ nome: dados.novaLista, criado_por: usuario.id, empresa_id: empresaId })
      .select("id")
      .single();

    if (error) throw new Error(`Falha ao criar lista: ${error.message}`);
    return (data as { id: string }).id;
  }

  private async vincularALista(
    empresaId: string,
    listaId: string,
    telefones: string[],
  ): Promise<void> {
    for (let i = 0; i < telefones.length; i += TAMANHO_LOTE) {
      // O `eq("empresa_id")` é o que impede o vínculo de pegar a linha do MESMO
      // telefone pertencente a outra empresa — que era o caminho pelo qual o
      // contato de um cliente acabava dentro da lista de outro.
      const { data } = await this.supabase
        .tabela("contatos")
        .select("id")
        .eq("empresa_id", empresaId)
        .in("telefone", telefones.slice(i, i + TAMANHO_LOTE));

      const vinculos = ((data ?? []) as { id: string }[]).map((c) => ({
        lista_id: listaId,
        contato_id: c.id,
      }));
      if (vinculos.length === 0) continue;

      const { error } = await this.supabase
        .tabela("lista_contatos")
        .upsert(vinculos, { onConflict: "lista_id,contato_id", ignoreDuplicates: true });
      if (error) throw new Error(`Falha ao vincular contatos à lista: ${error.message}`);
    }
  }
}
