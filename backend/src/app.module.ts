import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthGuard } from "./auth/auth.guard";
import { AuthModule } from "./auth/auth.module";
import { SupabaseModule } from "./supabase/supabase.module";
import { AuditoriaModule } from "./auditoria/auditoria.module";
import { WhatsappModule } from "./whatsapp/whatsapp.module";
import { FilaModule } from "./fila/fila.module";
import { CanaisModule } from "./canais/canais.module";
import { TemplatesModule } from "./templates/templates.module";
import { SpintaxModule } from "./spintax/spintax.module";
import { ContatosModule } from "./contatos/contatos.module";
import { MidiaModule } from "./midia/midia.module";
import { CampanhasModule } from "./campanhas/campanhas.module";
import { UsuariosModule } from "./usuarios/usuarios.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { AvisosModule } from "./avisos/avisos.module";
import { DiagnosticoModule } from "./diagnostico/diagnostico.module";
import { EmpresasModule } from "./empresas/empresas.module";
import { VigiaModule } from "./vigia/vigia.module";
import { ObservabilidadeModule } from "./observabilidade/observabilidade.module";
import { SaudeController } from "./saude.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env.local", ".env"] }),
    ObservabilidadeModule,
    /**
     * Rate limiting global.
     *
     * Duas janelas: uma curta contra rajada e uma longa contra varredura
     * lenta. O webhook da Evolution tem teto próprio (mais alto) porque uma
     * campanha grande gera muitos eventos de status em pouco tempo.
     */
    ThrottlerModule.forRoot([
      { name: "curta", ttl: 10_000, limit: 40 },
      { name: "longa", ttl: 60_000, limit: 200 },
    ]),
    SupabaseModule,
    AuthModule,
    AuditoriaModule,
    WhatsappModule,
    FilaModule,
    CanaisModule,
    TemplatesModule,
    SpintaxModule,
    ContatosModule,
    MidiaModule,
    CampanhasModule,
    AvisosModule,
    DiagnosticoModule,
    EmpresasModule,
    UsuariosModule,
    WebhooksModule,
    VigiaModule,
  ],
  controllers: [SaudeController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Autenticação por padrão em TODA rota. Abrir uma exige @Publico()
    // explícito, então esquecer o guard nunca expõe dados por acidente.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
