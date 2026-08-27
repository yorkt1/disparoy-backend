import { describe, expect, it } from "vitest";
import { normalizarNomeDoEvento } from "./evolution.service";

/**
 * O defeito que motivou este arquivo: a Evolution em produção manda
 * `payload.event` como `messages.upsert` (minúsculo, com ponto), e o `switch`
 * de `processar` comparava contra `MESSAGES_UPSERT` sem normalizar nada. Toda
 * resposta e toda confirmação de leitura caíam no `default` — silenciosamente,
 * sem lançar exceção, então `eventos_webhook.processado` ficava `true` com
 * `erro` nulo como se tudo tivesse funcionado. Ver `eventos_webhook` em
 * produção foi o que expôs o formato real.
 */
describe("normalizarNomeDoEvento", () => {
  it("converte o formato minúsculo com ponto que a Evolution manda em produção", () => {
    expect(normalizarNomeDoEvento("messages.upsert")).toBe("MESSAGES_UPSERT");
    expect(normalizarNomeDoEvento("messages.update")).toBe("MESSAGES_UPDATE");
    expect(normalizarNomeDoEvento("send.message")).toBe("SEND_MESSAGE");
    expect(normalizarNomeDoEvento("connection.update")).toBe("CONNECTION_UPDATE");
  });

  it("mantém o formato SCREAMING_SNAKE_CASE que o switch já esperava", () => {
    expect(normalizarNomeDoEvento("MESSAGES_UPSERT")).toBe("MESSAGES_UPSERT");
    expect(normalizarNomeDoEvento("CONNECTION_UPDATE")).toBe("CONNECTION_UPDATE");
  });

  it("evento ausente vira string vazia, e não 'undefined' — cai no default sem casar nada", () => {
    expect(normalizarNomeDoEvento(undefined)).toBe("");
  });
});
