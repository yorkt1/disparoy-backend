import { COLUNAS_NOME, COLUNAS_TELEFONE, PALAVRAS_OPT_OUT } from "./config.js";
import { descreverMotivo, normalizarTelefone, separarNumerosColados } from "./phone.js";
import { slugify } from "./formato.js";

/**
 * Preparação de contatos a partir de linhas já lidas.
 *
 * Módulo puro de propósito: roda no servidor (depois do parse da planilha) e
 * também no cliente, para o mapeamento de colunas recalcular na hora sem
 * reenviar o arquivo. Nada de `xlsx` aqui — esse peso fica em `planilha.ts`.
 */

export interface LinhasPlanilha {
  colunas: string[];
  linhas: Record<string, string>[];
  totalLinhas: number;
  truncada: boolean;
}

/** { "1": "nome" } — variável do template -> coluna da planilha. */
export type MapeamentoVariaveis = Record<string, string>;

/** Contato pronto para virar linha em `contatos`. */
export interface ContatoImportado {
  telefone: string; // E.164; vazio quando inválido
  telefoneOriginal: string;
  nome: string | null;
  valido: boolean;
  motivoInvalido?: string;
  variaveis: Record<string, string>;
}

export interface ResultadoImportacao {
  contatos: ContatoImportado[];
  validos: number;
  invalidos: number;
  duplicados: number;
}

/** Escolhe a coluna do telefone por nome; cai na primeira se nada bater. */
export function detectarColunaTelefone(colunas: string[]): string {
  const exata = colunas.find((c) => COLUNAS_TELEFONE.includes(slugify(c).replace(/_/g, "")));
  if (exata) return exata;
  const parcial = colunas.find((c) =>
    COLUNAS_TELEFONE.some((alvo) => slugify(c).includes(slugify(alvo))),
  );
  return parcial ?? colunas[0] ?? "";
}

/** Escolhe a coluna do nome; devolve vazio quando não há candidata clara. */
export function detectarColunaNome(colunas: string[], colunaTelefone: string): string {
  const candidatas = colunas.filter((c) => c !== colunaTelefone);
  const exata = candidatas.find((c) => COLUNAS_NOME.includes(slugify(c).replace(/_/g, "")));
  return exata ?? "";
}

/**
 * O mapeamento que vale quando ninguém escolheu nenhum: `{{1}}` é o NOME.
 *
 * Sem isto o painel prometia uma coisa e entregava outra. A tela de público
 * diz "uma coluna de nome é reconhecida sozinha, e as demais viram variáveis",
 * o editor tem um botão que insere `{{1}}` — e `montarContatos` era chamado
 * sem mapeamento nenhum, então `variaveis` saía `{}` e "Olá {{1}}" era
 * disparado com as chaves literais para a lista inteira.
 *
 * `{{1}}` é o nome porque é o que o operador escreve quando pensa "primeira
 * variável": a coluna de nome é a primeira coisa que qualquer planilha de
 * disparo tem. As colunas extras seguem a partir de `{{2}}`, na ordem da
 * planilha, e ganham TAMBÉM o nome delas (`{{cidade}}`) — posicional para quem
 * conta, nomeado para quem lê. Planilha sem coluna de nome começa em `{{1}}`
 * na primeira coluna extra, senão `{{1}}` ficaria eternamente vazio.
 */
export function mapeamentoPadrao(
  colunas: string[],
  colunaTelefone: string,
  colunaNome = "",
): MapeamentoVariaveis {
  const mapa: MapeamentoVariaveis = {};
  let posicao = 1;

  if (colunaNome) {
    mapa["1"] = colunaNome;
    mapa.nome = colunaNome;
    posicao = 2;
  }

  for (const coluna of colunas) {
    if (!coluna || coluna === colunaTelefone || coluna === colunaNome) continue;
    mapa[String(posicao)] = coluna;
    const slug = slugify(coluna);
    // `!(slug in mapa)` protege a posicional: uma coluna chamada "2" viraria
    // slug "2" e sobrescreveria o `{{2}}` de outra coluna, calado.
    if (slug && !/^[0-9]+$/.test(slug) && !(slug in mapa)) mapa[slug] = coluna;
    posicao += 1;
  }

  return mapa;
}

/**
 * Normaliza os números e anexa nome e variáveis mapeadas.
 *
 * Duplicatas (mesmo E.164) são descartadas mantendo a primeira ocorrência;
 * inválidos ficam na lista, marcados, para o operador poder revisar antes de
 * importar em vez de descobrir o problema depois.
 *
 * Sem `mapeamento` explícito vale o `mapeamentoPadrao` — e é ele que faz
 * `{{1}}` valer o nome do contato. Passar `{}` de propósito não existe: quem
 * quer texto sem variável simplesmente não escreve `{{1}}`.
 */
export function montarContatos(
  linhas: Record<string, string>[],
  colunaTelefone: string,
  opcoes: {
    colunaNome?: string;
    mapeamento?: MapeamentoVariaveis;
    /** Ordem real das colunas. Sem ela, a da primeira linha lida. */
    colunas?: string[];
  } = {},
): ResultadoImportacao {
  const { colunaNome = "" } = opcoes;
  const mapeamento =
    opcoes.mapeamento ??
    mapeamentoPadrao(opcoes.colunas ?? Object.keys(linhas[0] ?? {}), colunaTelefone, colunaNome);
  const vistos = new Set<string>();
  const contatos: ContatoImportado[] = [];
  let validos = 0;
  let invalidos = 0;
  let duplicados = 0;

  for (const linha of linhas) {
    const original = linha[colunaTelefone] ?? "";
    const nome = colunaNome ? (linha[colunaNome] ?? "").trim() || null : null;

    const variaveis: Record<string, string> = {};
    for (const [variavel, coluna] of Object.entries(mapeamento)) {
      if (coluna && linha[coluna] !== undefined) variaveis[variavel] = linha[coluna];
    }

    const r = normalizarTelefone(original);
    if (!r.valido) {
      invalidos += 1;
      contatos.push({
        telefone: "",
        telefoneOriginal: original,
        nome,
        valido: false,
        motivoInvalido: descreverMotivo(r.motivo),
        variaveis,
      });
      continue;
    }
    if (vistos.has(r.e164)) {
      duplicados += 1;
      continue;
    }
    vistos.add(r.e164);
    validos += 1;
    contatos.push({
      telefone: r.e164,
      telefoneOriginal: original,
      nome,
      valido: true,
      variaveis,
    });
  }

  return { contatos, validos, invalidos, duplicados };
}

/** Caminho da colagem manual: um número por linha, vírgula ou ponto e vírgula. */
export function montarContatosColados(texto: string): ResultadoImportacao {
  const linhas = separarNumerosColados(texto).map((numero) => ({ numero }));
  return montarContatos(linhas, "numero");
}

/**
 * Detecta pedido de saída no texto recebido do contato.
 *
 * Compara sobre o texto normalizado (sem acento, minúsculo, sem pontuação) e
 * exige que a mensagem seja CURTA: "quero parar de receber" é opt-out, mas
 * "não vou parar de recomendar vocês" não pode ser — casar palavra solta no
 * meio de uma frase longa descadastraria quem estava elogiando.
 */
export function ehPedidoDeSaida(texto: string): boolean {
  const normalizado = texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizado) return false;
  if (normalizado.split(" ").length > 5) return false;

  return PALAVRAS_OPT_OUT.some(
    (palavra) => normalizado === palavra || normalizado.includes(palavra),
  );
}
