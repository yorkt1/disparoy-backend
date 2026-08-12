import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  Campanha,
  CampanhaEntrada,
  ContatoDaCampanha,
  MetricasDashboard,
  Paginado,
  ResumoCampanha,
  StatusCampanha,
} from "@disparoy/dominio";
import { percentual } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { CanaisService } from "../canais/canais.service";
import { FilaService } from "../fila/fila.service";
import {
  COLUNAS_CAMPANHA,
  paraCampanha,
  paraContatoDaCampanha,
  paraResumoCampanha,
  type LinhaCampanha,
  type LinhaContatoCampanha,
} from "../comum/mapeadores";
import type { UsuarioAutenticado } from "../auth/auth.guard";

export interface ConsultaCampanhas {
  pagina?: number;
  porPagina?: number;
  busca?: string;
  status?: StatusCampanha | "todas";
}

@Injectable()
export class CampanhasService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly canais: CanaisService,
    private readonly fila: FilaService,
  ) {}

  // ------------------------------------------------------------------------
  // Leitura
  // ------------------------------------------------------------------------

  async listar(q: ConsultaCampanhas = {}): Promise<Paginado<ResumoCampanha>> {
    const pagina = Math.max(q.pagina ?? 1, 1);
    const porPagina = Math.min(Math.max(q.porPagina ?? 10, 5), 100);
    const de = (pagina - 1) * porPagina;

    let consulta = this.supabase
      .tabela("campanhas")
      .select(COLUNAS_CAMPANHA, { count: "exact" })
      .order("criada_em", { ascending: false })
      .range(de, de + porPagina - 1);

    if (q.status && q.status !== "todas") consulta = consulta.eq("status", q.status);
    if (q.busca) consulta = consulta.ilike("nome", `%${q.busca.replace(/[,()]/g, " ")}%`);

    const { data, error, count } = await consulta;
    if (error) throw new Error(`Falha ao listar campanhas: ${error.message}`);

    const total = count ?? 0;
    return {
      itens: (data as unknown as LinhaCampanha[]).map(paraResumoCampanha),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.max(Math.ceil(total / porPagina), 1),
    };
  }

  async obter(id: string): Promise<Campanha> {
    const { data, error } = await this.supabase
      .tabela("campanhas")
      .select(COLUNAS_CAMPANHA)
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(`Falha ao carregar campanha: ${error.message}`);
    if (!data) throw new NotFoundException("Campanha não encontrada.");
    return paraCampanha(data as unknown as LinhaCampanha);
  }

  /** Amostra de contatos: a tela de detalhes mostra os primeiros, não os 20 mil. */
  async amostraDeContatos(id: string, limite = 50): Promise<ContatoDaCampanha[]> {
    const { data } = await this.supabase
      .tabela("campanha_contatos")
      .select("id, contato_id, telefone, status, motivo, variaveis, contatos(nome)")
      .eq("campanha_id", id)
      .order("id")
      .limit(limite);

    return ((data ?? []) as unknown as LinhaContatoCampanha[]).map(paraContatoDaCampanha);
  }

  async metricasDashboard(): Promise<MetricasDashboard> {
    const [campanhas, elegiveis, optOut] = await Promise.all([
      this.supabase
        .tabela("campanhas")
        .select(
          "iniciada_em, total_enviadas, total_entregues, total_lidas, total_falhas, total_respostas",
        ),
      this.supabase
        .tabela("contatos")
        .select("id", { count: "exact", head: true })
        .eq("opt_in", true)
        .is("opt_out_em", null),
      this.supabase
        .tabela("contatos")
        .select("id", { count: "exact", head: true })
        .not("opt_out_em", "is", null),
    ]);

    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);

    const linhas = (campanhas.data ?? []) as {
      iniciada_em: string | null;
      total_enviadas: number;
      total_entregues: number;
      total_lidas: number;
      total_falhas: number;
      total_respostas: number;
    }[];

    const agregado = linhas.reduce(
      (acc, c) => {
        acc.enviadas += c.total_enviadas;
        acc.entregues += c.total_entregues;
        acc.lidas += c.total_lidas;
        acc.falhas += c.total_falhas;
        acc.respostas += c.total_respostas;
        if (c.iniciada_em) {
          acc.campanhas += 1;
          if (new Date(c.iniciada_em) >= inicioDoDia) acc.hoje += c.total_enviadas;
        }
        return acc;
      },
      { enviadas: 0, entregues: 0, lidas: 0, falhas: 0, respostas: 0, hoje: 0, campanhas: 0 },
    );

    return {
      totalCampanhasEnviadas: agregado.campanhas,
      mensagensHoje: agregado.hoje,
      taxaEntrega: percentual(agregado.entregues, agregado.enviadas),
      taxaLeitura: percentual(agregado.lidas, agregado.entregues),
      respostasRecebidas: agregado.respostas,
      contatosElegiveis: elegiveis.count ?? 0,
      contatosOptOut: optOut.count ?? 0,
      porStatus: {
        enviadas: agregado.enviadas,
        entregues: agregado.entregues,
        lidas: agregado.lidas,
        falhas: agregado.falhas,
      },
    };
  }

  // ------------------------------------------------------------------------
  // Escrita
  // ------------------------------------------------------------------------

  /**
   * Cria a campanha e, se a ação for disparar, enfileira o job de início.
   *
   * Nada é enviado dentro desta requisição: a API só grava e enfileira. Quem
   * envia é o worker — com 15–45 s entre contatos, uma campanha de 3.000
   * pessoas leva ~25 horas e não cabe em request HTTP nenhum.
   */
  async criar(
    usuario: UsuarioAutenticado,
    dados: CampanhaEntrada,
    ip: string,
  ): Promise<ResumoCampanha> {
    await this.exigirCanaisProntos(usuario, dados.canaisIds);

    const status: StatusCampanha =
      dados.acao === "rascunho" ? "rascunho" : dados.agendadaPara ? "agendada" : "em_andamento";

    const { data, error } = await this.supabase
      .tabela("campanhas")
      .insert({
        nome: dados.nome,
        status,
        lista_id: dados.listaId,
        sequencia: dados.sequencia,
        intervalo_contatos_min: dados.intervaloEntreContatos.minSegundos,
        intervalo_contatos_max: dados.intervaloEntreContatos.maxSegundos,
        intervalo_mensagens_min: dados.intervaloEntreMensagens.minSegundos,
        intervalo_mensagens_max: dados.intervaloEntreMensagens.maxSegundos,
        validar_numeros: dados.validarNumeros,
        agendada_para: dados.agendadaPara,
        template_principal: dados.sequencia[0]?.templateId ?? null,
        criada_por: usuario.id,
        iniciada_em: status === "em_andamento" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Falha ao criar campanha: ${error.message}`);
    const campanhaId = (data as { id: string }).id;

    await this.vincularCanais(campanhaId, dados.canaisIds);

    /**
     * O filtro de consentimento roda no banco, não aqui: é a última barreira
     * antes de a mensagem existir, e nenhum caminho de código a contorna.
     */
    const { data: total, error: erroPopular } = await this.supabase.db.rpc(
      "popular_contatos_da_campanha",
      { p_campanha_id: campanhaId, p_lista_id: dados.listaId },
    );
    if (erroPopular) throw new Error(`Falha ao carregar os contatos: ${erroPopular.message}`);

    const elegiveis = Number(total ?? 0);
    if (dados.acao === "disparar" && elegiveis === 0) {
      // Sem contato elegível não há campanha — e deixar em `em_andamento`
      // criaria uma campanha eternamente parada em 0%.
      await this.supabase.tabela("campanhas").update({ status: "rascunho" }).eq("id", campanhaId);
      throw new ConflictException(
        "Nenhum contato da lista pode receber mensagem: todos estão sem consentimento ou pediram para sair.",
      );
    }

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: dados.acao === "rascunho" ? "campanha.rascunho_salvo" : "campanha.criada",
      tipoEntidade: "campanha",
      entidadeId: campanhaId,
      entidadeRotulo: dados.nome,
      ip,
      detalhes: {
        contatosElegiveis: elegiveis,
        canais: dados.canaisIds.length,
        mensagensPorContato: dados.sequencia.length,
      },
    });

    if (status !== "rascunho") {
      await this.fila.agendarCampanha({ campanhaId }, dados.agendadaPara);
      await this.auditoria.registrar({
        usuarioId: usuario.id,
        usuarioNome: usuario.nome,
        acao: "campanha.iniciada",
        tipoEntidade: "campanha",
        entidadeId: campanhaId,
        entidadeRotulo: dados.nome,
        ip,
        detalhes: {
          agendadaPara: dados.agendadaPara,
          totalMensagens: elegiveis * dados.sequencia.length,
        },
      });
    }

    return paraResumoCampanha(
      (await this.linha(campanhaId)) ?? ({ id: campanhaId } as LinhaCampanha),
    );
  }

  async pausar(usuario: UsuarioAutenticado, id: string, ip: string): Promise<ResumoCampanha> {
    const campanha = await this.obter(id);
    if (campanha.status !== "em_andamento" && campanha.status !== "agendada") {
      throw new ConflictException("Só é possível pausar campanha agendada ou em andamento.");
    }

    await this.fila.cancelarCampanha(id);
    await this.supabase.tabela("campanhas").update({ status: "pausada" }).eq("id", id);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.pausada",
      tipoEntidade: "campanha",
      entidadeId: id,
      entidadeRotulo: campanha.nome,
      ip,
      detalhes: { motivo: "solicitação do operador" },
    });

    return paraResumoCampanha((await this.linha(id))!);
  }

  /** Retoma de onde parou: os contatos já enviados continuam marcados. */
  async retomar(usuario: UsuarioAutenticado, id: string, ip: string): Promise<ResumoCampanha> {
    const campanha = await this.obter(id);
    if (campanha.status !== "pausada" && campanha.status !== "rascunho") {
      throw new ConflictException("Só é possível retomar campanha pausada ou em rascunho.");
    }
    await this.exigirCanaisProntos(usuario, campanha.canaisIds);

    await this.supabase
      .tabela("campanhas")
      .update({
        status: "em_andamento",
        iniciada_em: campanha.iniciadaEm ?? new Date().toISOString(),
      })
      .eq("id", id);

    await this.fila.agendarCampanha({ campanhaId: id }, null);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "campanha.iniciada",
      tipoEntidade: "campanha",
      entidadeId: id,
      entidadeRotulo: campanha.nome,
      ip,
      detalhes: { retomada: true },
    });

    return paraResumoCampanha((await this.linha(id))!);
  }

  // ------------------------------------------------------------------------
  // Apoio
  // ------------------------------------------------------------------------

  private async linha(id: string): Promise<LinhaCampanha | null> {
    const { data } = await this.supabase
      .tabela("campanhas")
      .select(COLUNAS_CAMPANHA)
      .eq("id", id)
      .maybeSingle();
    return (data as unknown as LinhaCampanha) ?? null;
  }

  /** Canal precisa existir, estar conectado e ser acessível ao usuário. */
  private async exigirCanaisProntos(
    usuario: UsuarioAutenticado,
    canaisIds: string[],
  ): Promise<void> {
    for (const id of canaisIds) await this.canais.exigirAcesso(usuario, id);

    const { data, error } = await this.supabase
      .tabela("canais")
      .select("id, nome, status")
      .in("id", canaisIds);

    if (error) throw new Error(`Falha ao verificar canais: ${error.message}`);

    const encontrados = (data ?? []) as { id: string; nome: string; status: string }[];
    const problemas = canaisIds
      .map((id) => encontrados.find((c) => c.id === id))
      .filter((c) => !c || c.status !== "conectado");

    if (problemas.length > 0) {
      // Disparar por canal caído falha contato a contato — melhor barrar aqui.
      const nomes = problemas.map((c) => c?.nome ?? "canal removido").join(", ");
      throw new ConflictException(`Canal indisponível ou desconectado: ${nomes}.`);
    }
  }

  private async vincularCanais(campanhaId: string, canaisIds: string[]): Promise<void> {
    const { error } = await this.supabase
      .tabela("campanha_canais")
      .insert(canaisIds.map((canal_id) => ({ campanha_id: campanhaId, canal_id })));
    if (error) throw new Error(`Falha ao vincular canais: ${error.message}`);
  }
}
