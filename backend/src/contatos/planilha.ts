
import * as XLSX from "xlsx";
import { LIMITES } from "@disparoy/dominio";
import { detectarColunaTelefone, type LinhasPlanilha } from "@disparoy/dominio";

/**
 * Leitura de planilhas de contatos (CSV / XLS / XLSX).
 *
 * Só roda no servidor: o arquivo vem de upload, então tamanho, número de
 * linhas e conteúdo das células são tratados como não confiáveis. A montagem
 * dos contatos em si fica em `contatos.ts`, que é puro e roda dos dois lados.
 */

export interface PlanilhaLida extends LinhasPlanilha {
  /** Coluna detectada como telefone, ou a primeira caso nada seja reconhecido. */
  colunaTelefone: string;
}

export class ErroPlanilha extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroPlanilha";
  }
}

/** Converte célula de qualquer tipo em string limpa (evita "1.1e+10"). */
function celulaParaTexto(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "number") {
    return Number.isInteger(valor) ? valor.toFixed(0) : String(valor);
  }
  if (valor instanceof Date) return valor.toISOString();
  return String(valor).trim();
}

export function lerPlanilha(buffer: ArrayBuffer | Uint8Array, nomeArquivo = ""): PlanilhaLida {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength === 0) throw new ErroPlanilha("Arquivo vazio.");
  if (bytes.byteLength > LIMITES.maxBytesPlanilha) {
    throw new ErroPlanilha(
      `Arquivo acima do limite de ${LIMITES.maxBytesPlanilha / 1024 / 1024} MB.`,
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: true, raw: false });
  } catch {
    throw new ErroPlanilha(`Não foi possível ler "${nomeArquivo || "o arquivo"}".`);
  }

  const primeiraAba = workbook.SheetNames[0];
  if (!primeiraAba) throw new ErroPlanilha("A planilha não tem nenhuma aba.");

  const matriz = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[primeiraAba], {
    header: 1,
    blankrows: false,
    defval: "",
  });
  if (matriz.length < 2) {
    throw new ErroPlanilha("A planilha precisa de um cabeçalho e ao menos uma linha de dados.");
  }

  const cabecalho = (matriz[0] as unknown[]).map(celulaParaTexto);
  // Cabeçalhos vazios ou repetidos quebrariam o mapa linha->coluna.
  const usados = new Set<string>();
  const colunas = cabecalho.map((titulo, i) => {
    let nome = titulo || `coluna_${i + 1}`;
    while (usados.has(nome)) nome = `${nome}_${i + 1}`;
    usados.add(nome);
    return nome;
  });

  const corpo = matriz.slice(1);
  const truncada = corpo.length > LIMITES.maxContatosPorImportacao;
  const usadas = truncada ? corpo.slice(0, LIMITES.maxContatosPorImportacao) : corpo;

  const linhas = usadas.map((linha) => {
    const registro: Record<string, string> = {};
    colunas.forEach((coluna, i) => {
      registro[coluna] = celulaParaTexto((linha as unknown[])[i]);
    });
    return registro;
  });

  return {
    colunas,
    colunaTelefone: detectarColunaTelefone(colunas),
    linhas,
    totalLinhas: corpo.length,
    truncada,
  };
}

/**
 * Planilha-modelo do botão "Baixar modelo".
 *
 * **nome e numero** — é o formato principal e o que a maioria das listas tem.
 * Colunas extras continuam funcionando (viram variáveis `{{1}}`, `{{2}}`…),
 * mas não entram no modelo: quem precisa delas já sabe que pode acrescentar,
 * e quem não precisa copiava três colunas vazias sem saber por quê.
 *
 * Traz só o cabeçalho e uma linha de instrução — nada de contatos inventados,
 * que poderiam ser importados por engano junto com a base real.
 */
/**
 * Planilha com os contatos extraídos de um canal.
 *
 * Mesmo cabeçalho do modelo de importação (`nome`, `numero`) de propósito: o
 * arquivo que sai daqui precisa poder voltar por cima sem ninguém renomear
 * coluna nenhuma — extrair, editar no Excel e reimportar é o fluxo inteiro.
 *
 * O telefone vai como TEXTO. Em formato numérico o Excel transforma
 * `+5548991237324` em notação científica e o número volta destruído da
 * importação — é o erro clássico deste tipo de planilha.
 */
export function gerarPlanilhaContatos(
  contatos: { nome: string; telefone: string }[],
): Uint8Array {
  const aba = XLSX.utils.aoa_to_sheet([
    ["nome", "numero"],
    ...contatos.map((c) => [c.nome, c.telefone]),
  ]);

  // `s` (string) em toda a coluna do número, inclusive nas linhas que só têm
  // dígitos e que o XLSX classificaria como número sozinho.
  for (let linha = 1; linha <= contatos.length; linha++) {
    const ref = XLSX.utils.encode_cell({ r: linha, c: 1 });
    if (aba[ref]) aba[ref].t = "s";
  }

  aba["!cols"] = [{ wch: 38 }, { wch: 20 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, aba, "contatos");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export function gerarPlanilhaModelo(): Uint8Array {
  const dados = [
    ["nome", "numero"],
    [
      "Apague esta linha antes de importar",
      "11987654321, (11) 98765-4321 ou +5511987654321",
    ],
    [
      "Colunas a mais viram variáveis {{1}}, {{2}}… no texto da campanha",
      "",
    ],
  ];
  const aba = XLSX.utils.aoa_to_sheet(dados);
  aba["!cols"] = [{ wch: 62 }, { wch: 46 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, aba, "contatos");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
