/**
 * Limites operacionais da plataforma.
 *
 * Não há planos nem cobrança: o sistema é interno e billing está fora do
 * escopo. O que existe de limite é operacional — anti-ban e proteção de
 * memória — e mora tudo aqui.
 */
export const LIMITES = {
  /** Máximo de mensagens numa sequência (por contato). */
  maxMensagensPorContato: 10,
  maxCaracteresNomeCampanha: 80,
  maxCaracteresMensagem: 4096,
  /**
   * Teto por importação. As linhas lidas voltam para o navegador para o
   * mapeamento de colunas recalcular sem reenviar o arquivo — subir muito
   * este número trava a tela antes de esbarrar em qualquer limite de envio.
   */
  maxContatosPorImportacao: 20_000,
  /** Tamanho máximo aceito no upload de planilha. */
  maxBytesPlanilha: 10 * 1024 * 1024,
  /** Piso recomendado de intervalo entre contatos, para reduzir bloqueio. */
  intervaloMinimoRecomendadoSegundos: 8,
  /** Teto diário sugerido para um número recém-conectado. */
  limiteDiarioNumeroNovo: 50,
} as const;

const MB = 1024 * 1024;

/**
 * Mídia aceita no upload, por tipo.
 *
 * Os tetos são os do WhatsApp, não os nossos: adiantar a recusa aqui evita
 * subir 40 MB de vídeo para a Meta rejeitar na hora do envio, com a campanha
 * já em andamento.
 *
 * Documento é a exceção — o WhatsApp aceita 100 MB, mas o bucket do Supabase
 * está limitado a 50 MB, então vale o menor dos dois.
 *
 * O mesmo objeto vale nos dois lados: o navegador recusa antes de enviar, a
 * API recusa porque nada que vem do cliente é confiável.
 */
export const MIDIA_ACEITA = {
  imagem: {
    extensoes: [".jpg", ".jpeg", ".png", ".webp"],
    mimes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 5 * MB,
  },
  video: {
    extensoes: [".mp4", ".3gp"],
    mimes: ["video/mp4", "video/3gpp"],
    maxBytes: 16 * MB,
  },
  audio: {
    extensoes: [".mp3", ".ogg", ".aac", ".amr", ".m4a"],
    mimes: ["audio/mpeg", "audio/ogg", "audio/aac", "audio/amr", "audio/mp4", "audio/x-m4a"],
    maxBytes: 16 * MB,
  },
  documento: {
    extensoes: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv"],
    mimes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
      "text/csv",
    ],
    maxBytes: 50 * MB,
  },
} as const;

/** Todas as extensões aceitas, para o seletor de arquivo. */
export const EXTENSOES_MIDIA = Object.values(MIDIA_ACEITA).flatMap((m) => [...m.extensoes]);

/** Maior arquivo aceito em qualquer tipo — teto do upload. */
export const MAX_BYTES_MIDIA = Math.max(...Object.values(MIDIA_ACEITA).map((m) => m.maxBytes));

/**
 * Tipo da mídia deduzido da extensão.
 *
 * Deduzir em vez de perguntar: o operador já sabe o que está enviando quando
 * escolhe o arquivo, e errar o seletor mandaria um `mediatype` que não bate
 * com o conteúdo — o WhatsApp recusa, e só na hora do disparo.
 */
export function tipoDaExtensao(extensao: string): keyof typeof MIDIA_ACEITA | null {
  const alvo = extensao.toLowerCase();
  for (const [tipo, regra] of Object.entries(MIDIA_ACEITA)) {
    if ((regra.extensoes as readonly string[]).includes(alvo)) {
      return tipo as keyof typeof MIDIA_ACEITA;
    }
  }
  return null;
}

export const INTERVALO_PADRAO_ENTRE_CONTATOS = { minSegundos: 90, maxSegundos: 240 };
export const INTERVALO_PADRAO_ENTRE_MENSAGENS = { minSegundos: 3, maxSegundos: 9 };

/**
 * Aquecimento de número: teto diário sugerido por estágio.
 *
 * Número novo disparando volume alto é o caminho mais rápido para bloqueio.
 * O estágio sobe manualmente, conforme o operador acompanha a saúde do número.
 */
export const AQUECIMENTO: { estagio: number; rotulo: string; limiteDiario: number }[] = [
  { estagio: 0, rotulo: "Novo (dias 1–3)", limiteDiario: 50 },
  { estagio: 1, rotulo: "Inicial (dias 4–7)", limiteDiario: 150 },
  { estagio: 2, rotulo: "Intermediário (semanas 2–3)", limiteDiario: 400 },
  { estagio: 3, rotulo: "Maduro (mês 2+)", limiteDiario: 1000 },
];

export function limiteSugerido(estagio: number): number {
  const faixa = AQUECIMENTO.find((a) => a.estagio === estagio);
  return faixa?.limiteDiario ?? LIMITES.limiteDiarioNumeroNovo;
}

export const EXTENSOES_PLANILHA = [".csv", ".xls", ".xlsx"] as const;

/** Colunas reconhecidas automaticamente como o número de telefone. */
export const COLUNAS_TELEFONE = [
  "numero",
  "número",
  "telefone",
  "celular",
  "whatsapp",
  "phone",
  "fone",
  "contato",
];

/** Colunas reconhecidas automaticamente como o nome do contato. */
export const COLUNAS_NOME = ["nome", "name", "cliente", "razaosocial", "contato"];

/**
 * Palavras que, recebidas do contato, disparam opt-out automático.
 *
 * A LGPD exige que a saída seja simples e imediata. Comparação é feita sobre
 * o texto normalizado (sem acento, minúsculo, sem pontuação).
 */
export const PALAVRAS_OPT_OUT = [
  "parar",
  "sair",
  "stop",
  "descadastrar",
  "cancelar",
  "remover",
  "nao quero",
  "nao perturbe",
];

/** Origens aceitas para o registro de consentimento. */
export const ORIGENS_OPT_IN = [
  { valor: "formulario", rotulo: "Formulário no site" },
  { valor: "whatsapp", rotulo: "Conversa iniciada pelo contato no WhatsApp" },
  { valor: "contrato", rotulo: "Contrato ou cadastro de cliente" },
  { valor: "presencial", rotulo: "Coleta presencial (loja, evento)" },
  { valor: "importacao_manual", rotulo: "Importação manual com consentimento comprovável" },
] as const;

export type OrigemOptIn = (typeof ORIGENS_OPT_IN)[number]["valor"];
