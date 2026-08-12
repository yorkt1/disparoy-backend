import { describe, expect, it } from "vitest";
import { normalizarLista, normalizarTelefone, separarNumerosColados } from "../src/phone";

describe("normalizarTelefone", () => {
  it("aceita celular com DDD e nono dígito", () => {
    const r = normalizarTelefone("11987654321");
    expect(r).toEqual({ valido: true, e164: "+5511987654321", ddd: 11, pais: "55" });
  });

  it("ignora máscara e espaços", () => {
    expect(normalizarTelefone("(11) 98765-4321")).toMatchObject({ e164: "+5511987654321" });
    expect(normalizarTelefone(" +55 11 98765 4321 ")).toMatchObject({ e164: "+5511987654321" });
  });

  it("remove o DDI 55 duplicado", () => {
    expect(normalizarTelefone("5511987654321")).toMatchObject({ e164: "+5511987654321" });
  });

  it("acrescenta o nono dígito em celular legado de 8 dígitos", () => {
    expect(normalizarTelefone("1187654321")).toMatchObject({ e164: "+5511987654321" });
  });

  it("mantém telefone fixo de 8 dígitos sem inventar o nono", () => {
    expect(normalizarTelefone("1132145678")).toMatchObject({ e164: "+551132145678" });
  });

  it("rejeita DDD inexistente", () => {
    expect(normalizarTelefone("10987654321")).toEqual({ valido: false, motivo: "ddd_invalido" });
  });

  it("rejeita número curto, longo ou vazio", () => {
    expect(normalizarTelefone("119876")).toEqual({ valido: false, motivo: "curto_demais" });
    expect(normalizarTelefone("119876543210")).toEqual({ valido: false, motivo: "longo_demais" });
    expect(normalizarTelefone("   ")).toEqual({ valido: false, motivo: "vazio" });
  });

  it("rejeita 9 dígitos que não começam com 9", () => {
    expect(normalizarTelefone("11387654321")).toEqual({
      valido: false,
      motivo: "formato_invalido",
    });
  });

  it("preserva número internacional com + explícito", () => {
    const r = normalizarTelefone("+351912345678");
    expect(r).toMatchObject({ valido: true, e164: "+351912345678", pais: "35" });
  });
});

describe("normalizarLista", () => {
  it("descarta duplicatas mesmo em formatos diferentes", () => {
    const r = normalizarLista(["11987654321", "(11) 98765-4321", "+55 11 98765-4321"]);
    expect(r.validos).toHaveLength(1);
    expect(r.duplicados).toBe(2);
  });

  it("separa válidos de inválidos preservando o motivo", () => {
    const r = normalizarLista(["11987654321", "abc", "119876"]);
    expect(r.validos).toHaveLength(1);
    expect(r.invalidos.map((i) => i.motivo)).toEqual(["formato_invalido", "curto_demais"]);
  });
});

describe("separarNumerosColados", () => {
  it("quebra por quebra de linha, vírgula e ponto e vírgula", () => {
    expect(separarNumerosColados("11987654321\n21998877665, 31988112244; 4199663322")).toEqual([
      "11987654321",
      "21998877665",
      "31988112244",
      "4199663322",
    ]);
  });

  it("ignora linhas em branco", () => {
    expect(separarNumerosColados("11987654321\n\n\n , ;\n21998877665")).toEqual([
      "11987654321",
      "21998877665",
    ]);
  });
});
