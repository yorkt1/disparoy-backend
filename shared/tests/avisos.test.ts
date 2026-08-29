import { describe, expect, it } from "vitest";
import type { CategoriaFalha, CodigoFalha } from "../src/whatsapp/falhas";
import { FALHAS } from "../src/whatsapp/falhas";
import { ORIGENS, origemDe, severidadeDe } from "../src/avisos";

const CATEGORIAS = Object.keys(ORIGENS) as CategoriaFalha[];
const CODIGOS = Object.keys(FALHAS) as CodigoFalha[];

describe("origemDe", () => {
  /**
   * Categoria sem origem renderiza `undefined` no selo — sem erro, sem log,
   * com o operador olhando um selo em branco na tela de falha. O compilador
   * cobre o `Record` na declaração; este teste cobre a união crescendo depois.
   */
  it("cobre toda categoria existente", () => {
    for (const categoria of CATEGORIAS) {
      const origem = origemDe(categoria);
      expect(origem, categoria).toBeDefined();
      expect(origem.rotulo.trim(), categoria).not.toBe("");
      expect(origem.abertura.trim(), categoria).not.toBe("");
    }
  });

  it("toda categoria usada por FALHAS tem origem", () => {
    for (const codigo of CODIGOS) {
      expect(origemDe(FALHAS[codigo].categoria), codigo).toBeDefined();
    }
  });

  /**
   * A distinção que sustenta o produto: `canal` é "o WhatsApp do cliente caiu,
   * reconecte" e `infra` é "o problema é nosso, não faça nada". Se as duas
   * chegarem iguais na tela, o operador conclui que o sistema quebrou — que é
   * exatamente o estado anterior a esta camada existir.
   */
  it("separa canal de infra em rótulo e em tom", () => {
    const canal = origemDe("canal");
    const infra = origemDe("infra");

    expect(canal.rotulo).not.toBe(infra.rotulo);
    expect(canal.tom).not.toBe(infra.tom);
    expect(canal.abertura).not.toBe(infra.abertura);
  });

  /** A abertura existe para dizer de quem NÃO é a culpa. */
  it("a abertura de infra isenta o WhatsApp do cliente", () => {
    expect(origemDe("infra").abertura).toMatch(/whatsapp/i);
    expect(origemDe("canal").abertura).toMatch(/aparelho|whatsapp/i);
  });

  /** Dois rótulos iguais em categorias diferentes tornam o selo inútil. */
  it("nenhum rótulo se repete entre categorias", () => {
    const rotulos = CATEGORIAS.map((c) => origemDe(c).rotulo);
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });

  /** `limite` não é erro — o tom não pode ser o de perigo. */
  it("limite não se apresenta como falha grave", () => {
    expect(origemDe("limite").tom).toBe("neutro");
  });
});

describe("severidadeDe", () => {
  it("classifica todo código conhecido", () => {
    for (const codigo of CODIGOS) {
      expect(["critico", "atencao", "informativo"], codigo).toContain(severidadeDe(codigo));
    }
  });

  /**
   * Severidade é CONSEQUÊNCIA de a campanha ter parado, nunca um campo
   * digitado. Um aviso "informativo" que na verdade parou o disparo inteiro é
   * o operador descobrindo pela ausência de mensagens saindo.
   */
  it("tudo que para a campanha é crítico", () => {
    for (const codigo of CODIGOS) {
      if (FALHAS[codigo].paraCampanha) {
        expect(severidadeDe(codigo), codigo).toBe("critico");
      }
    }
  });

  it("falha de destinatário ou de limite que não para a campanha é informativa", () => {
    for (const codigo of CODIGOS) {
      const { categoria, paraCampanha } = FALHAS[codigo];
      if (!paraCampanha && (categoria === "destinatario" || categoria === "limite")) {
        expect(severidadeDe(codigo), codigo).toBe("informativo");
      }
    }
  });

  it("cota diária não vira alarme", () => {
    expect(severidadeDe("cota_diaria_atingida")).toBe("informativo");
  });

  it("canal desconectado é crítico", () => {
    expect(severidadeDe("canal_desconectado")).toBe("critico");
  });

  /** `desconhecido` é o caso que ainda não tem regra — não pode virar ruído. */
  it("desconhecido não é informativo", () => {
    expect(severidadeDe("desconhecido")).not.toBe("informativo");
  });
});
