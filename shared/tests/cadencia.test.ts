import { describe, expect, it } from "vitest";
import {
  CADENCIA_MAXIMA_SEGUNDOS,
  CADENCIA_MINIMA_SEGUNDOS,
  CONTATOS_PARA_CADENCIA_MAXIMA,
  JANELA_DIARIA_SEGUNDOS,
  contatosQueCabemNoDia,
  duracaoEstimadaSegundos,
  fechaNoDia,
  intervaloSugerido,
} from "../src/cadencia";

/**
 * A curva da cadência.
 *
 * O que estes testes protegem não é o formato da fórmula — é que ela nunca
 * saia de 90–240 e nunca ande para trás. Os dois extremos foram pedidos
 * explicitamente pelo operador, e uma mudança futura na interpolação que
 * estourasse um deles produziria disparo mais rápido do que o combinado sem
 * nada na tela dizendo isso.
 */

describe("intervaloSugerido", () => {
  it("respeita o piso e o teto em toda a faixa de tamanhos", () => {
    for (const n of [0, 1, 10, 100, 500, 1500, 20_000]) {
      const faixa = intervaloSugerido(n);
      expect(faixa.minSegundos).toBeGreaterThanOrEqual(CADENCIA_MINIMA_SEGUNDOS);
      expect(faixa.maxSegundos).toBeLessThanOrEqual(CADENCIA_MAXIMA_SEGUNDOS);
      expect(faixa.maxSegundos).toBeGreaterThan(faixa.minSegundos);
    }
  });

  it("nunca diminui quando o público cresce", () => {
    // Monotonicidade é a regra inteira: "quanto mais contatos, maior o
    // intervalo". Uma leva maior sair mais rápido que uma menor seria o
    // oposto do que a feature promete.
    let anterior = 0;
    for (let n = 0; n <= 3000; n += 50) {
      const { minSegundos } = intervaloSugerido(n);
      expect(minSegundos).toBeGreaterThanOrEqual(anterior);
      anterior = minSegundos;
    }
  });

  it("começa no piso quando não há ninguém na leva", () => {
    // Zero contatos acontece na tela: o formulário calcula antes de a planilha
    // ser carregada. Não pode dar NaN nem número negativo.
    expect(intervaloSugerido(0)).toEqual({ minSegundos: 90, maxSegundos: 120 });
  });

  it("satura no teto e não passa dele", () => {
    const noPonto = intervaloSugerido(CONTATOS_PARA_CADENCIA_MAXIMA);
    expect(noPonto).toEqual({ minSegundos: 210, maxSegundos: 240 });
    // Muito além do ponto de saturação continua valendo o mesmo.
    expect(intervaloSugerido(50_000)).toEqual(noPonto);
  });

  it("uma leva pequena anda perto do piso e uma grande perto do teto", () => {
    expect(intervaloSugerido(100).minSegundos).toBeLessThan(110);
    expect(intervaloSugerido(1200).minSegundos).toBeGreaterThan(180);
  });
});

describe("duração e janela do dia", () => {
  it("estima pela média da faixa", () => {
    expect(duracaoEstimadaSegundos(10, { minSegundos: 90, maxSegundos: 120 })).toBe(1050);
  });

  it("leva vazia não tem duração", () => {
    expect(duracaoEstimadaSegundos(0, intervaloSugerido(0))).toBe(0);
  });

  it("aponta a leva que não fecha no dia", () => {
    // ~340 contatos a 105 s médios enchem as 10 h; 1200 passam MUITO disso, e
    // é esse o caso que o aviso da tela precisa pegar antes do disparo.
    expect(fechaNoDia(100, intervaloSugerido(100))).toBe(true);
    expect(fechaNoDia(1200, intervaloSugerido(1200))).toBe(false);
  });

  it("diz quantos contatos cabem, para o aviso ser acionável", () => {
    const cabem = contatosQueCabemNoDia(intervaloSugerido(1200));
    expect(cabem).toBeGreaterThan(0);
    // O número sugerido tem de ser, ele mesmo, um número que fecha no dia.
    expect(cabem * 195).toBeLessThanOrEqual(JANELA_DIARIA_SEGUNDOS);
  });
});
