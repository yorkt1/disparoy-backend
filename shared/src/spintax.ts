import type { Spintax } from "./tipos.js";

/**
 * Spintax e variáveis do corpo da mensagem.
 *
 * Duas sintaxes convivem no mesmo texto:
 *   {{1}}, {{2}}      -> variáveis posicionais do template / colunas da planilha
 *   {{*promo*}}       -> variação salva: sorteia uma opção da lista "promo"
 *
 * O sorteio acontece por ENVIO (não por campanha), então dois contatos da mesma
 * campanha recebem textos diferentes — que é o ponto de existir spintax.
 */

const RE_VARIACAO = /\{\{\*([a-z0-9_]+)\*\}\}/gi;
const RE_VARIAVEL = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export interface ContextoRenderizacao {
  /** Variações disponíveis, indexadas pelo nome (slug). */
  variacoes: Record<string, string[]>;
  /** Valores das variáveis: { "1": "João", "nome": "João" }. */
  variaveis: Record<string, string>;
  /** Injetável nos testes para tornar o sorteio determinístico. */
  aleatorio?: () => number;
}

/** Nomes de variações referenciadas no texto, sem repetição. */
export function extrairVariacoes(texto: string): string[] {
  const nomes = new Set<string>();
  for (const m of texto.matchAll(RE_VARIACAO)) nomes.add(m[1].toLowerCase());
  return [...nomes];
}

/** Nomes de variáveis ({{1}}, {{nome}}) referenciadas no texto, sem repetição. */
export function extrairVariaveis(texto: string): string[] {
  const nomes = new Set<string>();
  // Remove as variações antes, senão {{*promo*}} não casaria mesmo — mas o
  // asterisco já impede o casamento de RE_VARIAVEL. Mantido por clareza.
  const semVariacoes = texto.replace(RE_VARIACAO, "");
  for (const m of semVariacoes.matchAll(RE_VARIAVEL)) nomes.add(m[1].toLowerCase());
  return [...nomes];
}

function sortear<T>(opcoes: T[], aleatorio: () => number): T {
  return opcoes[Math.floor(aleatorio() * opcoes.length) % opcoes.length];
}

/**
 * Resolve variações e variáveis, produzindo o texto final de UM envio.
 * Referências não resolvidas são mantidas literais — é melhor o operador ver
 * `{{cupom}}` na prévia do que um buraco silencioso no meio da mensagem.
 */
export function renderizarMensagem(texto: string, ctx: ContextoRenderizacao): string {
  const aleatorio = ctx.aleatorio ?? Math.random;

  const comVariacoes = texto.replace(RE_VARIACAO, (original, nome: string) => {
    const opcoes = ctx.variacoes[nome.toLowerCase()];
    if (!opcoes?.length) return original;
    return sortear(opcoes, aleatorio);
  });

  return comVariacoes.replace(RE_VARIAVEL, (original, nome: string) => {
    const valor = ctx.variaveis[nome.toLowerCase()];
    return valor === undefined ? original : valor;
  });
}

/** Índice { nome -> opções } a partir das variações salvas. */
export function indexarVariacoes(lista: Spintax[]): Record<string, string[]> {
  return Object.fromEntries(lista.map((s) => [s.nome.toLowerCase(), s.opcoes]));
}

export interface ProblemaSpintax {
  tipo: "variacao_inexistente" | "variacao_vazia";
  nome: string;
}

/** Aponta referências {{*x*}} que não têm lista salva correspondente. */
export function validarReferencias(texto: string, disponiveis: Spintax[]): ProblemaSpintax[] {
  const indice = indexarVariacoes(disponiveis);
  return extrairVariacoes(texto).flatMap<ProblemaSpintax>((nome) => {
    const opcoes = indice[nome];
    if (!opcoes) return [{ tipo: "variacao_inexistente", nome }];
    if (opcoes.length === 0) return [{ tipo: "variacao_vazia", nome }];
    return [];
  });
}

/**
 * Quantas mensagens distintas o texto consegue gerar — o produto do número de
 * opções de cada variação referenciada. Serve de aviso quando uma campanha
 * grande tem pouca variedade real.
 */
export function combinacoesPossiveis(texto: string, disponiveis: Spintax[]): number {
  const indice = indexarVariacoes(disponiveis);
  return extrairVariacoes(texto).reduce((total, nome) => {
    const n = indice[nome]?.length ?? 1;
    return total * Math.max(n, 1);
  }, 1);
}
