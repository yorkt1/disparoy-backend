import { Injectable, Logger } from "@nestjs/common";
import type { AcaoLog, LogAuditoria, Paginado, TipoEntidade } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { COLUNAS_LOG, paraLog, type LinhaLog } from "../comum/mapeadores";

export interface EntradaLog {
  /** `null` quando a ação vem do worker ou de um webhook, não de uma pessoa. */
  usuarioId: string | null;
  usuarioNome: string;
  acao: AcaoLog;
  tipoEntidade: TipoEntidade;
  entidadeId: string | null;
  entidadeRotulo: string;
  ip?: string;
  detalhes?: Record<string, unknown>;
}

export interface ConsultaLogs {
  pagina?: number;
  porPagina?: number;
  busca?: string;
  tipoEntidade?: string;
}

@Injectable()
export class AuditoriaService {
  private readonly logger = new Logger(AuditoriaService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Grava um evento na trilha.
   *
   * Nunca lança: auditoria é observabilidade, e derrubar a criação de uma
   * campanha porque o log falhou seria trocar um problema pequeno por um
   * grande. A falha vai para o logger da aplicação.
   */
  async registrar(entrada: EntradaLog): Promise<void> {
    const { error } = await this.supabase.tabela("logs_auditoria").insert({
      usuario_id: entrada.usuarioId,
      usuario_nome: entrada.usuarioNome,
      acao: entrada.acao,
      tipo_entidade: entrada.tipoEntidade,
      entidade_id: entrada.entidadeId,
      entidade_rotulo: entrada.entidadeRotulo,
      ip: entrada.ip ?? null,
      detalhes: entrada.detalhes ?? {},
    });

    if (error) {
      this.logger.error(`Falha ao gravar auditoria (${entrada.acao}): ${error.message}`);
    }
  }

  async listar(q: ConsultaLogs = {}): Promise<Paginado<LogAuditoria>> {
    const pagina = Math.max(q.pagina ?? 1, 1);
    const porPagina = Math.min(Math.max(q.porPagina ?? 15, 5), 200);
    const de = (pagina - 1) * porPagina;

    let consulta = this.supabase
      .tabela("logs_auditoria")
      .select(COLUNAS_LOG, { count: "exact" })
      .order("ocorrido_em", { ascending: false })
      .range(de, de + porPagina - 1);

    if (q.tipoEntidade && q.tipoEntidade !== "todas") {
      consulta = consulta.eq("tipo_entidade", q.tipoEntidade);
    }
    if (q.busca) {
      // `or` do PostgREST: a busca cobre rótulo da entidade e nome do usuário.
      const alvo = q.busca.replace(/[,()]/g, " ");
      consulta = consulta.or(`entidade_rotulo.ilike.%${alvo}%,usuario_nome.ilike.%${alvo}%`);
    }

    const { data, error, count } = await consulta;
    if (error) throw new Error(`Falha ao listar logs: ${error.message}`);

    const total = count ?? 0;
    return {
      itens: (data as unknown as LinhaLog[]).map(paraLog),
      pagina,
      porPagina,
      total,
      totalPaginas: Math.max(Math.ceil(total / porPagina), 1),
    };
  }
}
