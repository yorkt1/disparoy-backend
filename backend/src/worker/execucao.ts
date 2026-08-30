import type { Logger } from "@nestjs/common";
import type { CodigoFalha, MensagemSequencia } from "@disparoy/dominio";
import { categoriaDe, explicar } from "@disparoy/dominio";
import type { SupabaseService } from "../supabase/supabase.service";
import type { AuditoriaService } from "../auditoria/auditoria.service";
import { ambiente } from "../config/ambiente";

/**
 * O que disparo e manutenção compartilham.
 *
 * As duas rotinas do worker leem a mesma campanha e abrem os mesmos
 * incidentes, mas têm ciclos de vida diferentes: uma responde a job de fila, a
 * outra a um cron de um minuto. Deixá-las na mesma classe fazia com que mexer
 * na manutenção exigisse reler o caminho de envio, que é o mais crítico do
 * sistema.
 *
 * Aqui ficam só as peças que os dois lados usam de verdade — funções livres,
 * recebendo o que precisam. Sem estado próprio: quem tem estado é o serviço.
 */

export const COLUNAS_EXECUCAO =
  "id, nome, status, rodada, sequencia, iniciada_em, validar_numeros, empresa_id, " +
  "intervalo_contatos_min, intervalo_contatos_max, intervalo_mensagens_min, intervalo_mensagens_max";

/** Uma campanha que perdeu a hora, como as RPCs de expiração a devolvem. */
export interface AgendamentoExpirado {
  campanha_id: string;
  empresa_id: string | null;
  nome: string;
  atraso_segundos: number;
  /** Texto de operador, montado no banco — ver `motivo_agendamento_expirado`. */
  motivo: string;
}

export interface LinhaExecucao {
  id: string;
  nome: string;
  status: string;
  rodada: number | null;
  sequencia: unknown;
  iniciada_em: string | null;
  validar_numeros: boolean;
  // Não é opcional no banco (`empresa_obrigatoria`), mas a coluna é lida como
  // string | null aqui porque um SELECT montado em runtime não carrega o
  // "not null" do schema — só o dado que veio.
  empresa_id: string | null;
  intervalo_contatos_min: number;
  intervalo_contatos_max: number;
  intervalo_mensagens_min: number;
  intervalo_mensagens_max: number;
}

/** Só o que o worker precisa para executar — não a campanha inteira. */
export interface CampanhaEmExecucao {
  id: string;
  nome: string;
  status: string;
  rodada: number;
  sequencia: MensagemSequencia[];
  iniciadaEm: string | null;
  validarNumeros: boolean;
  /**
   * Dona da campanha — carregada só para marcar a auditoria dos eventos que o
   * PRÓPRIO worker gera (`campanha.pausada` por reconciliação, `campanha.
   * concluida`). Sem isto, `AuditoriaService.registrar` não tem como derivar a
   * empresa: não há `usuarioId` num evento de sistema, é `null` de propósito.
   */
  empresaId: string | null;
  intervaloContatosMin: number;
  intervaloContatosMax: number;
  intervaloMensagensMin: number;
  intervaloMensagensMax: number;
}


/** Só o que o worker precisa para executar — não a campanha inteira. */
export async function carregarCampanha(
  supabase: SupabaseService,
  id: string,
): Promise<CampanhaEmExecucao | null> {
  const { data } = await supabase
    .tabela("campanhas")
    .select(COLUNAS_EXECUCAO)
    .eq("id", id)
    .maybeSingle();

  if (!data) return null;
  // O supabase-js não infere tipo de um SELECT montado em runtime.
  const l = data as unknown as LinhaExecucao;

  return {
    id: l.id,
    nome: l.nome,
    status: l.status,
    rodada: l.rodada ?? 0,
    sequencia: Array.isArray(l.sequencia) ? (l.sequencia as MensagemSequencia[]) : [],
    iniciadaEm: l.iniciada_em,
    validarNumeros: l.validar_numeros,
    empresaId: l.empresa_id,
    intervaloContatosMin: l.intervalo_contatos_min,
    intervaloContatosMax: l.intervalo_contatos_max,
    intervaloMensagensMin: l.intervalo_mensagens_min,
    intervaloMensagensMax: l.intervalo_mensagens_max,
  };
}

export async function registrarIncidente(
  supabase: SupabaseService,
  logger: Logger,
  codigo: CodigoFalha,
  ctx: { canalId?: string; canalNome?: string; campanhaId?: string; detalhe?: string },
): Promise<void> {
  const { error } = await supabase.db.rpc("abrir_incidente", {
    p_categoria: categoriaDe(codigo),
    p_codigo: codigo,
    p_titulo: explicar(codigo, { canal: ctx.canalNome, detalhe: ctx.detalhe }),
    p_canal_id: ctx.canalId ?? null,
    p_campanha_id: ctx.campanhaId ?? null,
    p_detalhe: ctx.detalhe ?? null,
  });
  // Não relança: incidente é observabilidade. Derrubar um disparo porque o
  // registro do aviso falhou seria trocar um problema por um pior.
  if (error) logger.error(`Falha ao registrar incidente ${codigo}: ${error.message}`);
}

export async function registrarAgendamentoExpirado(
  supabase: SupabaseService,
  auditoria: AuditoriaService,
  logger: Logger,
  campanha: { id: string; nome: string; empresaId: string | null },
  expirada: { atraso_segundos: number; motivo: string },
): Promise<void> {
  // O texto vem do banco, não daqui: é o mesmo que está gravado em
  // `pausada_motivo` e que o operador lê na tela. Formatá-lo de novo em
  // TypeScript faria log e tela contarem versões diferentes do mesmo evento.
  logger.error(
    `Campanha "${campanha.nome}" (${campanha.id}) marcada como falhou. ${expirada.motivo}`,
  );

  const { error } = await supabase.db.rpc("abrir_incidente", {
    p_categoria: "infra",
    p_codigo: "agendamento_expirado",
    p_titulo: "Campanha agendada não saiu no horário",
    p_canal_id: null,
    p_campanha_id: campanha.id,
    p_detalhe: `"${campanha.nome}": ${expirada.motivo}`,
  });
  if (error) {
    logger.error(`Falha ao registrar incidente de agendamento expirado: ${error.message}`);
  }

  await auditoria.registrar({
    usuarioId: null,
    usuarioNome: "Sistema",
    acao: "campanha.agendamento_expirado",
    tipoEntidade: "campanha",
    entidadeId: campanha.id,
    entidadeRotulo: campanha.nome,
    // Explícito: não há usuário para consultar em `perfis` num evento de
    // sistema, e sem isto o log ficaria sem dono — invisível para o admin da
    // empresa, visível só para a conta global. Ver `marcarFalha`.
    empresaId: campanha.empresaId,
    detalhes: {
      atrasoSegundos: expirada.atraso_segundos,
      toleranciaMinutos: ambiente().AGENDAMENTO_TOLERANCIA_MINUTOS,
    },
  });
}
