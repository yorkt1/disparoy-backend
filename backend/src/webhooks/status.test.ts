import { describe, expect, it } from "vitest";
import { avancaStatus, MAPA_STATUS } from "./evolution.service";

/**
 * A ordem de chegada dos webhooks não é garantida.
 *
 * A Evolution manda `DELIVERY_ACK` depois de `READ` com alguma frequência.
 * Aplicar sempre o último que chegou faria o número de leituras do relatório
 * CAIR sozinho enquanto o operador olha a tela — e ninguém desconfia do
 * webhook, desconfia do relatório.
 */
describe("progressão de status da mensagem", () => {
  it("avança pelos estágios na ordem", () => {
    expect(avancaStatus("enfileirada", "enviada")).toBe(true);
    expect(avancaStatus("enviada", "entregue")).toBe(true);
    expect(avancaStatus("entregue", "lida")).toBe(true);
  });

  it("nunca regride", () => {
    expect(avancaStatus("lida", "entregue")).toBe(false);
    expect(avancaStatus("lida", "enviada")).toBe(false);
    expect(avancaStatus("entregue", "enviada")).toBe(false);
  });

  it("ignora repetição do mesmo estágio", () => {
    // A Evolution reenvia o evento quando não recebe 200 rápido.
    expect(avancaStatus("entregue", "entregue")).toBe(false);
    expect(avancaStatus("lida", "lida")).toBe(false);
  });

  it("deixa a falha passar de qualquer estágio", () => {
    // `falhou` vem do gateway e é terminal: não é um degrau da escada.
    expect(avancaStatus("enfileirada", "falhou")).toBe(true);
    expect(avancaStatus("lida", "falhou")).toBe(true);
  });

  it("traduz os códigos do Baileys que importam", () => {
    expect(MAPA_STATUS.SERVER_ACK).toBe("enviada");
    expect(MAPA_STATUS.DELIVERY_ACK).toBe("entregue");
    expect(MAPA_STATUS.READ).toBe("lida");
    // Áudio ouvido conta como lido: para o relatório é a mesma informação.
    expect(MAPA_STATUS.PLAYED).toBe("lida");
    expect(MAPA_STATUS.ERROR).toBe("falhou");
    // Código desconhecido não vira status inventado.
    expect(MAPA_STATUS.QUALQUER_COISA).toBeUndefined();
  });
});
