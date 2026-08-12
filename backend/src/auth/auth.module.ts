import { Module } from "@nestjs/common";
import { SessaoController } from "./sessao.controller";
import { SessaoService } from "./sessao.service";

/** Login próprio: e-mail e senha conferidos contra `perfis`. */
@Module({
  controllers: [SessaoController],
  providers: [SessaoService],
  exports: [SessaoService],
})
export class AuthModule {}
