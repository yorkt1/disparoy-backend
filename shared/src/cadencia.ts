import type { IntervaloAleatorio } from "./tipos.js";

/**
 * Quanto esperar entre um contato e o próximo, pelo tamanho da leva.
 *
 * O padrão de hoje é `90–240 s` fixo para todo mundo
 * (`INTERVALO_PADRAO_ENTRE_CONTATOS`), e é fixo demais nos dois sentidos: uma
 * leva de 40 pessoas é tratada com a mesma desconfiança de uma de 3 mil, e uma
 * de 3 mil pode sortear 90 s tantas vezes seguidas quanto o acaso quiser.
 *
 * O que queima um número é VOLUME por dia, não o disparo em si. Então a faixa
 * desliza com o tamanho da leva: pouca gente anda perto do piso, muita gente
 * anda perto do teto.
 *
 * Os extremos são os que o operador pediu e não se movem — 90 s de piso
 * absoluto, 240 s de teto absoluto.
 */

/** Piso e teto absolutos da cadência entre contatos, em segundos. */
export const CADENCIA_MINIMA_SEGUNDOS = 90;
export const CADENCIA_MAXIMA_SEGUNDOS = 240;

/**
 * A partir de quantos contatos a leva já anda no teto.
 *
 * Não é um número medido — é a escolha de onde a curva satura. Acima disto o
 * intervalo não tem mais como crescer, e o que protege o número passa a ser
 * dividir a campanha em mais dias, não esperar mais entre um envio e outro.
 */
export const CONTATOS_PARA_CADENCIA_MAXIMA = 1500;

/**
 * Largura da faixa sorteável, em segundos.
 *
 * A faixa existe para o envio não ter período constante — intervalo fixo é
 * assinatura de robô. 30 s sobre um piso de 90 já é 33% de variação, que basta
 * para não haver período; mais do que isso só tornaria a duração da campanha
 * imprevisível para quem precisa planejar o dia.
 */
const LARGURA_FAIXA_SEGUNDOS = 30;

/**
 * Quanto tempo se considera que um dia de disparo comporta.
 *
 * Não é uma janela imposta: nada no worker recusa enviar às 3h. É a régua do
 * aviso da tela — o número que responde "essa leva fecha hoje?". Dez horas é o
 * dia de trabalho de quem opera, e é depois dele que o operador para de
 * acompanhar o que está saindo.
 */
export const JANELA_DIARIA_SEGUNDOS = 10 * 60 * 60;

function limitar(valor: number, minimo: number, maximo: number): number {
  return Math.min(Math.max(valor, minimo), maximo);
}

/**
 * A faixa sugerida para uma leva deste tamanho.
 *
 * Interpolação contínua, e não uma tabela de degraus: a tela mostra o número
 * calculado, e 300 contatos dando `114–144` enquanto 301 dá `150–180` seria
 * uma diferença que ninguém consegue explicar olhando.
 *
 * `contatos` é a leva DO DIA, não o total da campanha — numa campanha dividida
 * em seis dias, o que o número dispara por dia é um sexto, e é esse volume que
 * decide o risco.
 */
export function intervaloSugerido(contatos: number): IntervaloAleatorio {
  const fracao = limitar(contatos / CONTATOS_PARA_CADENCIA_MAXIMA, 0, 1);
  const teto = CADENCIA_MAXIMA_SEGUNDOS - LARGURA_FAIXA_SEGUNDOS;

  const minSegundos = Math.round(
    CADENCIA_MINIMA_SEGUNDOS + (teto - CADENCIA_MINIMA_SEGUNDOS) * fracao,
  );

  return { minSegundos, maxSegundos: minSegundos + LARGURA_FAIXA_SEGUNDOS };
}

/**
 * Quanto tempo essa leva leva para sair, em segundos.
 *
 * Usa a média da faixa: o valor real é sorteado a cada envio, então qualquer
 * número aqui é aproximação — e a média é a única que não engana
 * sistematicamente para um dos lados.
 *
 * Conta `contatos` esperas e não `contatos - 1`: a diferença é um intervalo em
 * cima de centenas, e errar para MAIS é o lado seguro numa estimativa que o
 * operador usa para decidir se a leva fecha no dia.
 */
export function duracaoEstimadaSegundos(contatos: number, faixa: IntervaloAleatorio): number {
  if (contatos <= 0) return 0;
  return Math.round(contatos * ((faixa.minSegundos + faixa.maxSegundos) / 2));
}

/** A leva cabe na janela em que alguém ainda está olhando o disparo? */
export function fechaNoDia(contatos: number, faixa: IntervaloAleatorio): boolean {
  return duracaoEstimadaSegundos(contatos, faixa) <= JANELA_DIARIA_SEGUNDOS;
}

/**
 * Quantos contatos cabem num dia nesta faixa — o teto que a tela sugere.
 *
 * Serve para o aviso dizer o que fazer, e não só que está errado: "1.200 num
 * dia; cabem ~250" é acionável, "não fecha no dia" não é.
 */
export function contatosQueCabemNoDia(faixa: IntervaloAleatorio): number {
  const media = (faixa.minSegundos + faixa.maxSegundos) / 2;
  return Math.max(Math.floor(JANELA_DIARIA_SEGUNDOS / media), 1);
}
