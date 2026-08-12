import { createParamDecorator, ExecutionContext, InternalServerErrorException } from "@nestjs/common";
import type { Request } from "express";
import type { UsuarioAutenticado } from "./auth.guard";

/**
 * Injeta o usuário autenticado no controller.
 * Lança se estiver ausente — significa rota sem guard, o que é erro de código,
 * não do cliente, e é melhor estourar do que operar sem saber quem é o autor.
 */
export const Usuario = createParamDecorator(
  (_dado: unknown, contexto: ExecutionContext): UsuarioAutenticado => {
    const req = contexto.switchToHttp().getRequest<Request>();
    if (!req.usuario) {
      throw new InternalServerErrorException("Rota protegida sem AuthGuard aplicado.");
    }
    return req.usuario;
  },
);

/** Ip de origem para a trilha de auditoria, considerando proxy. */
export const IpOrigem = createParamDecorator((_d: unknown, contexto: ExecutionContext): string => {
  const req = contexto.switchToHttp().getRequest<Request>();
  const encaminhado = req.headers["x-forwarded-for"];
  if (typeof encaminhado === "string" && encaminhado) return encaminhado.split(",")[0].trim();
  if (Array.isArray(encaminhado) && encaminhado[0]) return encaminhado[0].split(",")[0].trim();
  return req.ip ?? "127.0.0.1";
});
