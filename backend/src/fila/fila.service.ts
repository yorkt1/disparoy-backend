import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import PgBoss from "pg-boss";
import { ambiente } from "../config/ambiente";

export const FILA_CAMPANHA = "disparo-campanha";
export const FILA_CONTATO = "disparo-contato";

export interface JobCampanha {
  campanhaId: string;
}

export interface JobContato {
  campanhaId: string;
  /** Id da linha em `campanha_contatos`, não do contato global. */
  contatoId: number;
  canalId: string;
}

/**
 * Texto legível para a falha de conexão.
 *
 * O driver do Postgres tenta cada endereço resolvido e agrupa as falhas num
 * `AggregateError`, cujo `.message` vem vazio — a causa real fica em `errors`.
 */
function descreverFalha(e: unknown): string {
  if (e instanceof AggregateError) {
    const causas = e.errors
      .map((sub) => (sub instanceof Error ? sub.message : String(sub)))
      .filter(Boolean);
    if (causas.length > 0) return [...new Set(causas)].join("; ");
  }
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

/**
 * Fila de jobs sobre o Postgres do Supabase (pg-boss).
 *
 * Por que uma fila e não `setTimeout` na API: com intervalo de 15–45 s entre
 * contatos, uma campanha de 3.000 pessoas leva ~25 horas. Isso precisa
 * sobreviver a deploy, restart e falha de rede — o estado mora no banco, não
 * na memória do processo.
 *
 * A conexão precisa ser DIRETA (porta 5432). O pooler do Supabase em modo
 * transaction não repassa LISTEN/NOTIFY nem mantém advisory locks entre
 * comandos, e o pg-boss depende dos dois.
 */
@Injectable()
export class FilaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilaService.name);
  private boss: PgBoss | null = null;
  /** Preenchido quando `FILA_OPCIONAL` deixou a API subir sem fila. */
  private motivoIndisponivel: string | null = null;

  async onModuleInit(): Promise<void> {
    const env = ambiente();
    const boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      // Schema próprio para os jobs não se misturarem às tabelas de negócio.
      schema: "fila",
      max: 5,
    });

    boss.on("error", (e) => this.logger.error(`pg-boss: ${e.message}`));

    try {
      await boss.start();
      await boss.createQueue(FILA_CAMPANHA);
      await boss.createQueue(FILA_CONTATO);
    } catch (e) {
      const motivo =
        `Não foi possível conectar a fila ao Postgres: ${descreverFalha(e)}\n\n` +
        `Confira DATABASE_URL em backend/.env. O pg-boss precisa de conexão de ` +
        `SESSÃO: serve a direta (5432) ou o Session pooler (5432), não o ` +
        `Transaction pooler (6543). Se o erro for ETIMEDOUT num endereço ` +
        `2600:..., é a direta do Supabase sendo IPv6-only — use o Session pooler.`;

      // Por padrão morre aqui: sem fila, campanha é criada e nunca enviada, e
      // "meio funcionando" esconde isso até alguém cobrar o disparo.
      if (!env.FILA_OPCIONAL) throw new Error(motivo);

      // Com FILA_OPCIONAL, o resto da API sobe para poder ser desenvolvido.
      // O aviso vai como `error` de propósito: precisa doer no log.
      this.motivoIndisponivel = motivo;
      this.logger.error(`FILA INDISPONÍVEL — nenhuma campanha vai sair.\n${motivo}`);
      await boss.stop({ graceful: false }).catch(() => undefined);
      return;
    }

    this.boss = boss;
    this.logger.log("Fila conectada.");
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }

  /** True quando a API subiu sem fila (só possível com `FILA_OPCIONAL`). */
  get indisponivel(): boolean {
    return this.boss === null;
  }

  private exigirBoss(): PgBoss {
    if (this.boss) return this.boss;
    throw new ServiceUnavailableException(
      `A fila de disparo está indisponível, então nada é enviado. ${this.motivoIndisponivel ?? ""}`,
    );
  }

  /**
   * Enfileira o início da campanha. Com `agendadaPara` no futuro, o pg-boss
   * segura o job até a hora — é assim que o agendamento da etapa 5 funciona.
   */
  async agendarCampanha(dados: JobCampanha, agendadaPara: string | null): Promise<string | null> {
    const atraso = agendadaPara
      ? Math.max(Math.floor((new Date(agendadaPara).getTime() - Date.now()) / 1000), 0)
      : 0;

    return this.exigirBoss().send(FILA_CAMPANHA, dados, {
      startAfter: atraso,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      // Uma campanha só pode ter um job de início ativo por vez; sem isto, dois
      // cliques em "Disparar" gerariam duas filas para os mesmos contatos.
      singletonKey: dados.campanhaId,
    });
  }

  /** Enfileira um contato, respeitando o intervalo sorteado antes dele. */
  async agendarContato(dados: JobContato, atrasoSegundos: number): Promise<string | null> {
    return this.exigirBoss().send(FILA_CONTATO, dados, {
      startAfter: Math.max(atrasoSegundos, 0),
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      // Teto de tempo em execução, não de espera na fila: `startAfter` já pode
      // ser de 25 h numa campanha grande e não conta aqui.
      //
      // 23 e não 24 porque o limite do pg-boss é exclusivo (`< 24`): com 24 o
      // `send` lança AssertionError, e o job de planejamento morre no meio do
      // laço — a campanha fica "em andamento" com todos os contatos pendentes
      // e nada é enviado.
      expireInHours: 23,
      // Idempotência: reenfileirar o mesmo contato da mesma campanha não cria
      // um segundo envio.
      singletonKey: `${dados.campanhaId}:${dados.contatoId}`,
    });
  }

  /**
   * Cancela os jobs pendentes de uma campanha (usado ao pausar).
   *
   * Sem fila não há job pendente para cancelar, então pausar continua valendo:
   * bloquear o pause por causa da fila deixaria a campanha presa em andamento.
   */
  async cancelarCampanha(campanhaId: string): Promise<void> {
    if (!this.boss) return;
    await this.boss.deleteJob(FILA_CAMPANHA, campanhaId).catch(() => undefined);
    this.logger.log(`Jobs pendentes da campanha ${campanhaId} cancelados.`);
  }

  /**
   * Acesso cru para o worker registrar os handlers.
   *
   * O worker ignora `FILA_OPCIONAL`: um worker sem fila não tem o que fazer,
   * e subir um processo que não consome nada é pior que não subir.
   */
  instancia(): PgBoss {
    if (!this.boss) {
      throw new Error(
        `O worker não sobe sem fila.\n${this.motivoIndisponivel ?? "Fila não inicializada."}`,
      );
    }
    return this.boss;
  }
}
