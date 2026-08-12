import { Module } from "@nestjs/common";
import { SpintaxController } from "./spintax.controller";
import { SpintaxService } from "./spintax.service";

@Module({
  controllers: [SpintaxController],
  providers: [SpintaxService],
  exports: [SpintaxService],
})
export class SpintaxModule {}
