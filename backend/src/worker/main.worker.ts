import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { DisparoService } from "./disparo.service";
import {
  FILA_CAMPANHA,
  FILA_CONTATO,
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

  logger.log(
    `Worker ativo — filas "${FILA_CAMPANHA}" e "${FILA_CONTATO}" ` +
      `(concorrência ${disparo.concorrenciaPorCanal()}).`,
  );

  const encerrar = async (sinal: string) => {
    logger.log(`${sinal} recebido, encerrando o worker...`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void encerrar("SIGINT"));
  process.on("SIGTERM", () => void encerrar("SIGTERM"));
}

void iniciar();
