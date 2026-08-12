import { Module } from "@nestjs/common";
import { CanaisController } from "./canais.controller";
import { CanaisService } from "./canais.service";

@Module({
  controllers: [CanaisController],
  providers: [CanaisService],
  exports: [CanaisService],
})
export class CanaisModule {}
