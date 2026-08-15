import { describe, expect, it } from "vitest";
import type { ResumoFalha } from "../src/diagnostico";
import {
  ehCodigoConhecido,
  nivelDaCobertura,
  semClassificacao,
  totalDeFalhas,
  totalSemClassificacao,
} from "../src/diagnostico";
import { classificarEvolution, classificarMeta } from "../src/whatsapp/falhas";

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

describe("nivelDaCobertura", () => {
  it("não alarma com amostra pequena", () => {
    // 1 falha, 1 sem classificação, é "0% de cobertura" — aritmeticamente
    // certo e informativamente falso. Uma linha não é tendência.
    expect(nivelDaCobertura(1, 1)).toBe("amostra_pequena");
    expect(nivelDaCobertura(19, 19)).toBe("amostra_pequena");
  });

  it("alarma quando a proporção pesa numa amostra que já diz algo", () => {
    expect(nivelDaCobertura(20, 2)).toBe("atencao");
    expect(nivelDaCobertura(1000, 400)).toBe("atencao");
  });

  it("fica em ok quando a maioria é reconhecida", () => {
    expect(nivelDaCobertura(20, 1)).toBe("ok");
    expect(nivelDaCobertura(1000, 5)).toBe("ok");
  });
});

describe("fallback dos classificadores", () => {
  it("4xx sem regra vira desconhecido, não um palpite confiante", () => {
    /*
     * Antes devolvia `conteudo_recusado` — um rótulo plausível que NUNCA
     * aparecia como "sem classificação". A cobertura marcava 100% enquanto
     * parte dela era chute, escondendo exatamente as regras que faltavam.
     */
    expect(classificarEvolution(400, "algo que ninguém previu")).toBe("desconhecido");
    expect(classificarEvolution(422, "outro texto novo")).toBe("desconhecido");
    expect(classificarMeta(400, "mensagem inédita da Meta")).toBe("desconhecido");
  });

  it("as regras que existem continuam ganhando do fallback", () => {
    expect(classificarEvolution(0, "ETIMEDOUT")).toBe("gateway_timeout");
    expect(classificarEvolution(401, "unauthorized")).toBe("credencial_invalida");
    expect(classificarEvolution(400, "connection closed")).toBe("canal_desconectado");
    expect(classificarEvolution(400, "mimetype invalido")).toBe("midia_invalida");
    expect(classificarMeta(400, "template rejeitado")).toBe("template_rejeitado");
  });
});
