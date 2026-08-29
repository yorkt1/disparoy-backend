import { describe, expect, it } from "vitest";
import type { CodigoFalha } from "../src/whatsapp/falhas";
import { FALHAS, categoriaDe, culpaNossa, paraCampanha } from "../src/whatsapp/falhas";

const CODIGOS = Object.keys(FALHAS) as CodigoFalha[];

describe("culpaNossa", () => {
  it("responde para todo código da união", () => {
    for (const codigo of CODIGOS) {
      expect(typeof culpaNossa(codigo), codigo).toBe("boolean");
    }
  });

  it("infra e configuração são nossas", () => {
    for (const codigo of CODIGOS) {
      const categoria = categoriaDe(codigo);
      if (categoria === "infra" || categoria === "configuracao") {
        expect(culpaNossa(codigo), codigo).toBe(true);
      }
    }
  });

  /**
   * O lado de fora: WhatsApp do cliente, número de destino, mensagem, cota.
   * Nenhum deles se resolve sozinho enquanto o contato espera na fila, e é por
   * isso que só eles podem encerrar um contato como `falhou`.
   */
  it("canal, destinatário, conteúdo e limite não são nossos", () => {
    for (const codigo of CODIGOS) {
      const categoria = categoriaDe(codigo);
      if (categoria !== "infra" && categoria !== "configuracao") {
        expect(culpaNossa(codigo), codigo).toBe(false);
      }
    }
  });

  it("separa o canal caído do gateway mudo", () => {
    expect(culpaNossa("canal_desconectado")).toBe(false);
    expect(culpaNossa("gateway_indisponivel")).toBe(true);
  });

  /** `desconhecido` é infra até alguém escrever a regra — nunca culpa do cliente. */
  it("desconhecido conta como nosso", () => {
    expect(culpaNossa("desconhecido")).toBe(true);
  });
});

/**
 * O cruzamento que sustenta `tratarSuspeitaDeCanal`: entre os códigos que param
 * a campanha existem uns de culpa nossa e outros de culpa de fora, e o worker
 * precisa dos dois grupos para decidir se o contato morre ou volta para a fila.
 * Se algum dia um dos grupos ficar vazio, o `if` no worker vira código morto e
 * este teste é quem avisa.
 */
describe("códigos que param a campanha", () => {
  const param = CODIGOS.filter((c) => paraCampanha(c));

  it("inclui casos de culpa nossa", () => {
    expect(param.filter((c) => culpaNossa(c))).not.toHaveLength(0);
  });

  it("inclui casos de culpa de fora", () => {
    expect(param.filter((c) => !culpaNossa(c))).not.toHaveLength(0);
  });

  /**
   * Um código retentável que encerrasse o contato seria uma contradição
   * gravada no banco: a taxonomia dizendo "vale tentar de novo" num status que
   * nunca mais é tentado.
   */
  it("todo código de culpa nossa que para a campanha é retentável ou de configuração", () => {
    for (const codigo of param) {
      if (!culpaNossa(codigo)) continue;
      const perfil = FALHAS[codigo];
      expect(perfil.retentavel || perfil.categoria === "configuracao", codigo).toBe(true);
    }
  });
});
