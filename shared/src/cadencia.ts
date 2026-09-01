import type { IntervaloAleatorio } from "./tipos.js";

/**
 * Quanto esperar entre um contato e o próximo, pelo tamanho da leva.
 *
 * O padrão anterior era `90–240 s` fixo para toda campanha, e era fixo demais
 * nos dois sentidos: uma leva de 8 pessoas esperava tanto quanto uma de 3 mil,
 * e a de 3 mil podia sortear 90 s tantas vezes seguidas quanto o acaso
 * quisesse.
 *
 * O que queima um número é VOLUME por dia, não o disparo em si — e volume
 * baixo não precisa de intervalo alto. Ninguém toma bloqueio mandando oito
 * mensagens. Por isso a faixa desliza com o tamanho da leva, de 10–30 s numa
 * lista mínima até 210–240 s numa de milhares.
 *
 * Nada aqui é obrigatório: são os números que a tela sugere e preenche, com os
 * campos seguindo editáveis.
 */

/** Piso e teto absolutos da cadência entre contatos, em segundos. */
export const CADENCIA_MINIMA_SEGUNDOS = 10;
export const CADENCIA_MAXIMA_SEGUNDOS = 240;

/**
 * A curva, em pontos de apoio — e não numa fórmula só.
 *
 * A primeira versão ia de 90 a 240 em linha reta, e o operador apontou o erro:
 * uma leva de menos de dez pessoas a 90 s por contato é espera pura, e não
 * protege de nada. Ninguém toma bloqueio mandando oito mensagens. O risco é
 * função do VOLUME, e volume baixo não precisa de intervalo alto.
 *
 * Pontos escolhidos, e não interpolação de ponta a ponta, porque a relação não
 * é reta: entre 10 e 200 contatos ela sobe rápido (é onde o disparo deixa de
 * parecer conversa e passa a parecer campanha), e daí para cima sobe devagar
 * até saturar.
 *
 * Teste manual é o caso do primeiro ponto e ele foi levado em conta: com dois
 * ou três contatos, 10 a 30 s deixa conferir se a mensagem saiu certa sem
 * esperar cinco minutos.
 *
 * TUDO AQUI É SUGESTÃO. A tela mantém os dois campos editáveis o tempo todo —
 * ver `ControleIntervalo`. Estes números decidem o que aparece preenchido, não
 * o que o operador pode fazer.
 */
const ANCORAS: { contatos: number; faixa: IntervaloAleatorio }[] = [
  { contatos: 10, faixa: { minSegundos: 10, maxSegundos: 30 } },
  { contatos: 50, faixa: { minSegundos: 45, maxSegundos: 75 } },
  { contatos: 200, faixa: { minSegundos: 90, maxSegundos: 120 } },
  { contatos: 1500, faixa: { minSegundos: 210, maxSegundos: 240 } },
];

/**
 * A partir de quantos contatos a leva já anda no teto.
 *
 * Não é um número medido — é a escolha de onde a curva satura. Acima disto o
 * intervalo não tem mais como crescer, e o que protege o número passa a ser
 * dividir a campanha em mais dias, não esperar mais entre um envio e outro.
 */
export const CONTATOS_PARA_CADENCIA_MAXIMA = ANCORAS[ANCORAS.length - 1].contatos;

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
  const primeira = ANCORAS[0];
  const ultima = ANCORAS[ANCORAS.length - 1];

  // Abaixo do primeiro ponto e acima do último a curva é plana: leva minúscula
  // não fica mais rápida que o piso, e leva gigante não passa do teto.
  if (contatos <= primeira.contatos) return { ...primeira.faixa };
  if (contatos >= ultima.contatos) return { ...ultima.faixa };

  for (let i = 1; i < ANCORAS.length; i += 1) {
    const fim = ANCORAS[i];
    if (contatos > fim.contatos) continue;

    const inicio = ANCORAS[i - 1];
    const fracao = (contatos - inicio.contatos) / (fim.contatos - inicio.contatos);
    return {
      minSegundos: entre(inicio.faixa.minSegundos, fim.faixa.minSegundos, fracao),
      maxSegundos: entre(inicio.faixa.maxSegundos, fim.faixa.maxSegundos, fracao),
    };
  }

  return { ...ultima.faixa };
}

/** Interpolação linear entre dois segundos inteiros. */
function entre(de: number, ate: number, fracao: number): number {
  return Math.round(de + (ate - de) * limitar(fracao, 0, 1));
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
