import { Injectable, Logger } from "@nestjs/common";
import type { AcaoLog, LogAuditoria, Paginado, TipoEntidade } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { COLUNAS_LOG, paraLog, type LinhaLog } from "../comum/mapeadores";
import { noEscopo } from "../comum/escopo";
import type { UsuarioAutenticado } from "../auth/auth.guard";

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
  /**
   * Dono do log — quando omitido, é derivado de `perfis.empresa_id` a partir
   * de `usuarioId`.
   *
   * A maioria dos 22 pontos que chamam `registrar` já tem `usuario` (ou
   * `autor`) em escopo, mas pedir que cada um se lembre de repassar
   * `empresaId` é exatamente o tipo de regra que diverge — um call site
   * esquece e o log daquela ação fica sem dono, órfão do filtro. Derivar aqui,
   * num lugar só, é a mesma lógica de `noEscopo`/`empresaParaEscrita`
   * em `comum/escopo.ts`.
   *
   * Passar explicitamente é para quem NÃO tem um perfil para consultar: o
   * worker (`usuarioId: null`) registrando evento de uma campanha — nesse
   * caso a empresa vem da campanha, não de um autor humano.
   */
  empresaId?: string | null;
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
    const empresaId =
      entrada.empresaId !== undefined
        ? entrada.empresaId
        : await this.empresaDoAutor(entrada.usuarioId);

    const { error } = await this.supabase.tabela("logs_auditoria").insert({
      usuario_id: entrada.usuarioId,
      usuario_nome: entrada.usuarioNome,
      acao: entrada.acao,
      tipo_entidade: entrada.tipoEntidade,
      entidade_id: entrada.entidadeId,
      entidade_rotulo: entrada.entidadeRotulo,
      ip: entrada.ip ?? null,
      detalhes: entrada.detalhes ?? {},
      empresa_id: empresaId,
    });

    if (error) {
      this.logger.error(`Falha ao gravar auditoria (${entrada.acao}): ${error.message}`);
    }
  }

  /**
   * `perfis.empresa_id` de quem praticou a ação — `null` sem autor humano ou
   * autor global. Uma consulta a mais por escrita de log, aceitável: auditoria
   * é caminho de escrita raro (ação de admin), não o laço quente do disparo.
   */
  private async empresaDoAutor(usuarioId: string | null): Promise<string | null> {
    if (!usuarioId) return null;
    const { data } = await this.supabase
      .tabela("perfis")
      .select("empresa_id")
      .eq("id", usuarioId)
      .maybeSingle();
    return (data as { empresa_id: string | null } | null)?.empresa_id ?? null;
  }

  /**
   * `usuario` decide o que a consulta enxerga — nunca um filtro vindo do
   * cliente. Mesmo padrão de `noEscopo` em todo serviço que lê dado de
   * empresa: a conta global (`empresaId === null`) atravessa tudo de
   * propósito, é o acesso de suporte; qualquer outro admin só vê a própria.
   */
  async listar(usuario: UsuarioAutenticado, q: ConsultaLogs = {}): Promise<Paginado<LogAuditoria>> {
    const pagina = Math.max(q.pagina ?? 1, 1);
    const porPagina = Math.min(Math.max(q.porPagina ?? 15, 5), 200);
    const de = (pagina - 1) * porPagina;

    let consulta = noEscopo(
      this.supabase
        .tabela("logs_auditoria")
        .select(COLUNAS_LOG, { count: "exact" })
        .order("ocorrido_em", { ascending: false })
        .range(de, de + porPagina - 1),
      usuario,
    );

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
