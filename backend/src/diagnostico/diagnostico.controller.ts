import { Controller, Get, Query } from "@nestjs/common";
import { SomenteAdmin } from "../auth/papel.decorator";
import { DiagnosticoService } from "./diagnostico.service";

/**
 * Janela padrão e teto.
 *
 * 7 dias porque é o horizonte em que uma regra de classificação quebrada ainda
 * pode ser corrigida antes da próxima campanha grande. O teto de 90 existe para
 * a janela não virar um scan da tabela inteira a partir da barra de endereço:
 * `dias` chega do cliente e a função no banco confia no que recebe.
 */
const DIAS_PADRAO = 7;
const DIAS_MAX = 90;

function janela(bruto?: string): number {
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) return DIAS_PADRAO;
  return Math.min(Math.floor(n), DIAS_MAX);
}

/**
 * Diagnóstico de falhas — restrito a administradores.
 *
 * A resposta carrega o texto que o gateway devolveu, sem filtro, e esse texto
 * às vezes traz o número do destinatário no meio. É informação de investigação,
 * do mesmo naipe da trilha de auditoria, não de operação diária.
 */
@Controller("diagnostico")
@SomenteAdmin()
export class DiagnosticoController {
  constructor(private readonly diagnostico: DiagnosticoService) {}

  @Get()
  resumo(@Query("dias") dias?: string) {
    return this.diagnostico.resumo(janela(dias));
  }

  /** Amostras de um código específico, quando o operador abre a linha. */
  @Get("amostras")
  amostras(@Query("codigo") codigo: string, @Query("dias") dias?: string) {
    return this.diagnostico.amostrasDoCodigo(janela(dias), codigo);
  }
}
