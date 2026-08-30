/**
 * O relatório da campanha em CSV — uma linha por contato.
 *
 * O formato das colunas é fixo e não é escolha nossa: é o que o cliente já
 * abre no Excel e já importa em outras ferramentas. Mexer na ordem, no
 * separador ou no nome de uma coluna quebra a planilha de alguém que não vai
 * saber por quê, então mudança aqui é mudança de contrato.
 *
 * Puro de propósito — nada de Supabase, nada de HTTP. O serviço monta as
 * linhas, esta camada decide como elas viram texto, e o teste consegue exercer
 * escapamento e formatação sem banco nenhum.
 */

import type { TipoResposta } from "@disparoy/dominio";

const FUSO = "America/Sao_Paulo";

/** Quantas respostas cabem na planilha. Além disso, o relatório não é o lugar. */
export const MAX_RESPOSTAS = 5;

/** Colunas de variável, fixas para que o cabeçalho não mude entre campanhas. */
export const MAX_VARIAVEIS = 7;

/*
 * `TipoResposta` mora no domínio, não aqui: a mesma união classifica a resposta
 * no CSV e no painel, e duas cópias seriam duas listas que divergem no dia em
 * que o WhatsApp ganhar mais um tipo de mensagem.
 */
export type { TipoResposta } from "@disparoy/dominio";

export interface RespostaDoContato {
  texto: string;
  tipo: TipoResposta;
}

export interface LinhaRelatorio {
  /** ISO do primeiro envio a este contato. `null` enquanto nada saiu. */
  envio: string | null;
  canalNome: string | null;
  /** E.164 do canal, com o `+`. Sai sem ele na planilha. */
  canalNumero: string | null;
  nome: string | null;
  telefone: string;
  /** O CONTATO leu a nossa mensagem — nada a ver com o painel ler a resposta. */
  lida: boolean;
  /** Em ordem de chegada. Mais que `MAX_RESPOSTAS` são truncadas. */
  respostas: RespostaDoContato[];
  status: string;
  motivo: string | null;
  variaveis: Record<string, string>;
}

const CABECALHO = [
  "envio",
  "conexao",
  "nome",
  "whatsapp",
  "lida",
  ...faixa("resposta", MAX_RESPOSTAS),
  "status",
  ...faixa("variavel", MAX_VARIAVEIS),
];

function faixa(prefixo: string, quantas: number): string[] {
  return Array.from({ length: quantas }, (_, i) => `${prefixo}_${i + 1}`);
}

/**
 * Monta o arquivo inteiro.
 *
 * `chavesVariaveis` vem de fora e é a MESMA para todas as linhas: cada contato
 * pode ter um conjunto diferente de colunas extras na planilha original, e
 * resolver a ordem por linha colocaria a cidade de um na coluna do CPF do
 * outro. O serviço calcula a união uma vez e passa aqui.
 *
 * BOM na frente porque o Excel em português assume ANSI num arquivo `.csv` sem
 * ele — e sem BOM toda resposta com emoji ou acento (que é quase toda) vira
 * caractere quebrado na tela de quem pediu o relatório.
 */
export function montarCsv(linhas: LinhaRelatorio[], chavesVariaveis: string[]): string {
  const corpo = linhas.map((linha) => montarLinha(linha, chavesVariaveis));
  // CRLF: é o que o Excel espera, e o que os importadores de CSV toleram sem
  // exceção. LF sozinho funciona na maioria, mas não em todos.
  //
  // O BOM vai escrito como `\uFEFF`, e não como o caractere
  // literal: literal ele é invisível no editor, some numa cópia descuidada e
  // o Excel volta a abrir "João" como "JoÃ£o" sem que o diff mostre o que
  // mudou.
  return `\uFEFF${[CABECALHO.join(";"), ...corpo].join("\r\n")}\r\n`;
}

/**
 * Quais colunas extras da planilha original entram, e em que ordem.
 *
 * Ordem alfabética, e não ordem de aparecimento: contatos importados em
 * arquivos diferentes trazem as chaves em ordens diferentes, e "a ordem do
 * primeiro contato" faria a mesma campanha exportar colunas trocadas conforme
 * quem estivesse no topo da lista.
 *
 * O cabeçalho continua sendo `variavel_1..7` — o nome real da coluna não vai
 * para lá de propósito: o arquivo é consumido por importadores que esperam
 * cabeçalho fixo, e um header que muda de campanha para campanha quebraria
 * todos eles.
 */
export function chavesDeVariaveis(linhas: LinhaRelatorio[]): string[] {
  const chaves = new Set<string>();
  for (const linha of linhas) {
    for (const chave of Object.keys(linha.variaveis)) chaves.add(chave);
  }
  return [...chaves].sort((a, b) => a.localeCompare(b, "pt-BR")).slice(0, MAX_VARIAVEIS);
}

function montarLinha(linha: LinhaRelatorio, chavesVariaveis: string[]): string {
  const respostas = Array.from({ length: MAX_RESPOSTAS }, (_, i) =>
    linha.respostas[i] ? descreverResposta(linha.respostas[i]) : "",
  );

  const variaveis = Array.from(
    { length: MAX_VARIAVEIS },
    (_, i) => linha.variaveis[chavesVariaveis[i] ?? ""] ?? "",
  );

  return [
    formatarDataHoraCompleta(linha.envio),
    descreverConexao(linha.canalNome, linha.canalNumero),
    linha.nome ?? "",
    semMais(linha.telefone),
    linha.lida ? "Lida" : "Não lida",
    ...respostas,
    descreverStatus(linha.status, linha.motivo),
    ...variaveis,
  ]
    .map(escapar)
    .join(";");
}

/**
 * `Antonio Carlos [554791169041]` — o nome sozinho não basta.
 *
 * Duas conexões podem ter o mesmo nome (o operador batiza os chips de
 * "Comercial 1" e "Comercial 2" e troca o número de um deles), e quando um
 * disparo queima um chip a pergunta que se faz olhando a planilha é "qual
 * número mandou isto?".
 */
export function descreverConexao(nome: string | null, numero: string | null): string {
  const rotulo = nome?.trim() || "Canal removido";
  return numero ? `${rotulo} [${semMais(numero)}]` : rotulo;
}

/**
 * Mídia vira rótulo em vez de célula vazia.
 *
 * Uma coluna em branco na planilha significa "não respondeu", e áudio é a
 * resposta mais comum de campanha em massa. Sem isto, uma pessoa que mandou
 * três áudios aparece idêntica a quem ignorou a mensagem.
 */
export function descreverResposta(resposta: RespostaDoContato): string {
  const rotulos: Record<TipoResposta, string> = {
    texto: "",
    imagem: "[imagem]",
    audio: "[áudio]",
    video: "[vídeo]",
    documento: "[documento]",
    figurinha: "[figurinha]",
    outro: "[mensagem]",
  };

  const rotulo = rotulos[resposta.tipo];
  const texto = resposta.texto.trim();
  if (!rotulo) return texto;
  // Legenda junto: quem manda foto com "pode me ligar" embaixo respondeu
  // "pode me ligar", e essa parte é a que o operador precisa ler.
  return texto ? `${rotulo} ${texto}` : rotulo;
}

/**
 * O status do contato em português de operador.
 *
 * `motivo` entra só na falha, e entra na MESMA coluna em vez de virar uma
 * coluna nova: quem lê a planilha filtra por "status diferente de Enviado com
 * sucesso" e precisa que o motivo esteja ao lado, não trinta colunas depois.
 */
export function descreverStatus(status: string, motivo: string | null): string {
  const limpo = motivo?.trim();

  switch (status) {
    case "concluido":
      return "Enviado com sucesso";
    case "falhou":
      return limpo ? `Falhou: ${limpo}` : "Falhou";
    case "invalido":
      return limpo ? `Número inválido: ${limpo}` : "Número inválido";
    case "bloqueado":
      return limpo ? `Bloqueado: ${limpo}` : "Bloqueado";
    case "enviando":
      return "Enviando";
    case "validando":
      return "Validando número";
    default:
      return "Pendente";
  }
}

/** `+554791169041` -> `554791169041`. O WhatsApp exibe assim. */
function semMais(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** `15/08/2026 10:01:39`, no fuso de quem operou o disparo. */
export function formatarDataHoraCompleta(iso: string | null): string {
  if (!iso) return "";
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return "";

  // `formatToParts` e não `format`: o pt-BR insere vírgula entre data e hora
  // ("15/08/2026, 10:01:39"), e a vírgula obrigaria a aspear toda a coluna.
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(data)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}:${partes.second}`;
}

/**
 * Um campo pronto para o CSV.
 *
 * Duas coisas acontecem aqui, e as duas por causa de texto que o CONTATO
 * escreveu — ou seja, texto que ninguém validou:
 *
 *  - **Quebra de linha vira espaço.** Aspas resolveriam para o Excel, mas o
 *    relatório é lido também por script e por olho humano no terminal, e um
 *    registro partido em cinco linhas destrói os dois. Uma resposta de três
 *    parágrafos continua legível numa linha só.
 *  - **Fórmula é neutralizada.** `=`, `+`, `-` e `@` no início de célula fazem
 *    o Excel INTERPRETAR o conteúdo; uma resposta começando com `=cmd` é uma
 *    injeção conhecida, e a aspa simples na frente é a defesa padrão dela.
 */
export function escapar(valor: string): string {
  let v = valor.replace(/[\r\n]+/g, " ").trim();
  if (/^[=+\-@\t]/.test(v)) v = `'${v}`;
  if (/[";]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}
