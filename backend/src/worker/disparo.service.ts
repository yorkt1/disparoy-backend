import { Injectable, Logger } from "@nestjs/common";
import type { Canal, MensagemSequencia, Spintax } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { FilaService, type JobCampanha, type JobContato } from "../fila/fila.service";
import { COLUNAS_CANAL, paraCanal, type LinhaCanal } from "../comum/mapeadores";
import { ambiente } from "../config/ambiente";

const COLUNAS_EXECUCAO =
  "id, nome, status, sequencia, iniciada_em, validar_numeros, " +
  "intervalo_contatos_min, intervalo_contatos_max, intervalo_mensagens_min, intervalo_mensagens_max";

interface LinhaExecucao {
  id: string;
  nome: string;
  status: string;
  sequencia: unknown;
  iniciada_em: string | null;
  validar_numeros: boolean;
  intervalo_contatos_min: number;
  intervalo_contatos_max: number;
  intervalo_mensagens_min: number;
  intervalo_mensagens_max: number;
}

/** Só o que o worker precisa para executar — não a campanha inteira. */
interface CampanhaEmExecucao {
  id: string;
  nome: string;
  status: string;
  sequencia: MensagemSequencia[];
  iniciadaEm: string | null;
  validarNumeros: boolean;
  intervaloContatosMin: number;
  intervaloContatosMax: number;
  intervaloMensagensMin: number;
  intervaloMensagensMax: number;
}

interface DestinoDaFila {
  id: number;
  contatoId: string;
  telefone: string;
  variaveis: Record<string, string>;
}

/**
 * Execução da campanha.
 *
 * Dois jobs em vez de um laço longo:
 *  - `disparo-campanha` só planeja: pega os pendentes, distribui entre os
 *    canais em rodízio e enfileira um job por contato com o atraso sorteado.
 *  - `disparo-contato` envia a sequência de UM contato e termina.
 *
 * Assim o intervalo de 15–45 s vira `startAfter` no banco, não um processo
 * dormindo. Se o worker cair no meio de uma campanha de 25 horas, outro assume
 * os jobs sem perder nada.
 */
@Injectable()
export class DisparoService {
  private readonly logger = new Logger(DisparoService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly whatsapp: WhatsappService,
    private readonly fila: FilaService,
  ) {}

  // ------------------------------------------------------------------------
  // Job 1: planejar
  // ------------------------------------------------------------------------

  async planejarCampanha(job: JobCampanha): Promise<void> {
    const campanha = await this.carregarCampanha(job.campanhaId);
    if (!campanha) {
      this.logger.warn(`Campanha ${job.campanhaId} sumiu antes de iniciar.`);
      return;
    }
    if (campanha.status === "pausada" || campanha.status === "concluida") {
      this.logger.log(`Campanha "${campanha.nome}" está ${campanha.status}; nada a planejar.`);
      return;
    }

    const canais = await this.canaisConectadosDa(job.campanhaId);
    if (canais.length === 0) {
      await this.marcarFalha(job, "Nenhum canal conectado no momento do disparo.");
      return;
    }

    await this.supabase
      .tabela("campanhas")
      .update({
        status: "em_andamento",
        iniciada_em: campanha.iniciadaEm ?? new Date().toISOString(),
      })
      .eq("id", job.campanhaId);

    const pendentes = await this.contatosPendentes(job.campanhaId);
    if (pendentes.length === 0) {
      await this.finalizarSeTerminou(job.campanhaId);
      return;
    }

    // Rodízio entre os canais: reduz o volume por número, que é o que mais
    // pesa no risco de bloqueio.
    let atrasoAcumulado = 0;
    for (const [i, contato] of pendentes.entries()) {
      const canal = canais[i % canais.length];
      await this.fila.agendarContato(
        { campanhaId: job.campanhaId, contatoId: contato.id, canalId: canal.id },
        atrasoAcumulado,
      );
      atrasoAcumulado += this.sortearIntervalo(
        campanha.intervaloContatosMin,
        campanha.intervaloContatosMax,
      );
    }

    this.logger.log(
      `Campanha "${campanha.nome}": ${pendentes.length} contatos em ${canais.length} canais ` +
        `(último começa em ~${Math.round(atrasoAcumulado / 60)} min).`,
    );
  }

  // ------------------------------------------------------------------------
  // Job 2: enviar para um contato
  // ------------------------------------------------------------------------

  async dispararContato(job: JobContato): Promise<void> {
    const campanha = await this.carregarCampanha(job.campanhaId);
    // Pausar no meio precisa parar de verdade: os jobs já enfileirados só
    // descobrem isso aqui, então a checagem vem antes de qualquer envio.
    if (!campanha || campanha.status === "pausada") return;

    const [canal, destino] = await Promise.all([
      this.carregarCanal(job.canalId),
      this.carregarDestino(job.contatoId),
    ]);
    if (!canal || !destino) return;

    if (canal.status !== "conectado") {
      await this.encerrarContato(job, "falhou", "Canal desconectado no momento do envio.");
      return;
    }

    /**
     * Cota diária do canal, consumida no banco com lock.
     *
     * Estourar o teto de um número novo é o caminho mais rápido para bloqueio,
     * então o contato volta para `pendente` — a campanha continua amanhã em vez
     * de queimar o canal hoje.
     */
    const { data: temCota } = await this.supabase.db.rpc("consumir_cota_canal", {
      p_canal_id: canal.id,
      p_quantidade: campanha.sequencia.length,
    });
    if (temCota !== true) {
      this.logger.warn(`Canal ${canal.nome} atingiu o limite diário; contato adiado.`);
      return;
    }

    await this.supabase
      .tabela("campanha_contatos")
      .update({ status: "enviando", canal_id: canal.id })
      .eq("id", job.contatoId);

    if (campanha.validarNumeros) {
      const [checagem] = await this.whatsapp.validarNumeros(canal, [destino.telefone]);
      if (checagem?.verificado && !checagem.existeNoWhatsApp) {
        await this.encerrarContato(job, "invalido", "Número sem WhatsApp");
        return;
      }
    }

    const variacoes = await this.variacoes();
    let houveFalha = false;

    await this.whatsapp.dispararSequencia({
      canal,
      destinatario: { telefone: destino.telefone, variaveis: destino.variaveis },
      sequencia: campanha.sequencia,
      variacoes,
      aoTerminarPasso: async (passo) => {
        await this.gravarMensagem(job, canal.id, passo);
        if (!passo.resultado.ok) {
          houveFalha = true;
          return;
        }
        await this.esperar(
          this.sortearIntervalo(campanha.intervaloMensagensMin, campanha.intervaloMensagensMax) *
            1000,
        );
      },
    });

    await this.encerrarContato(job, houveFalha ? "falhou" : "concluido", null);
    await this.supabase.db.rpc("recalcular_metricas_campanha", { p_campanha_id: job.campanhaId });
  }

  // ------------------------------------------------------------------------
  // Apoio
  // ------------------------------------------------------------------------

  /** Intervalo aleatório: cadência fixa é assinatura de robô. */
  private sortearIntervalo(min: number, max: number): number {
    const piso = Math.min(min, max);
    const teto = Math.max(min, max);
    return Math.round(piso + Math.random() * (teto - piso));
  }

  private esperar(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async carregarCampanha(id: string): Promise<CampanhaEmExecucao | null> {
    const { data } = await this.supabase
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
      sequencia: Array.isArray(l.sequencia) ? (l.sequencia as MensagemSequencia[]) : [],
      iniciadaEm: l.iniciada_em,
      validarNumeros: l.validar_numeros,
      intervaloContatosMin: l.intervalo_contatos_min,
      intervaloContatosMax: l.intervalo_contatos_max,
      intervaloMensagensMin: l.intervalo_mensagens_min,
      intervaloMensagensMax: l.intervalo_mensagens_max,
    };
  }

  private async canaisConectadosDa(campanhaId: string): Promise<Canal[]> {
    const { data } = await this.supabase
      .tabela("campanha_canais")
      .select(`canais(${COLUNAS_CANAL})`)
      .eq("campanha_id", campanhaId);

    return ((data ?? []) as unknown as { canais: LinhaCanal | null }[])
      .map((l) => l.canais)
      .filter((c): c is LinhaCanal => c !== null && c.status === "conectado")
      .map(paraCanal);
  }

  private async carregarCanal(id: string): Promise<Canal | null> {
    const { data } = await this.supabase
      .tabela("canais")
      .select(COLUNAS_CANAL)
      .eq("id", id)
      .maybeSingle();
    return data ? paraCanal(data as unknown as LinhaCanal) : null;
  }

  private async carregarDestino(id: number): Promise<DestinoDaFila | null> {
    const { data } = await this.supabase
      .tabela("campanha_contatos")
      .select("id, contato_id, telefone, variaveis")
      .eq("id", id)
      .maybeSingle();

    if (!data) return null;
    const l = data as { id: number; contato_id: string; telefone: string; variaveis: unknown };
    const variaveis =
      l.variaveis && typeof l.variaveis === "object" && !Array.isArray(l.variaveis)
        ? Object.fromEntries(
            Object.entries(l.variaveis as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v ?? ""),
            ]),
          )
        : {};

    return { id: l.id, contatoId: l.contato_id, telefone: l.telefone, variaveis };
  }

  private async contatosPendentes(campanhaId: string): Promise<{ id: number }[]> {
    const { data } = await this.supabase
      .tabela("campanha_contatos")
      .select("id")
      .eq("campanha_id", campanhaId)
      .eq("status", "pendente")
      .order("id");
    return (data ?? []) as { id: number }[];
  }

  private async variacoes(): Promise<Spintax[]> {
    const { data } = await this.supabase.tabela("spintax").select("id, nome, opcoes, criado_em");
    return ((data ?? []) as { id: string; nome: string; opcoes: unknown; criado_em: string }[]).map(
      (l) => ({
        id: l.id,
        nome: l.nome,
        opcoes: Array.isArray(l.opcoes) ? l.opcoes.map(String) : [],
        criadoEm: l.criado_em,
      }),
    );
  }

  private async gravarMensagem(
    job: JobContato,
    canalId: string,
    passo: {
      passo: number;
      corpoRenderizado: string;
      resultado: { ok: boolean; idExterno?: string; erro?: string };
    },
  ): Promise<void> {
    await this.supabase.tabela("mensagens_enviadas").insert({
      campanha_id: job.campanhaId,
      campanha_contato_id: job.contatoId,
      canal_id: canalId,
      passo: passo.passo,
      corpo_renderizado: passo.corpoRenderizado,
      id_externo: passo.resultado.ok ? (passo.resultado.idExterno ?? null) : null,
      status: passo.resultado.ok ? "enviada" : "falhou",
      erro: passo.resultado.ok ? null : (passo.resultado.erro ?? "Falha desconhecida"),
    });
  }

  private async encerrarContato(
    job: JobContato,
    status: "concluido" | "falhou" | "invalido",
    motivo: string | null,
  ): Promise<void> {
    await this.supabase
      .tabela("campanha_contatos")
      .update({ status, motivo, processado_em: new Date().toISOString() })
      .eq("id", job.contatoId);
    await this.finalizarSeTerminou(job.campanhaId);
  }

  private async marcarFalha(job: JobCampanha, motivo: string): Promise<void> {
    await this.supabase.tabela("campanhas").update({ status: "falhou" }).eq("id", job.campanhaId);
    this.logger.error(`Campanha ${job.campanhaId} falhou: ${motivo}`);

    const campanha = await this.carregarCampanha(job.campanhaId);
    await this.auditoria.registrar({
      usuarioId: null,
      usuarioNome: "Sistema",
      acao: "campanha.pausada",
      tipoEntidade: "campanha",
      entidadeId: job.campanhaId,
      entidadeRotulo: campanha?.nome ?? job.campanhaId,
      detalhes: { motivo },
    });
  }

  /** Fecha a campanha quando não sobra contato pendente. */
  private async finalizarSeTerminou(campanhaId: string): Promise<void> {
    const { data } = await this.supabase.db.rpc("concluir_campanha_se_terminou", {
      p_campanha_id: campanhaId,
    });
    if (data !== true) return;

    const campanha = await this.carregarCampanha(campanhaId);
    await this.auditoria.registrar({
      usuarioId: null,
      usuarioNome: "Sistema",
      acao: "campanha.concluida",
      tipoEntidade: "campanha",
      entidadeId: campanhaId,
      entidadeRotulo: campanha?.nome ?? campanhaId,
    });
    this.logger.log(`Campanha ${campanha?.nome ?? campanhaId} concluída.`);
  }

  concorrenciaPorCanal(): number {
    return ambiente().DISPARO_CONCORRENCIA_POR_CANAL;
  }
}
