import { Global, Module } from "@nestjs/common";
import { FilaService } from "./fila.service";

@Global()
@Module({
  providers: [FilaService],
  exports: [FilaService],
})
export class FilaModule {}
