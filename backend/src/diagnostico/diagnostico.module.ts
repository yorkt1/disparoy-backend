import { Module } from "@nestjs/common";
import { SupabaseModule } from "../supabase/supabase.module";
import { DiagnosticoController } from "./diagnostico.controller";
import { DiagnosticoService } from "./diagnostico.service";

@Module({
  imports: [SupabaseModule],
  controllers: [DiagnosticoController],
  providers: [DiagnosticoService],
})
export class DiagnosticoModule {}
