import { Injectable } from "@nestjs/common";
import type { CategoriaTemplate, StatusTemplate, Template } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { paraTemplate, type LinhaTemplate } from "../comum/mapeadores";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import { empresaParaEscrita, noEscopo } from "../comum/escopo";

const COLUNAS =
  "id, nome, categoria, status, idioma, corpo, variaveis, meta_template_id, atualizado_em";

export interface ConsultaTemplates {
  categoria?: CategoriaTemplate | "todas";
  status?: StatusTemplate | "todos";
  busca?: string;
}

export interface NovoTemplate {
  nome: string;
  categoria: CategoriaTemplate;
  idioma: string;
  corpo: string;
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  async listar(usuario: UsuarioAutenticado, q: ConsultaTemplates = {}): Promise<Template[]> {
    let consulta = noEscopo(
      this.supabase
        .tabela("templates")
        .select(COLUNAS)
        .order("atualizado_em", { ascending: false }),
      usuario,
    );

    if (q.categoria && q.categoria !== "todas") consulta = consulta.eq("categoria", q.categoria);
    if (q.status && q.status !== "todos") consulta = consulta.eq("status", q.status);
    if (q.busca) {
      const alvo = q.busca.replace(/[,()]/g, " ");
      consulta = consulta.or(`nome.ilike.%${alvo}%,corpo.ilike.%${alvo}%`);
    }

    const { data, error } = await consulta;
    if (error) throw new Error(`Falha ao listar templates: ${error.message}`);
    return (data as unknown as LinhaTemplate[]).map(paraTemplate);
  }

  async criar(usuario: UsuarioAutenticado, dados: NovoTemplate, ip: string): Promise<Template> {
    const { data, error } = await this.supabase
      .tabela("templates")
      .insert({
        nome: dados.nome,
        categoria: dados.categoria,
        idioma: dados.idioma,
        corpo: dados.corpo,
        status: "pendente",
        variaveis: contarVariaveis(dados.corpo),
        empresa_id: empresaParaEscrita(usuario),
      })
      .select(COLUNAS)
      .single();

    if (error) throw new Error(`Falha ao criar template: ${error.message}`);
    const template = paraTemplate(data as unknown as LinhaTemplate);

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "template.criado",
      tipoEntidade: "template",
      entidadeId: template.id,
      entidadeRotulo: template.nome,
      ip,
      detalhes: { categoria: template.categoria, variaveis: template.variaveis },
    });

    return template;
  }

  /**
   * Importa os templates da conta Meta.
   *
   * O upsert usa a chave natural da Meta — (nome, idioma) — em vez do
   * id local, porque o mesmo template pode já existir aqui com outro id, e
   * duplicá-lo faria a listagem mostrar o mesmo nome duas vezes com status
   * divergente.
   */
  async sincronizar(
    usuario: UsuarioAutenticado,
    ip: string,
  ): Promise<{ importados: number; atualizados: number; total: number }> {
    const vindos = await this.whatsapp.listarTemplatesMeta();

    const empresaId = empresaParaEscrita(usuario);
    const existentes = await this.listar(usuario);
    const chave = (nome: string, idioma: string) => `${nome}::${idioma}`;
    const jaTinha = new Set(existentes.map((t) => chave(t.nome, t.idioma)));

    if (vindos.length > 0) {
      const { error } = await this.supabase.tabela("templates").upsert(
        vindos.map((t) => ({
          nome: t.nome,
          categoria: t.categoria,
          status: t.status,
          idioma: t.idioma,
          corpo: t.corpo,
          variaveis: t.variaveis,
          meta_template_id: t.metaTemplateId ?? null,
          atualizado_em: new Date().toISOString(),
          empresa_id: empresaId,
        })),
        // A chave natural da Meta é (nome, idioma), mas ela só é única DENTRO
        // de uma conta. Sem `empresa_id` aqui, sincronizar sobrescreveria o
        // template homônimo de outra empresa.
        { onConflict: "empresa_id,nome,idioma" },
      );
      if (error) throw new Error(`Falha ao sincronizar templates: ${error.message}`);
    }

    const atualizados = vindos.filter((t) => jaTinha.has(chave(t.nome, t.idioma))).length;
    const importados = vindos.length - atualizados;

    await this.auditoria.registrar({
      usuarioId: usuario.id,
      usuarioNome: usuario.nome,
      acao: "template.sincronizado",
      tipoEntidade: "template",
      entidadeId: null,
      entidadeRotulo: `${vindos.length} templates da conta Meta`,
      ip,
      detalhes: { importados, atualizados },
    });

    return { importados, atualizados, total: vindos.length };
  }
}

function contarVariaveis(corpo: string): number {
  return new Set([...corpo.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size;
}
