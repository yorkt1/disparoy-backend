import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Spintax } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { paraSpintax, type LinhaSpintax } from "../comum/mapeadores";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { empresaParaEscrita, noEscopo } from "../comum/escopo";
import { ErroGerador, gerarVariacoes, geradorConfigurado } from "./gerador";

const COLUNAS = "id, nome, opcoes, criado_em";

@Injectable()
export class SpintaxService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async listar(usuario: UsuarioAutenticado): Promise<Spintax[]> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("spintax").select(COLUNAS),
      usuario,
    ).order("nome");

    if (error) throw new Error(`Falha ao listar variações: ${error.message}`);
    return (data as unknown as LinhaSpintax[]).map(paraSpintax);
  }

  /**
   * Cria ou substitui a variação. O nome é a chave que aparece no texto como
   * {{*nome*}}, então salvar com um nome já usado significa editar a lista —
   * não criar uma segunda com o mesmo identificador.
   */
  async salvar(
    usuario: UsuarioAutenticado,
    dados: { nome: string; opcoes: string[] },
    ip: string,
  ): Promise<Spintax> {
    const nome = dados.nome.toLowerCase();

    const { data, error } = await this.supabase
      .tabela("spintax")
      .upsert(
        {
          nome,
          opcoes: dados.opcoes,
          criado_por: usuario.id,
          empresa_id: empresaParaEscrita(usuario),
        },
        // Por `(empresa_id, nome)`, casando com o índice criado na migration de
        // empresas. Só por `nome`, a variação de uma empresa sobrescreveria a
        // de outra que usasse o mesmo identificador — e `{{*saudacao*}}` é um
        // nome que todo mundo escolhe.
        { onConflict: "empresa_id,nome" },
      )
      .select(COLUNAS)
      .single();

    if (error) throw new Error(`Falha ao salvar variação: ${error.message}`);
    const spintax = paraSpintax(data as unknown as LinhaSpintax);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "spintax.criado",
      tipoEntidade: "spintax",
      entidadeId: spintax.id,
      entidadeRotulo: spintax.nome,
      ip,
      detalhes: { opcoes: spintax.opcoes.length },
    });

    return spintax;
  }

  /**
   * Variações geradas a partir do texto original.
   *
   * Nada é gravado: o operador ainda lê, edita e decide o que salvar. Texto
   * gerado entrando direto na campanha seria disparo de mensagem que ninguém
   * conferiu.
   */
  async gerar(
    usuario: UsuarioAutenticado,
    dados: { texto: string; quantidade: number },
    ip: string,
  ): Promise<string[]> {
    if (!geradorConfigurado()) {
      throw new ServiceUnavailableException(
        "Geração de variações não configurada: preencha GROQ_API_KEY em backend/.env. " +
          "Escrever as opções à mão continua funcionando.",
      );
    }

    let variacoes: string[];
    try {
      variacoes = await gerarVariacoes(dados.texto, dados.quantidade);
    } catch (e) {
      if (e instanceof ErroGerador) throw new UnprocessableEntityException(e.message);
      throw e;
    }

    // Sem o texto na trilha: o log de auditoria é lido por admin e não precisa
    // guardar o conteúdo das mensagens para registrar que alguém gerou opções.
    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "spintax.criado",
      tipoEntidade: "spintax",
      entidadeId: null,
      entidadeRotulo: "Variações geradas",
      ip,
      detalhes: { geradas: variacoes.length - 1, caracteres: dados.texto.length },
    });

    return variacoes;
  }

  async excluir(usuario: UsuarioAutenticado, id: string, ip: string): Promise<void> {
    const { data, error } = await noEscopo(
      this.supabase.tabela("spintax").delete().eq("id", id),
      usuario,
    )
      .select(COLUNAS)
      .maybeSingle();

    if (error) throw new Error(`Falha ao excluir variação: ${error.message}`);
    if (!data) throw new NotFoundException("Variação não encontrada.");

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "spintax.excluido",
      tipoEntidade: "spintax",
      entidadeId: id,
      entidadeRotulo: (data as unknown as LinhaSpintax).nome,
      ip,
    });
  }
}
