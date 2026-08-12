import { describe, expect, it } from "vitest";
import {
  combinacoesPossiveis,
  extrairVariacoes,
  extrairVariaveis,
  indexarVariacoes,
  renderizarMensagem,
  validarReferencias,
} from "../src/spintax";
import type { Spintax } from "../src/tipos";

const VARIACOES: Spintax[] = [
  { id: "1", nome: "saudacao", opcoes: ["Oi", "Olá", "E aí"], criadoEm: "" },
  { id: "2", nome: "urgencia", opcoes: ["só hoje", "últimas horas"], criadoEm: "" },
  { id: "3", nome: "vazia", opcoes: [], criadoEm: "" },
];

const indice = indexarVariacoes(VARIACOES);

describe("extração", () => {
  it("encontra variações {{*nome*}} sem repetir", () => {
    expect(extrairVariacoes("{{*saudacao*}} {{1}}, {{*urgencia*}} e {{*saudacao*}}")).toEqual([
      "saudacao",
      "urgencia",
    ]);
  });

  it("encontra variáveis {{1}} e {{nome}} sem confundir com variações", () => {
    expect(extrairVariaveis("{{*saudacao*}} {{1}} e {{nome}}")).toEqual(["1", "nome"]);
  });
});

describe("renderizarMensagem", () => {
  it("substitui variáveis posicionais e nomeadas", () => {
    const saida = renderizarMensagem("Oi {{1}}, tudo bem {{nome}}?", {
      variacoes: {},
      variaveis: { "1": "Ana", nome: "Ana" },
    });
    expect(saida).toBe("Oi Ana, tudo bem Ana?");
  });

  it("sorteia a opção da variação usando o gerador injetado", () => {
    const primeira = renderizarMensagem("{{*saudacao*}}!", {
      variacoes: indice,
      variaveis: {},
      aleatorio: () => 0,
    });
    const ultima = renderizarMensagem("{{*saudacao*}}!", {
      variacoes: indice,
      variaveis: {},
      aleatorio: () => 0.99,
    });
    expect(primeira).toBe("Oi!");
    expect(ultima).toBe("E aí!");
  });

  it("produz textos diferentes entre envios ao longo das opções", () => {
    const resultados = new Set(
      [0, 0.4, 0.9].map((n) =>
        renderizarMensagem("{{*saudacao*}}", {
          variacoes: indice,
          variaveis: {},
          aleatorio: () => n,
        }),
      ),
    );
    expect(resultados.size).toBe(3);
  });

  it("mantém a referência literal quando a variação não existe", () => {
    const saida = renderizarMensagem("{{*inexistente*}} tudo bem?", {
      variacoes: indice,
      variaveis: {},
    });
    expect(saida).toBe("{{*inexistente*}} tudo bem?");
  });

  it("mantém a variável literal quando não há valor", () => {
    expect(renderizarMensagem("Oi {{1}}", { variacoes: {}, variaveis: {} })).toBe("Oi {{1}}");
  });

  it("resolve variações antes das variáveis, no mesmo texto", () => {
    const saida = renderizarMensagem("{{*saudacao*}} {{1}}, {{*urgencia*}}!", {
      variacoes: indice,
      variaveis: { "1": "Bruno" },
      aleatorio: () => 0,
    });
    expect(saida).toBe("Oi Bruno, só hoje!");
  });
});

describe("validarReferencias", () => {
  it("aponta variação inexistente e variação sem opções", () => {
    const problemas = validarReferencias("{{*saudacao*}} {{*sumida*}} {{*vazia*}}", VARIACOES);
    expect(problemas).toEqual([
      { tipo: "variacao_inexistente", nome: "sumida" },
      { tipo: "variacao_vazia", nome: "vazia" },
    ]);
  });

  it("não reclama de texto sem variações", () => {
    expect(validarReferencias("Oi {{1}}", VARIACOES)).toEqual([]);
  });
});

describe("combinacoesPossiveis", () => {
  it("multiplica as opções de cada variação referenciada", () => {
    expect(combinacoesPossiveis("{{*saudacao*}} {{*urgencia*}}", VARIACOES)).toBe(6);
  });

  it("vale 1 quando não há variação no texto", () => {
    expect(combinacoesPossiveis("Oi {{1}}", VARIACOES)).toBe(1);
  });
});
