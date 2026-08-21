/**
 * Confere o CONTEÚDO do arquivo, não o que o cliente disse sobre ele.
 *
 * O `ROBUSTEZ.md` já registrava o buraco: "o upload confere extensão e mime
 * declarado, não os magic bytes". Os dois vêm do navegador e nenhum dos dois é
 * fato — `Content-Type` é um cabeçalho que o cliente escreve, e a extensão é o
 * fim de uma string que o cliente escolheu. E o bucket é PÚBLICO por desenho
 * (quem baixa a mídia é o servidor do WhatsApp), então cada upload vira uma URL
 * permanente e aberta, servida do domínio do Supabase do projeto. Aceitar
 * `payload.png` que na verdade é HTML significa hospedar a página de quem
 * subiu, para sempre, num endereço que parece nosso.
 *
 * A conferência é por FAMÍLIA de container, não por mime exato: `.docx`,
 * `.xlsx` e `.pptx` são todos ZIP, e `.doc`, `.xls` e `.ppt` são todos OLE2 —
 * distinguir um do outro exigiria abrir o arquivo, e não é isso que está em
 * jogo. O que precisa ser verdade é que o conteúdo pertence ao container que a
 * extensão promete, e não a um formato que o navegador executaria.
 */

/** Container reconhecido pelos primeiros bytes. */
export type Familia =
  | "jpeg"
  | "png"
  | "webp"
  | "isobmff"
  | "ogg"
  | "mpeg-audio"
  | "amr"
  | "pdf"
  | "zip"
  | "ole2"
  | "texto";

function comeca(bytes: Uint8Array, ...prefixo: number[]): boolean {
  if (bytes.length < prefixo.length) return false;
  return prefixo.every((b, i) => bytes[i] === b);
}

function ascii(bytes: Uint8Array, inicio: number, tamanho: number): string {
  return Buffer.from(bytes.subarray(inicio, inicio + tamanho)).toString("latin1");
}

/**
 * Família deduzida dos primeiros bytes, ou `null` quando nada é reconhecido.
 *
 * `null` é recusa: um formato que não está nesta lista não é nenhum dos que o
 * WhatsApp aceita, e adivinhar seria voltar a confiar na extensão.
 */
export function familiaDoConteudo(bytes: Uint8Array): Familia | null {
  if (bytes.length < 4) return null;

  if (comeca(bytes, 0xff, 0xd8, 0xff)) return "jpeg";
  if (comeca(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (comeca(bytes, 0x50, 0x4b, 0x03, 0x04)) return "zip";
  if (comeca(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "ole2";
  if (ascii(bytes, 0, 5) === "#!AMR") return "amr";

  // MP4, 3GP e M4A são todos ISO-BMFF: o `ftyp` mora no segundo campo da
  // primeira caixa, não no começo do arquivo.
  if (ascii(bytes, 4, 4) === "ftyp") return "isobmff";

  // MP3 e AAC: ou a tag ID3 na frente, ou o sync de quadro (11 bits em 1).
  if (ascii(bytes, 0, 3) === "ID3") return "mpeg-audio";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mpeg-audio";

  if (pareceTexto(bytes)) return "texto";

  return null;
}

/**
 * Bytes que passam por texto simples.
 *
 * `.txt` e `.csv` não têm assinatura nenhuma — é o único par da lista em que a
 * ausência de magic bytes é legítima. Byte nulo e sequência de controle são o
 * que separa "texto" de "binário renomeado".
 */
export function pareceTexto(bytes: Uint8Array): boolean {
  // Amostra: varrer 50 MB de documento atrás de um NUL que, quando existe, está
  // quase sempre no começo é trabalho jogado fora no caminho quente.
  const amostra = bytes.subarray(0, 8192);
  if (amostra.length === 0) return false;

  for (const b of amostra) {
    // Controle C0, menos tab (0x09), LF, VT, FF e CR (0x0a–0x0d).
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  return true;
}

/**
 * Texto que o navegador trataria como documento se o `Content-Type` escapasse.
 *
 * Um `.csv` que começa com `<html>` não é um `.csv` — é uma página esperando um
 * sniffing de tipo para virar XSS numa URL que parece do projeto.
 */
function pareceMarcacao(bytes: Uint8Array): boolean {
  const inicio = ascii(bytes, 0, 512).trimStart().toLowerCase();
  return (
    inicio.startsWith("<!doctype") ||
    inicio.startsWith("<html") ||
    inicio.startsWith("<svg") ||
    inicio.startsWith("<?xml") ||
    inicio.startsWith("<script")
  );
}

/**
 * Famílias que cada extensão aceita, e o `Content-Type` a gravar no bucket.
 *
 * O mime vem DAQUI, nunca do cliente: é ele que o navegador de quem abrir a URL
 * pública vai obedecer. Ecoar o cabeçalho recebido significaria deixar quem faz
 * o upload escolher como o arquivo dele é servido depois.
 */
const REGRAS: Record<string, { familias: Familia[]; mime: string }> = {
  ".jpg": { familias: ["jpeg"], mime: "image/jpeg" },
  ".jpeg": { familias: ["jpeg"], mime: "image/jpeg" },
  ".png": { familias: ["png"], mime: "image/png" },
  ".webp": { familias: ["webp"], mime: "image/webp" },

  ".mp4": { familias: ["isobmff"], mime: "video/mp4" },
  ".3gp": { familias: ["isobmff"], mime: "video/3gpp" },

  ".mp3": { familias: ["mpeg-audio"], mime: "audio/mpeg" },
  ".ogg": { familias: ["ogg"], mime: "audio/ogg" },
  ".aac": { familias: ["mpeg-audio"], mime: "audio/aac" },
  ".amr": { familias: ["amr"], mime: "audio/amr" },
  ".m4a": { familias: ["isobmff"], mime: "audio/mp4" },

  ".pdf": { familias: ["pdf"], mime: "application/pdf" },
  ".doc": { familias: ["ole2"], mime: "application/msword" },
  ".docx": {
    familias: ["zip"],
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  // `.xls` aceita ZIP também: renomear um `.xlsx` para `.xls` é o engano mais
  // comum de quem exporta do Excel, e recusar isso seria recusar arquivo bom.
  ".xls": { familias: ["ole2", "zip"], mime: "application/vnd.ms-excel" },
  ".xlsx": {
    familias: ["zip"],
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  ".ppt": { familias: ["ole2"], mime: "application/vnd.ms-powerpoint" },
  ".pptx": {
    familias: ["zip"],
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  ".txt": { familias: ["texto"], mime: "text/plain" },
  ".csv": { familias: ["texto"], mime: "text/csv" },
};

export type Veredito = { ok: true; mime: string } | { ok: false; motivo: string };

/**
 * Confere se o conteúdo bate com a extensão já validada pela lista de aceitos.
 *
 * Devolve o `Content-Type` a usar no bucket — derivado da extensão, e só depois
 * de o conteúdo confirmar que ela não estava mentindo.
 */
export function conferirConteudo(bytes: Uint8Array, extensao: string): Veredito {
  const regra = REGRAS[extensao.toLowerCase()];
  // Extensão fora do mapa significa que `MIDIA_ACEITA` ganhou um formato e
  // ninguém veio dizer aqui como reconhecê-lo. Recusar é o certo: liberar
  // devolveria a confiança na extensão que este arquivo existe para tirar.
  if (!regra) {
    return { ok: false, motivo: `Não sei conferir o conteúdo de um arquivo ${extensao}.` };
  }

  if (bytes.length === 0) return { ok: false, motivo: "O arquivo está vazio." };

  const familia = familiaDoConteudo(bytes);
  if (familia === null || !regra.familias.includes(familia)) {
    return {
      ok: false,
      motivo:
        `O conteúdo do arquivo não é ${extensao}. ` +
        "Renomear a extensão não converte o arquivo — exporte no formato certo e envie de novo.",
    };
  }

  if (familia === "texto" && pareceMarcacao(bytes)) {
    return {
      ok: false,
      motivo: `Este ${extensao} contém marcação de página, não texto. Envie o arquivo original.`,
    };
  }

  return { ok: true, mime: regra.mime };
}

/**
 * Nome exibível, tirado do que o cliente mandou.
 *
 * Não decide caminho nenhum — o objeto no bucket é um uuid — mas vai para a
 * tela e para `logs_auditoria.entidade_rotulo`, e `originalname` é string crua
 * de upload: aceita o caminho do Windows inteiro, byte de controle e alguns
 * milhares de caracteres. Nada disso é nome de arquivo.
 */
export function nomeExibivel(original: string, extensao: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";

  const limpo = [...base]
    // Sem regex de faixa de controle: o caractere literal dentro do padrão é
    // invisível no diff e some no primeiro copiar-e-colar entre editores.
    .filter((c) => {
      const codigo = c.codePointAt(0) ?? 0;
      return codigo >= 0x20 && codigo !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();

  return limpo || `arquivo${extensao}`;
}
