import { Module } from "@nestjs/common";
import { UsuariosController } from "./usuarios.controller";
import { UsuariosService } from "./usuarios.service";
import { AdminInicialService } from "./admin-inicial.service";

@Module({
  controllers: [UsuariosController],
  providers: [UsuariosService, AdminInicialService],
  exports: [UsuariosService],
})
export class UsuariosModule {}
