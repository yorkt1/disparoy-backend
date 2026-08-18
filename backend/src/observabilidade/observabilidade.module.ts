import { Global, Module } from "@nestjs/common";
import { ObservabilidadeService } from "./observabilidade.service";

/** Global: tanto a API (filtro de exceções) quanto o worker (crash) usam. */
@Global()
@Module({
  providers: [ObservabilidadeService],
  exports: [ObservabilidadeService],
})
export class ObservabilidadeModule {}
