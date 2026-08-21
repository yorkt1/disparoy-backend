
import * as XLSX from "xlsx";
import { LIMITES } from "@disparoy/dominio";
import { detectarColunaTelefone, type LinhasPlanilha } from "@disparoy/dominio";

/**
 * Leitura de planilhas de contatos (CSV / XLS / XLSX).
 *
 * Só roda no servidor: o arquivo vem de upload, então tamanho, número de
 * linhas e conteúdo das células são tratados como não confiáveis. A montagem
 * dos contatos em si fica em `contatos.ts`, que é puro e roda dos dois lados.
 *
 * ---------------------------------------------------------------------------
 * Por que o `xlsx` continua aqui, com dois CVEs altos em aberto
 * ---------------------------------------------------------------------------
 *
 * `npm audit` acusa GHSA-4r6h-8v6p-xvw6 (prototype pollution) e
 * GHSA-5pgg-2g8v-p4x9 (ReDoS) na 0.18.5. O upstream corrigiu os dois, mas
 * parou de publicar no npm na 0.18.5 — a versão com correção só existe em
 * `cdn.sheetjs.com`, fora do registro.
 *
 * Trocar de biblioteca foi avaliado e recusado: `EXTENSOES_PLANILHA` aceita
 * `.xls`, o BIFF binário do Excel antigo, e nenhuma alternativa mantida
 * (`exceljs`, `read-excel-file`) lê esse formato. Sair do `xlsx` significaria
 * recusar o arquivo que metade das listas de cliente ainda é — regressão de
 * produto para fechar um audit. Some-se que o `xlsx` não tem dependência
 * nenhuma e o `exceljs` traz uma árvore inteira: o saldo de superfície a
 * auditar poderia até piorar.
 *
 * O que sobra é blindar a entrada, e é o que este arquivo faz:
 *
 *  - teto de bytes ANTES do parse (`maxBytesPlanilha`, e o multer no
 *    controller já recusa antes de chegar aqui);
 *  - teto de LINHAS e COLUNAS aplicado sobre a faixa declarada, antes de
 *    materializar célula nenhuma;
 *  - cabeçalho que se chame `__proto__`/`constructor`/`prototype` é renomeado,
 *    e cada linha vira objeto sem protótipo;
 *  - varredura do `Object.prototype` em volta do parse, que desfaz e denuncia
 *    a poluição caso o CVE seja disparado de verdade.
 *
 * O que NÃO dá para fazer daqui é o timeout: `XLSX.read` é síncrono e segura o
 * event loop inteiro, e não existe como interromper isso sem tirá-lo do
 * processo (worker thread). O teto de bytes limita o dano; a correção de
 * verdade para o ReDoS é subir a versão.
 */

/**
 * Teto de colunas lidas.
 *
 * Coluna extra vira variável `{{1}}`, `{{2}}`… no texto da campanha, e ninguém
 * mapeia cento e vinte. O número existe para o outro caso: uma planilha pode
 * DECLARAR a faixa `A1:XFD1048576` sem ter dado nenhum lá, e a conversão
 * percorre a faixa declarada, não o conteúdo — dezessete bilhões de células a
 * visitar derrubam a API por memória, com um arquivo de poucos kB.
 */
const MAX_COLUNAS = 120;

/**
 * Recorta a faixa declarada da aba aos tetos, antes de converter.
 *
 * Devolve também quantas linhas de dado a aba DIZ ter, que é o número honesto
 * a mostrar quando o corte acontece.
 */
function faixaLimitada(aba: XLSX.WorkSheet): { faixa: XLSX.Range; linhasDeclaradas: number } | null {
  const ref = aba["!ref"];
  if (typeof ref !== "string") return null;

  const faixa = XLSX.utils.decode_range(ref);
  const linhasDeclaradas = Math.max(0, faixa.e.r - faixa.s.r);

  // +1 porque a primeira linha da faixa é o cabeçalho, e mais uma para que o
  // corte seja DETECTÁVEL: sem ela o corpo pararia exatamente no teto e
  // `truncada` diria que não cortou nada.
  const maxLinhas = LIMITES.maxContatosPorImportacao + 2;

  return {
    faixa: {
      s: faixa.s,
      e: {
        r: Math.min(faixa.e.r, faixa.s.r + maxLinhas - 1),
        c: Math.min(faixa.e.c, faixa.s.c + MAX_COLUNAS - 1),
      },
    },
    linhasDeclaradas,
  };
}

/** Chaves que, vindas de um cabeçalho, mexeriam na cadeia de protótipos. */
const CABECALHOS_PROIBIDOS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Roda o parse vigiando o `Object.prototype`.
 *
 * É a única defesa possível daqui contra GHSA-4r6h-8v6p-xvw6: a poluição
 * acontece DENTRO do `XLSX.read`, com um arquivo que planta a chave, e nada
 * neste arquivo consegue impedi-la. O que dá para fazer é não deixá-la
 * silenciosa — que é o que torna prototype pollution perigosa. Propriedade nova
 * no `Object.prototype` é desfeita na hora e o arquivo é recusado, em vez de
 * seguir para dentro de um processo que passa a mentir em todo `for..in` e em
 * todo objeto sem a chave.
 */
function lerVigiando(bytes: Uint8Array): XLSX.WorkBook {
  const antes = new Set(Object.getOwnPropertyNames(Object.prototype));

  let workbook: XLSX.WorkBook | null = null;
  let falha: unknown = null;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: true, raw: false });
  } catch (e) {
    falha = e;
  }

  // A limpeza acontece mesmo quando o parse estourou: o arquivo pode plantar a
  // chave e quebrar em seguida, e aí a sujeira ficaria no processo para sempre.
  const plantadas = Object.getOwnPropertyNames(Object.prototype).filter((c) => !antes.has(c));
  for (const chave of plantadas) {
    delete (Object.prototype as Record<string, unknown>)[chave];
  }

  if (plantadas.length > 0) {
    // Vem antes de `falha` de propósito: um arquivo que poluiu E quebrou é
    // hostil, e é isso que precisa aparecer no log, não "planilha inválida".
    throw new ErroPlanilha(
      `O arquivo tentou alterar o funcionamento do sistema (${plantadas.join(", ")}) ` +
        "e foi recusado.",
    );
  }
  if (falha !== null) throw falha;

  return workbook as XLSX.WorkBook;
}

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
    workbook = lerVigiando(bytes);
  } catch (e) {
    // A recusa por poluição precisa chegar à tela com o motivo dela; só o
    // formato ilegível vira a mensagem genérica.
    if (e instanceof ErroPlanilha) throw e;
    throw new ErroPlanilha(`Não foi possível ler "${nomeArquivo || "o arquivo"}".`);
  }

  const primeiraAba = workbook.SheetNames[0];
  if (!primeiraAba) throw new ErroPlanilha("A planilha não tem nenhuma aba.");

  const recorte = faixaLimitada(workbook.Sheets[primeiraAba]);
  if (!recorte) throw new ErroPlanilha("A planilha está vazia.");

  const matriz = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[primeiraAba], {
    header: 1,
    blankrows: false,
    defval: "",
    // Sem a faixa recortada, a conversão percorre o que o arquivo DECLARA ter,
    // não o que ele tem.
    range: recorte.faixa,
  });
  if (matriz.length < 2) {
    throw new ErroPlanilha("A planilha precisa de um cabeçalho e ao menos uma linha de dados.");
  }

  const cabecalho = (matriz[0] as unknown[]).map(celulaParaTexto);
  // Cabeçalhos vazios ou repetidos quebrariam o mapa linha->coluna.
  const usados = new Set<string>();
  const colunas = cabecalho.map((titulo, i) => {
    // `__proto__` como título de coluna vira chave de objeto três linhas
    // abaixo, e a lista de colunas ainda volta para o navegador para o
    // mapeamento — o nome atravessa dois lados antes de virar propriedade.
    const seguro = CABECALHOS_PROIBIDOS.has(titulo) ? "" : titulo;
    let nome = seguro || `coluna_${i + 1}`;
    while (usados.has(nome)) nome = `${nome}_${i + 1}`;
    usados.add(nome);
    return nome;
  });

  const corpo = matriz.slice(1);
  const truncada = corpo.length > LIMITES.maxContatosPorImportacao;
  const usadas = truncada ? corpo.slice(0, LIMITES.maxContatosPorImportacao) : corpo;

  const linhas = usadas.map((linha) => {
    // Sem protótipo: mesmo com o cabeçalho já filtrado, uma chave herdada aqui
    // faria `registro.constructor` responder sem que a planilha tivesse essa
    // coluna, e quem monta o contato leria valor que ninguém importou.
    const registro = Object.create(null) as Record<string, string>;
    colunas.forEach((coluna, i) => {
      registro[coluna] = celulaParaTexto((linha as unknown[])[i]);
    });
    return registro;
  });

  return {
    colunas,
    colunaTelefone: detectarColunaTelefone(colunas),
    linhas,
    // Quando o corte foi pelo teto de linhas, o total honesto é o que a aba
    // declara — `corpo` para no teto e diria a menos.
    totalLinhas: truncada ? Math.max(corpo.length, recorte.linhasDeclaradas) : corpo.length,
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
 * Desarma célula que um programa de planilha leria como fórmula.
 *
 * O nome que sai daqui é o `pushName` da agenda do WhatsApp: quem escolhe é a
 * pessoa do outro lado, e ela pode se chamar `=cmd|'/c calc'!A1`. O `.xlsx`
 * que este arquivo escreve grava tudo como texto (`t: "s"`), e o Excel não
 * avalia texto — mas o fluxo declarado desta planilha é "extrair, editar no
 * Excel e reimportar", e um "Salvar como CSV" no meio do caminho transforma a
 * mesma célula em fórmula viva na máquina do operador. O apóstrofo à frente é
 * o que o Excel entende como "isto é texto, não calcule".
 *
 * `+` e `-` só são neutralizados quando NÃO vêm seguidos de dígito: no WhatsApp
 * o nome de um contato não salvo é o próprio número, e `+5548999...` é o caso
 * comum, não o ataque. Prefixar todos eles sujaria a coluna inteira e voltaria
 * com o apóstrofo colado no número na reimportação.
 */
export function neutralizarFormula(valor: string): string {
  if (/^[=@\t\r\n]/.test(valor)) return `'${valor}`;
  if (/^[+-](?![\d\s])/.test(valor)) return `'${valor}`;
  return valor;
}

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
    ...contatos.map((c) => [neutralizarFormula(c.nome), neutralizarFormula(c.telefone)]),
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
