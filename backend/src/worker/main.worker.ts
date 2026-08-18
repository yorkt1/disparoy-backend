import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { DisparoService } from "./disparo.service";
import { ObservabilidadeService } from "../observabilidade/observabilidade.service";
import {
  FILA_CAMPANHA,
  FILA_CONTATO,
  FILA_MANUTENCAO,
  FILA_MORTOS,
  FILA_RETENCAO,
  FilaService,
  type JobCampanha,
  type JobContato,
} from "../fila/fila.service";

/**
 * Processo separado da API.
 *
 * Roda com `npm run dev:worker` (ou `start:worker` em produção) e pode ser
 * escalado sozinho: subir mais instâncias aumenta a vazão sem tocar na API,
 * porque o pg-boss distribui os jobs por advisory lock no Postgres.
 */
async function iniciar() {
  const logger = new Logger("Worker");
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["log", "warn", "error"],
  });
  app.enableShutdownHooks();

  const fila = app.get(FilaService);
  const disparo = app.get(DisparoService);
  const observabilidade = app.get(ObservabilidadeService);
  const boss = fila.instancia();

  // Planejamento: um de cada vez, porque é rápido e só enfileira.
  await boss.work<JobCampanha>(FILA_CAMPANHA, { batchSize: 1 }, async ([job]) => {
    logger.log(`Planejando campanha ${job.data.campanhaId}`);
    await disparo.planejarCampanha(job.data);
  });

  // Envio: a concorrência é o que controla a pressão sobre os números.
  await boss.work<JobContato>(
    FILA_CONTATO,
    { batchSize: disparo.concorrenciaPorCanal() },
    async (jobs) => {
      for (const job of jobs) {
        await disparo.dispararContato(job.data);
      }
    },
  );

  /**
   * Manutenção: reconcilia travados, agrega métricas, aplica retenção.
   *
   * É a rede que segura tudo o que este processo pode largar pelo caminho —
   * deploy do Render, OOM, queda da VPS da Evolution. Sem ela, contato que
   * ficou em "enviando" nunca mais sai de lá e a campanha não conclui.
   */
  await boss.work(FILA_MANUTENCAO, { batchSize: 1 }, async () => {
    await disparo.manutencao();
  });
  await fila.agendarManutencao();

  /**
   * Expurgo de `mensagens_enviadas`, uma vez por dia — fila própria, e não
   * dentro de `FILA_MANUTENCAO`. Ver o comentário de `FILA_RETENCAO` em
   * `fila.service.ts` para o motivo de não rodar a cada minuto.
   */
  await boss.work(FILA_RETENCAO, { batchSize: 1 }, async () => {
    await disparo.purgarMensagensAntigas();
  });
  await fila.agendarRetencao();

  /**
   * Dead letter: jobs que esgotaram as tentativas.
   *
   * `createQueue` já apontava as duas filas para cá desde o começo, mas nada
   * consumia — os jobs se acumulavam no schema `fila` sem que ninguém soubesse
   * que tinham morrido. Cada um vira um incidente visível no painel.
   */
  await boss.work(FILA_MORTOS, { batchSize: 10 }, async (jobs) => {
    for (const job of jobs) await disparo.registrarJobMorto(job.data);
  });

  logger.log(
    `Worker ativo — filas "${FILA_CAMPANHA}", "${FILA_CONTATO}", "${FILA_MANUTENCAO}" e ` +
      `"${FILA_RETENCAO}" (concorrência ${disparo.concorrenciaPorCanal()}).`,
  );

  /**
   * Encerramento com teto de tempo.
   *
   * O Render manda SIGTERM e mata em 30 s. Um `app.close()` sem limite pode
   * ficar esperando um envio em andamento e levar SIGKILL no meio da escrita —
   * pior que sair sozinho. Saindo por conta própria, o contato em voo fica em
   * "enviando" e o reaper o devolve à fila em até 15 minutos.
   */
  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    logger.log(`${sinal} recebido, encerrando o worker...`);

    const prazo = setTimeout(() => {
      logger.warn("Encerramento passou de 20 s; saindo à força.");
      process.exit(1);
    }, 20_000);
    prazo.unref();

    await app.close().catch((e: unknown) => logger.error(`Falha ao encerrar: ${String(e)}`));
    clearTimeout(prazo);
    process.exit(0);
  };
  process.on("SIGINT", () => void encerrar("SIGINT"));
  process.on("SIGTERM", () => void encerrar("SIGTERM"));

  /**
   * Um erro não tratado deixa o processo num estado que ninguém modelou.
   *
   * Sair é mais seguro que seguir: o Render reinicia o worker, os jobs em voo
   * voltam para a fila e o reaper cuida do resto. Ficar de pé "meio quebrado"
   * é o cenário em que a campanha para sem ninguém perceber.
   */
  /*
   * O alerta aqui é MELHOR-ESFORÇO, não a defesa principal.
   *
   * Quem detecta de verdade o worker morto é o vigia do pulso, rodando na API
   * (`VigiaWorkerService`) — de FORA deste processo, porque um processo que
   * travou ou levou SIGKILL não tem como avisar coisa nenhuma. O que sai
   * daqui só ajuda no caso feliz: uma exceção JS que ainda dá tempo de um
   * `fetch` sair antes do `process.exit`. Não substitui o vigia, complementa:
   * quando funciona, chega minutos antes e já vem com o motivo.
   */
  process.on("unhandledRejection", (motivo) => {
    logger.error(`Promessa rejeitada sem tratamento: ${String(motivo)}`);
    observabilidade.relatarErro("Worker — promessa rejeitada sem tratamento", motivo);
    void encerrar("unhandledRejection");
  });
  process.on("uncaughtException", (erro) => {
    logger.error(`Exceção não capturada: ${erro.stack ?? erro.message}`);
    observabilidade.relatarErro("Worker — exceção não capturada", erro);
    void encerrar("uncaughtException");
  });
}

void iniciar();
