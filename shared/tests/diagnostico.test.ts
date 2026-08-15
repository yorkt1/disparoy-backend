import { describe, expect, it } from "vitest";
import type { ResumoFalha } from "../src/diagnostico";
import {
  ehCodigoConhecido,
  semClassificacao,
  totalDeFalhas,
  totalSemClassificacao,
} from "../src/diagnostico";

function falha(codigo: string, total: number): ResumoFalha {
  return {
    codigo,
    categoria: null,
    total,
    canais: 1,
    campanhas: 1,
    primeiraEm: "2026-08-01T00:00:00.000Z",
    ultimaEm: "2026-08-15T00:00:00.000Z",
  };
}

describe("semClassificacao", () => {
  it("cobre tanto o histórico quanto o presente", () => {
    // `nao_registrado` é linha anterior à taxonomia; `desconhecido` é o
    // classificador rodando e não casando. Pedem a mesma ação.
    expect(semClassificacao("nao_registrado")).toBe(true);
    expect(semClassificacao("desconhecido")).toBe(true);
  });

  it("não confunde código classificado com falta de classificação", () => {
    expect(semClassificacao("canal_desconectado")).toBe(false);
    expect(semClassificacao("gateway_indisponivel")).toBe(false);
  });
});

describe("ehCodigoConhecido", () => {
  it("aceita os códigos da taxonomia", () => {
    expect(ehCodigoConhecido("canal_banido")).toBe(true);
    expect(ehCodigoConhecido("cota_diaria_atingida")).toBe(true);
  });

  it("recusa código que esta build não conhece", () => {
    // Acontece de verdade: deploy revertido, ou linha gravada por um worker
    // mais novo que o painel. Sem esta checagem viraria `undefined` na tela.
    expect(ehCodigoConhecido("codigo_do_futuro")).toBe(false);
    expect(ehCodigoConhecido("nao_registrado")).toBe(false);
  });

  it("não confunde propriedade herdada de Object com código", () => {
    expect(ehCodigoConhecido("toString")).toBe(false);
    expect(ehCodigoConhecido("constructor")).toBe(false);
  });
});

describe("totais", () => {
  const falhas = [
    falha("canal_desconectado", 120),
    falha("desconhecido", 30),
    falha("nao_registrado", 7),
    falha("numero_inexistente", 43),
  ];

  it("soma tudo", () => {
    expect(totalDeFalhas(falhas)).toBe(200);
  });

  it("soma só o que ficou sem classificação", () => {
    expect(totalSemClassificacao(falhas)).toBe(37);
  });

  it("devolve zero sem falhas", () => {
    expect(totalDeFalhas([])).toBe(0);
    expect(totalSemClassificacao([])).toBe(0);
  });
});
