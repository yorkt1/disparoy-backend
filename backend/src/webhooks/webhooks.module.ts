import { Module } from "@nestjs/common";
import { ContatosModule } from "../contatos/contatos.module";
import { EvolutionController } from "./evolution.controller";
import { EvolutionService } from "./evolution.service";

@Module({
  imports: [ContatosModule],
  controllers: [EvolutionController],
  providers: [EvolutionService],
})
export class WebhooksModule {}
