import { Global, Module } from "@nestjs/common";
import { FreioService } from "./freio.service";

/**
 * Global pelo mesmo motivo de `SupabaseModule`: quem precisa de freio são as
 * bordas do sistema (rate limit, login), e obrigar cada módulo dessas bordas a
 * importar mais um módulo é a linha que alguém esquece — com o efeito de a
 * proteção simplesmente não existir naquela rota, sem erro nenhum.
 */
@Global()
@Module({
  providers: [FreioService],
  exports: [FreioService],
})
export class FreioModule {}
