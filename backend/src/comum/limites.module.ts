import { Global, Module } from "@nestjs/common";
import { LimitesService } from "./limites.service";

/**
 * Global pelo mesmo motivo de `FreioModule`: quem aplica limite são pontos
 * espalhados — a criação de canal, a criação de campanha, cada envio do worker
 * — e obrigar cada módulo desses a importar mais um é a linha que alguém
 * esquece. O efeito de esquecer não é um erro de compilação: é o limite
 * simplesmente não existir naquele caminho.
 *
 * Importado tanto por `AppModule` quanto por `WorkerModule` — a cota diária é
 * consumida no worker, e o teto de canais/campanhas é conferido na API.
 */
@Global()
@Module({
  providers: [LimitesService],
  exports: [LimitesService],
})
export class LimitesModule {}
