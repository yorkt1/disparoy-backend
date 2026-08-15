import { Module } from "@nestjs/common";
import { AvisosService } from "./avisos.service";
import { AvisosController } from "./avisos.controller";

/**
 * Caixa de avisos: leitura e marcação, nada de escrita de aviso.
 *
 * Quem cria notificação é o trigger `notificar_envolvidos` no banco, disparado
 * pelo `abrir_incidente` que o worker chama. A API só entrega e marca como
 * lido — se ela também pudesse criar, existiriam dois caminhos de escrita para
 * a mesma tabela e a regra de quem-recebe-o-quê teria duas cópias.
 */
@Module({
  controllers: [AvisosController],
  providers: [AvisosService],
})
export class AvisosModule {}
