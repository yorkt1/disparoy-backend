import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthGuard } from "./auth/auth.guard";
import { AuthModule } from "./auth/auth.module";
import { ArmazenamentoDeFreio } from "./comum/freio-armazenamento";
import { FreioModule } from "./comum/freio.module";
import { FreioService } from "./comum/freio.service";
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

/**
 * Tetos globais do rate limit, por IP.
 *
 * Duas janelas: uma curta contra rajada e uma longa contra varredura lenta. O
 * webhook da Evolution tem teto próprio (mais alto) porque uma campanha grande
 * gera muitos eventos de status em pouco tempo.
 *
 * **Estes dois números são POR RÉPLICA**, e a API roda com `numInstances: 2`
 * (ver `render.yaml`): o teto real de quem alterna conexões é 80/10 s e
 * 400/60 s, e sobe junto se alguém adicionar uma instância. Eles ficam em
 * memória de propósito — compartilhá-los custaria uma escrita no banco por
 * requisição, inclusive no caminho do webhook, que é o oposto do que o item 4
 * do `ROBUSTEZ.md` mandou fazer. É uma proteção contra abuso grosseiro, e nesse
 * papel o dobro do número dá no mesmo.
 *
 * Onde o dobro NÃO dá no mesmo — login e troca de senha, em que a tentativa
 * repetida é o ataque — a rota pede teto mais apertado que estes, e o
 * `ArmazenamentoDeFreio` reconhece esse pedido e conta no Postgres, valendo
 * para todas as réplicas ao mesmo tempo.
 */
const FREIOS_GLOBAIS = [
  { name: "curta", ttl: 10_000, limit: 40 },
  { name: "longa", ttl: 60_000, limit: 200 },
] as const;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env.local", ".env"] }),
    ObservabilidadeModule,
    SupabaseModule,
    FreioModule,
    ThrottlerModule.forRootAsync({
      inject: [FreioService],
      useFactory: (freio: FreioService) => ({
        throttlers: FREIOS_GLOBAIS.map((f) => ({ ...f })),
        storage: new ArmazenamentoDeFreio(
          freio,
          new Map(FREIOS_GLOBAIS.map((f) => [f.name, f.limit])),
        ),
      }),
    }),
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
