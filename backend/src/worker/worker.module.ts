import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SupabaseModule } from "../supabase/supabase.module";
import { AuditoriaModule } from "../auditoria/auditoria.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { FilaModule } from "../fila/fila.module";
import { DisparoService } from "./disparo.service";

/**
 * Contexto do worker: os mesmos serviços da API, sem controllers HTTP.
 * O worker não escuta porta — ele consome a fila.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env.local", ".env"] }),
    SupabaseModule,
    AuditoriaModule,
    WhatsappModule,
    FilaModule,
  ],
  providers: [DisparoService],
})
export class WorkerModule {}
