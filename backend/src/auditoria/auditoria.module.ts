import { Global, Module } from "@nestjs/common";
import { AuditoriaService } from "./auditoria.service";
import { LogsController } from "./logs.controller";

/** Global porque todo módulo de escrita registra eventos. */
@Global()
@Module({
  controllers: [LogsController],
  providers: [AuditoriaService],
  exports: [AuditoriaService],
})
export class AuditoriaModule {}
