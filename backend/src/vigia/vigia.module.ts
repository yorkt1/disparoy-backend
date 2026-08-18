import { Module } from "@nestjs/common";
import { VigiaWorkerService } from "./vigia-worker.service";

/**
 * Só na API — nunca no worker.
 *
 * `VigiaWorkerService` existe para detectar o worker morto DE FORA dele.
 * Importar este módulo em `WorkerModule` derrotaria o propósito: o processo
 * que devia estar sendo vigiado passaria a vigiar a si mesmo, e o cenário que
 * mais importa pegar — o worker travado ou caído — é exatamente aquele em que
 * ele não teria como rodar a própria checagem.
 */
@Module({
  providers: [VigiaWorkerService],
})
export class VigiaModule {}
