import type { CategoriaFalha, CodigoFalha } from "./whatsapp/falhas.js";
import { FALHAS } from "./whatsapp/falhas.js";

/**
 * A visão acumulada das falhas — o que fecha o ciclo da taxonomia.
 *
 * `falhas.ts` classifica uma ocorrência por vez, no instante do envio. Só que a
 * regra que classifica é um punhado de regex escrito contra o que a Evolution
 * respondia ONTEM, e ela não tem catálogo de erro publicado: o texto muda de
 * versão para versão. Sem olhar o acumulado, uma regra que parou de casar
 * continua parecendo certa para sempre — as falhas só vão silenciosamente para
 * `desconhecido`.
 *
 * Por isso o que interessa aqui não é a contagem bonita, é a coluna de texto
 * bruto: é dela que sai o regex da regra seguinte.
 */

export interface ResumoFalha {
  /** Código da taxonomia, ou `nao_registrado` para linhas anteriores a ela. */
  codigo: string;
  /** Nulo nas linhas antigas, gravadas antes de a coluna existir. */
  categoria: CategoriaFalha | null;
  total: number;
  /** Quantos canais distintos. Um só sugere aparelho; vários sugerem gateway. */
  canais: number;
  campanhas: number;
  primeiraEm: string;
  ultimaEm: string;
}

export interface AmostraFalha {
  /** Texto do gateway com número e id trocados por marcador, para agrupar. */
  padrao: string;
  /** Uma ocorrência intacta — é ela que serve para escrever o regex novo. */
  exemplo: string;
  codigo: string;
  categoria: CategoriaFalha | null;
  total: number;
  ultimaEm: string;
}

export interface Diagnostico {
  /** Início da janela analisada, em ISO. */
  desde: string;
  falhas: ResumoFalha[];
  amostras: AmostraFalha[];
}

/**
 * Códigos que significam "o sistema não soube dizer o que foi".
 *
 * `nao_registrado` é histórico: linha gravada antes de a coluna existir.
 * `desconhecido` é o presente: o classificador rodou e não casou com nada.
 * Os dois pedem a mesma ação — ler o texto bruto e escrever a regra —, então
 * a tela os trata junto.
 */
export const CODIGOS_SEM_CLASSIFICACAO = ["desconhecido", "nao_registrado"] as const;

export function semClassificacao(codigo: string): boolean {
  return (CODIGOS_SEM_CLASSIFICACAO as readonly string[]).includes(codigo);
}

/**
 * O código veio do banco como `string`, não como `CodigoFalha`.
 *
 * Um deploy revertido, ou uma linha gravada por uma versão mais nova do worker,
 * deixa no banco código que esta build não conhece. Renderizar isso como se
 * fosse conhecido daria `undefined` no meio da tela; melhor detectar e mostrar
 * o código cru, que ao menos é pesquisável.
 */
export function ehCodigoConhecido(codigo: string): codigo is CodigoFalha {
  return Object.prototype.hasOwnProperty.call(FALHAS, codigo);
}

/**
 * Quantas falhas estão sem classificação na janela.
 *
 * É o número que decide se vale mexer nas regras: cinco desconhecidas em mil é
 * ruído da vida real, quatrocentas em mil significam que uma regra quebrou.
 */
export function totalSemClassificacao(falhas: ResumoFalha[]): number {
  return falhas.filter((f) => semClassificacao(f.codigo)).reduce((s, f) => s + f.total, 0);
}

export function totalDeFalhas(falhas: ResumoFalha[]): number {
  return falhas.reduce((s, f) => s + f.total, 0);
}

/**
 * Abaixo disto a porcentagem não significa nada.
 *
 * Com uma falha só, "0% de cobertura" é aritmeticamente certo e informativamente
 * falso: uma única linha vira um alarme vermelho do tamanho de uma regra
 * quebrada. Vinte é onde a proporção começa a dizer algo sobre a tendência, em
 * vez de sobre o acaso.
 */
export const AMOSTRA_MINIMA_COBERTURA = 20;

export type NivelCobertura = "ok" | "atencao" | "amostra_pequena";

/**
 * Quão preocupante é a cobertura da taxonomia.
 *
 * Separado do cálculo do percentual porque a decisão "isto merece alarme?"
 * depende do TAMANHO da amostra, não só da proporção — e essa é a parte que a
 * tela errava.
 */
export function nivelDaCobertura(total: number, semClassificacao: number): NivelCobertura {
  if (total < AMOSTRA_MINIMA_COBERTURA) return "amostra_pequena";
  return semClassificacao / total >= 0.1 ? "atencao" : "ok";
}
