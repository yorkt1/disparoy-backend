import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { Publico } from "../auth/publico.decorator";
import { ambiente } from "../config/ambiente";
import { EvolutionService } from "./evolution.service";

/**
 * Recebe os eventos da Evolution API.
 *
 * Público por natureza — a Evolution precisa alcançar esta URL pela internet —
 * e por isso protegido por segredo compartilhado. Sem essa checagem qualquer
 * um poderia forjar confirmação de entrega ou descadastrar contatos alheios.
 */
@Controller("webhooks/evolution")
export class EvolutionController {
  private readonly logger = new Logger(EvolutionController.name);

  constructor(private readonly evolution: EvolutionService) {}

  @Post()
  @Publico()
  @HttpCode(200)
  async receber(
    @Headers("authorization") autorizacao: string | undefined,
    @Headers("x-webhook-secret") segredoHeader: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    this.exigirSegredo(autorizacao, segredoHeader);

    const eventoId = await this.evolution.registrarEvento(payload);

    // Responde já e processa depois: a Evolution reenvia o evento se demorar,
    // e um webhook lento vira tempestade de duplicatas.
    void this.evolution.processar(payload, eventoId).catch((e: unknown) => {
      this.logger.error(`Processamento assíncrono falhou: ${String(e)}`);
    });

    return { recebido: true };
  }

  private exigirSegredo(autorizacao?: string, segredoHeader?: string): void {
    const esperado = ambiente().EVOLUTION_WEBHOOK_SECRET;
    if (!esperado) {
      // Sem segredo configurado o endpoint fica aberto — recusar é mais seguro
      // do que aceitar qualquer coisa achando que está protegido.
      throw new UnauthorizedException(
        "Webhook desabilitado: defina EVOLUTION_WEBHOOK_SECRET em backend/.env.",
      );
    }

    const recebido = segredoHeader ?? autorizacao?.replace(/^Bearer\s+/i, "");
    if (!recebido || !comparaSegura(recebido, esperado)) {
      throw new UnauthorizedException("Segredo do webhook inválido.");
    }
  }
}

/**
 * Comparação em tempo constante.
 *
 * Um `===` vazaria o segredo caractere a caractere pela diferença de tempo,
 * já que este endpoint aceita tentativas sem limite de quem estiver na rede.
 */
function comparaSegura(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
