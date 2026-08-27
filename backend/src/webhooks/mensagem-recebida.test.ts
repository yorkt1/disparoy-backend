import { describe, expect, it } from "vitest";
import { conteudoDaMensagem, horaDoEvento } from "./evolution.service";

/**
 * O que conta como resposta do contato, e o que fica de fora.
 *
 * Antes daqui o webhook lia `conversation` e `extendedTextMessage` e mais
 * nada: áudio, figurinha e reação — que numa campanha em massa são metade do
 * que volta — chegavam como string vazia e iam para o relatório como se a
 * pessoa não tivesse respondido.
 */

describe("conteudoDaMensagem", () => {
  it("lê texto simples", () => {
    expect(conteudoDaMensagem({ conversation: "Bom dia" })).toEqual({
      texto: "Bom dia",
      tipo: "texto",
    });
  });

  it("lê a resposta citada", () => {
    expect(conteudoDaMensagem({ extendedTextMessage: { text: "Que benção sim" } })).toEqual({
      texto: "Que benção sim",
      tipo: "texto",
    });
  });

  it("marca o áudio como áudio em vez de vazio", () => {
    expect(conteudoDaMensagem({ audioMessage: { mimetype: "audio/ogg" } })).toEqual({
      texto: "",
      tipo: "audio",
    });
  });

  it("mantém a legenda da foto", () => {
    expect(conteudoDaMensagem({ imageMessage: { caption: "pode me ligar" } })).toEqual({
      texto: "pode me ligar",
      tipo: "imagem",
    });
  });

  /*
   * O 🙏 de volta é resposta tanto quanto "obrigado", e o emoji é a única
   * informação que a reação carrega.
   */
  it("guarda o emoji da reação como texto", () => {
    expect(conteudoDaMensagem({ reactionMessage: { text: "🙌🏻" } })).toEqual({
      texto: "🙌🏻",
      tipo: "texto",
    });
  });

  it("localização e enquete viram resposta genérica, não silêncio", () => {
    expect(conteudoDaMensagem({ locationMessage: {} })).toEqual({ texto: "", tipo: "outro" });
  });

  /*
   * Este é o que inflava a taxa de resposta: apagar uma mensagem gera
   * MESSAGES_UPSERT com `fromMe` falso, e o sistema contava o WhatsApp
   * conversando consigo mesmo como resposta de um contato.
   */
  it("ignora evento de protocolo", () => {
    expect(conteudoDaMensagem({ protocolMessage: { type: "REVOKE" } })).toBeNull();
    expect(conteudoDaMensagem({ senderKeyDistributionMessage: {} })).toBeNull();
    expect(conteudoDaMensagem({})).toBeNull();
    expect(conteudoDaMensagem(undefined)).toBeNull();
  });
});

describe("horaDoEvento", () => {
  /*
   * A ordem das respostas é o que decide qual vai em `resposta_1`. Quando a
   * fila da Evolution acumula, todos os eventos atrasados chegam juntos e
   * `now()` os empilharia no mesmo instante, embaralhando a conversa.
   */
  it("usa o timestamp do WhatsApp, em segundos", () => {
    expect(horaDoEvento(1786798899)).toBe("2026-08-15T13:01:39.000Z");
  });

  it("aceita o timestamp em string, que é como a Evolution às vezes manda", () => {
    expect(horaDoEvento("1786798899")).toBe("2026-08-15T13:01:39.000Z");
  });

  it("sem timestamp, o relógio local é a única resposta possível", () => {
    const antes = Date.now();
    const hora = new Date(horaDoEvento(undefined)).getTime();
    expect(hora).toBeGreaterThanOrEqual(antes);
  });

  it("timestamp inválido não vira data em 1970", () => {
    expect(new Date(horaDoEvento(0)).getFullYear()).toBeGreaterThan(2000);
    expect(new Date(horaDoEvento("abc")).getFullYear()).toBeGreaterThan(2000);
  });
});
