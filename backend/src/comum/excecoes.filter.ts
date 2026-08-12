import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";

/**
 * Resposta de erro num formato só, para o frontend sempre saber onde olhar:
 *   { erro: string, erros?: { campo: mensagem } }
 *
 * Erros não previstos viram 500 genérico — a mensagem original vai para o log
 * do servidor, nunca para o cliente, porque costuma conter nome de tabela e
 * detalhe de conexão.
 */
@Catch()
export class FiltroExcecoes implements ExceptionFilter {
  private readonly logger = new Logger("Excecao");

  catch(excecao: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (excecao instanceof HttpException) {
      const status = excecao.getStatus();
      const corpo = excecao.getResponse();

      if (typeof corpo === "object" && corpo !== null && "erro" in corpo) {
        res.status(status).json(corpo);
        return;
      }

      const mensagem =
        typeof corpo === "string"
          ? corpo
          : ((corpo as { message?: string | string[] }).message ?? excecao.message);

      res.status(status).json({
        erro: Array.isArray(mensagem) ? mensagem.join(" ") : mensagem,
      });
      return;
    }

    const detalhe = excecao instanceof Error ? excecao.stack : String(excecao);
    this.logger.error(detalhe);

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      erro: "Erro interno. Tente novamente em instantes.",
    });
  }
}
