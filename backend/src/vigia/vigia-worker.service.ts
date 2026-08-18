import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FilaService } from "../fila/fila.service";
import { SupabaseService } from "../supabase/supabase.service";

/** Fila própria — não reaproveita `manutencao`, que roda DENTRO do worker. */
const FILA_VIGIA_WORKER = "vigia-worker";

/**
 * Categoria e código do incidente aberto quando o worker some.
 *
 * Fora da união fechada `CodigoFalha` de propósito: aquele tipo classifica
 * falha de ENVIO de mensagem, para o compilador recusar caminho não coberto
 * (ver `shared/src/whatsapp/falhas.ts`). Isto aqui é saúde de PROCESSO, uma
 * categoria diferente — `incidentes.codigo` é `text`, não o enum, e não
 * precisa ser.
 */
const CATEGORIA = "infra" as const;
const CODIGO = "worker_parado";

/**
 * Quantos minutos sem pulso viram incidente.
 *
 * O worker bate o pulso a cada rodada de manutenção, de minuto em minuto
 * (`fila.agendarManutencao`). Um teto de 1 min reagiria ao primeiro atraso
 * — deploy, GC, uma vigilância de canais mais lenta que o normal — e abriria
 * incidente para nada. Três perdas seguidas é o mesmo critério que o resto do
 * sistema já usa para separar "atrasou" de "morreu" (ver `ROBUSTEZ.md`).
 */
const TETO_MINUTOS_SEM_PULSO = 3;

interface LinhaPulso {
  batida_em: string;
}

/**
 * Detecta o worker morto — DE FORA do worker.
 *
 * Só pode rodar na API. Um worker checando o próprio pulso é um cadáver
 * tentando descobrir que morreu: se o processo travou ou caiu, o código que
 * verificaria isso morreu junto. A API é o outro processo sempre no ar — é
 * o único lugar onde "o worker não bate há N minutos" pode de fato ser
 * observado.
 *
 * Cron do próprio pg-boss, e não `setInterval`: com duas réplicas de API no
 * futuro, `setInterval` rodaria a verificação em cada uma, e cada uma abriria
 * o próprio incidente na mesma corrida que `abrir_incidente` já resolve para
 * o resto do sistema — mas por que arriscar quando o cron já entrega o job a
 * uma réplica só?
 */
@Injectable()
export class VigiaWorkerService implements OnModuleInit {
  private readonly logger = new Logger(VigiaWorkerService.name);

  constructor(
    private readonly fila: FilaService,
    private readonly supabase: SupabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    const boss = this.fila.bossOpcional;
    // `FILA_OPCIONAL` deixou a API subir sem fila — sem fila também não há
    // campanha rodando, então não há worker para vigiar.
    if (!boss) return;

    await boss.createQueue(FILA_VIGIA_WORKER);
    await boss.schedule(FILA_VIGIA_WORKER, "* * * * *", {}, { retryLimit: 0 });
    await boss.work(FILA_VIGIA_WORKER, { batchSize: 1 }, async () => {
      await this.verificar();
    });

    this.logger.log("Vigia do pulso do worker ativo.");
  }

  private async verificar(): Promise<void> {
    const { data, error } = await this.supabase
      .tabela("worker_pulso")
      .select("batida_em")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      this.logger.error(`Não foi possível ler o pulso do worker: ${error.message}`);
      return;
    }
    if (!data) {
      // Linha nasce com a migration (`insert ... on conflict do nothing`) — só
      // falta se o banco foi restaurado de um ponto anterior a ela.
      this.logger.warn("Tabela worker_pulso sem linha — nada para vigiar ainda.");
      return;
    }

    const minutos =
      (Date.now() - new Date((data as LinhaPulso).batida_em).getTime()) / 60_000;

    if (minutos > TETO_MINUTOS_SEM_PULSO) {
      await this.abrir(minutos);
    } else {
      await this.resolver();
    }
  }

  private async abrir(minutosSemPulso: number): Promise<void> {
    const { error } = await this.supabase.db.rpc("abrir_incidente", {
      p_categoria: CATEGORIA,
      p_codigo: CODIGO,
      p_titulo: "O worker de disparo parou de responder",
      p_canal_id: null,
      p_campanha_id: null,
      p_detalhe:
        `Sem pulso há ${Math.round(minutosSemPulso)} min. Nenhuma campanha está avançando ` +
        `enquanto isto durar — não é falha de canal nem de destinatário.`,
    });
    // Não relança: o vigia é observabilidade. Se o próprio registro do
    // incidente falhar, o log de erro já é o sinal que sobra.
    if (error) this.logger.error(`Falha ao abrir incidente de worker parado: ${error.message}`);
  }

  private async resolver(): Promise<void> {
    const { error } = await this.supabase.db.rpc("resolver_incidente", {
      p_categoria: CATEGORIA,
      p_codigo: CODIGO,
      p_canal_id: null,
    });
    if (error) this.logger.error(`Falha ao resolver incidente de worker parado: ${error.message}`);
  }
}
