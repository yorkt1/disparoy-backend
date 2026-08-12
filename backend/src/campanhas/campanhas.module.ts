import { Module } from "@nestjs/common";
import { CanaisModule } from "../canais/canais.module";
import { CampanhasController } from "./campanhas.controller";
import { CampanhasService } from "./campanhas.service";

@Module({
  // Campanha valida acesso e conexão dos canais antes de enfileirar.
  imports: [CanaisModule],
  controllers: [CampanhasController],
  providers: [CampanhasService],
  exports: [CampanhasService],
})
export class CampanhasModule {}
