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
/** Jobs que esgotaram as tentativas. Não são reprocessados: são evidência. */
export const FILA_MORTOS = "disparo-mortos";
/** Reconciliação, métricas e retenção dos avisos/eventos. Cron de 1 min. */
export const FILA_MANUTENCAO = "manutencao";
/**
 * Expurgo de `mensagens_enviadas`. Cron PRÓPRIO, diário, e não dentro de
 * `FILA_MANUTENCAO`: aquela roda de minuto em minuto, e um DELETE com JOIN
 * sobre a tabela que mais cresce no sistema não pode rodar 1.440 vezes por
 * dia só para achar zero linha na esmagadora maioria delas.
 */
export const FILA_RETENCAO = "retencao";

export interface JobCampanha {
  campanhaId: string;
  /**
   * Geração da execução. Job de rodada vencida é descartado ao acordar —
   * é assim que pausar invalida o que já estava na fila.
   */
  rodada?: number;
}

export interface JobContato {
  campanhaId: string;
  /** Id da linha em `campanha_contatos`, não do contato global. */
  contatoId: number;
  canalId: string;
  rodada?: number;
}

/** Um contato pronto para virar job, com o atraso já sorteado. */
export interface ContatoAgendado {
  dados: JobContato;
  atrasoSegundos: number;
}

/**
 * Quantos jobs vão num único INSERT.
 *
 * O laço antigo fazia um `send()` por contato: 5.000 contatos eram 5.000 idas
 * e voltas ao Postgres, e o job de planejamento levava minutos segurando a
 * fila. Se o worker reiniciasse no meio, metade da campanha ficava sem job.
 *
 * 500 mantém o INSERT abaixo do limite de parâmetros do driver com folga.
 */
const TAMANHO_LOTE = 500;

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
      await boss.createQueue(FILA_MORTOS);
      await boss.createQueue(FILA_CAMPANHA, { name: FILA_CAMPANHA, deadLetter: FILA_MORTOS });
      // Sem dead letter, um job que esgota as tentativas some do sistema: o
      // contato fica pendente para sempre e ninguém descobre por quê. Aqui ele
      // ao menos fica guardado, com o payload que falhou.
      await boss.createQueue(FILA_CONTATO, { name: FILA_CONTATO, deadLetter: FILA_MORTOS });
      await boss.createQueue(FILA_MANUTENCAO);
      await boss.createQueue(FILA_RETENCAO);
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
    // Timeout explícito: o Render manda SIGKILL 30 s depois do SIGTERM, e um
    // `stop` sem teto ficaria esperando o job de 25 h que nunca vai terminar.
    // Perder o encerramento limpo é aceitável — o reaper recupera o contato.
    await this.boss?.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
  }

  /** True quando a API subiu sem fila (só possível com `FILA_OPCIONAL`). */
  get indisponivel(): boolean {
    return this.boss === null;
  }

  /**
   * Acesso cru que NÃO lança quando a fila está indisponível.
   *
   * `instancia()` continua lançando de propósito: quem depende de verdade da
   * fila — o worker, o envio de campanha — precisa saber na hora que não tem
   * como funcionar. Isto aqui é para consumidor OPCIONAL do lado da API, como
   * o vigia do pulso do worker: sem fila configurada, ele simplesmente não
   * tem o que vigiar, e a API já subiu sem fila de propósito via
   * `FILA_OPCIONAL` — travar o boot por causa de um vigia secundário
   * contradiria essa decisão.
   */
  get bossOpcional(): PgBoss | null {
    return this.boss;
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
      // Evita dois planejamentos simultâneos para a mesma campanha. Não é a
      // garantia principal contra envio duplicado — essa é `enfileirado_em`,
      // no banco: a chave do pg-boss é liberada assim que o job completa.
      singletonKey: `${dados.campanhaId}:${dados.rodada ?? 0}`,
    });
  }

  /**
   * Enfileira contatos em lote, cada um com seu próprio atraso.
   *
   * Um INSERT por lote em vez de um round-trip por contato. Numa campanha de
   * 5.000 pessoas isso é a diferença entre o planejamento levar segundos e
   * levar minutos — e minutos aqui significam janela para o worker reiniciar
   * no meio, deixando parte da campanha sem job nenhum.
   */
  async agendarContatosEmLote(contatos: ContatoAgendado[]): Promise<void> {
    if (contatos.length === 0) return;
    const boss = this.exigirBoss();
    const agora = Date.now();

    const jobs: PgBoss.JobInsert<JobContato>[] = contatos.map((c) => ({
      name: FILA_CONTATO,
      data: c.dados,
      // `insert` quer instante absoluto; `send` aceitava deslocamento em
      // segundos. Trocar sem converter agendaria tudo para agora.
      startAfter: new Date(agora + Math.max(c.atrasoSegundos, 0) * 1000),
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      // Teto de tempo em EXECUÇÃO, não de espera na fila: `startAfter` já pode
      // ser de 25 h numa campanha grande e não conta aqui.
      expireInSeconds: 23 * 3600,
      // Idempotência de enfileiramento, dentro da rodada. A trava real contra
      // envio duplicado é `enfileirado_em`; esta só evita lixo na fila.
      singletonKey: `${c.dados.campanhaId}:${c.dados.rodada ?? 0}:${c.dados.contatoId}`,
    }));

    for (let i = 0; i < jobs.length; i += TAMANHO_LOTE) {
      await boss.insert(jobs.slice(i, i + TAMANHO_LOTE));
    }
  }

  /**
   * Rotinas periódicas: reconciliar travados, agregar métricas, limpar
   * payloads antigos.
   *
   * Cron do próprio pg-boss, e não `setInterval` no processo: com duas
   * instâncias de worker, `setInterval` rodaria a manutenção duas vezes em
   * paralelo, e a reconciliação disputaria as mesmas linhas. O cron entrega o
   * job a um worker só.
   */
  async agendarManutencao(): Promise<void> {
    await this.exigirBoss().schedule(FILA_MANUTENCAO, "* * * * *", {}, { retryLimit: 0 });
  }

  /** Uma vez por dia, de madrugada — ver o comentário de `FILA_RETENCAO`. */
  async agendarRetencao(): Promise<void> {
    await this.exigirBoss().schedule(FILA_RETENCAO, "17 3 * * *", {}, { retryLimit: 0 });
  }

  /**
   * Marca a campanha para replanejamento imediato.
   *
   * Usado pela manutenção quando a reconciliação devolveu contatos à fila:
   * sem isto eles voltariam a `pendente` e ficariam lá, porque quem enfileira
   * é o job de planejamento.
   */
  async replanejar(campanhaId: string, rodada: number): Promise<void> {
    await this.exigirBoss().send(
      FILA_CAMPANHA,
      { campanhaId, rodada } satisfies JobCampanha,
      { retryLimit: 3, retryDelay: 30, singletonKey: `replan:${campanhaId}:${rodada}` },
    );
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
