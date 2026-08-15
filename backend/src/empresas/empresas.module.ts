import { Module } from "@nestjs/common";
import { SupabaseModule } from "../supabase/supabase.module";
import { AuditoriaModule } from "../auditoria/auditoria.module";
import { EmpresasController } from "./empresas.controller";
import { EmpresasService } from "./empresas.service";

@Module({
  imports: [SupabaseModule, AuditoriaModule],
  controllers: [EmpresasController],
  providers: [EmpresasService],
})
export class EmpresasModule {}
