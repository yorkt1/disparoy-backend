import { ambiente } from "../config/ambiente";

/**
 * Geração de variações a partir do texto original, via Groq.
 *
 * O que antes era copiar o texto no ChatGPT, colar o prompt e trazer as opções
 * de volta à mão. As regras do prompt são as mesmas de sempre, com um acréscimo
 * que só faz sentido aqui: as variações vão para o WhatsApp, então continuam
 * curtas e sem formatação que o aplicativo não renderiza.
 *
 * Sem SDK: a Groq expõe a API compatível com a da OpenAI, e uma chamada só de
 * `fetch` evita mais uma dependência — é como o cliente da Evolution já faz.
 */

const URL_GROQ = "https://api.groq.com/openai/v1/chat/completions";

const SEM_CHAVE = "Geração de variações não configurada: preencha GROQ_API_KEY em backend/.env.";

/** Uma chamada não pode segurar o request da API para sempre. */
const TIMEOUT_MS = 60_000;

const INSTRUCOES = `Você reescreve mensagens de WhatsApp para uma ferramenta de disparo.

Recebe um texto e devolve variações dele. Todas precisam transmitir exatamente
as mesmas informações, sem acrescentar, retirar ou alterar fatos, nomes, valores
ou intenções.

Antes de escrever, identifique no texto original — mentalmente, sem exibir — as
ações/verbos, quem faz e para quem, lugares, nomes próprios, datas, horários,
números, valores e a intenção. Toda variação tem de manter TODOS esses elementos
idênticos. Só muda a forma de dizer.

Regras:
- Mude apenas a construção das frases, a escolha das palavras e a ordem das
  ideias, mantendo o mesmo sentido.
- Nunca troque uma ação por outra parecida, nem inverta direção ou sentido.
  Cada verbo descreve um fato específico e tem de continuar o mesmo — só muda a
  forma de dizê-lo. (Um exemplo, entre muitos: "saí de casa" não pode virar "fui
  para casa" nem "cheguei em casa"; mas a regra vale para toda ação do texto.)
- Corrija erros de português, concordância, pontuação, gênero e pronomes, sem
  mudar a mensagem.
- Os textos devem ser naturais, claros, envolventes e fáceis de entender.
- Evite versões parecidas demais entre si e palavras excessivamente formais.
- Não invente informação que não esteja no texto original.
- Mantenha o comprimento próximo ao do original: é uma mensagem de WhatsApp,
  não um e-mail.
- Preserve intactos os marcadores {{1}}, {{2}} e {{*nome*}} — são variáveis
  substituídas no envio. Nunca os traduza, renomeie ou remova.
- Não use markdown nem títulos: o WhatsApp não renderiza. Emojis, só se o
  texto original tiver.

Antes de responder, confira cada variação contra os elementos do original
(ações, nomes, lugares, números, intenção). Se algum tiver mudado, reescreva a
variação até bater.

Responda SOMENTE com um objeto JSON nesta forma, sem nenhum texto em volta:
{"variacoes": ["primeira variação", "segunda variação"]}

Devolva apenas as variações NOVAS, sem repetir o original.`;

export class ErroGerador extends Error {
  constructor(
    message: string,
    readonly codigo: string,
  ) {
    super(message);
    this.name = "ErroGerador";
  }
}

export function geradorConfigurado(): boolean {
  return Boolean(ambiente().GROQ_API_KEY);
}

interface RespostaGroq {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: { message?: string; code?: string };
}

/** Extrai o JSON mesmo quando o modelo embrulha em ```json … ```. */
function lerJson(texto: string): unknown {
  const limpo = texto
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(limpo);
  } catch {
    // Último recurso: o primeiro objeto que apareça no meio da resposta.
    const inicio = limpo.indexOf("{");
    const fim = limpo.lastIndexOf("}");
    if (inicio === -1 || fim <= inicio) return null;
    try {
      return JSON.parse(limpo.slice(inicio, fim + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Devolve `quantidade` opções, com o texto original em primeiro lugar.
 *
 * O original vem daqui, não do modelo: pedir que ele "inclua a versão original
 * como opção 1" convida a devolvê-la reescrita, e o operador perderia sem
 * perceber o texto que ele mesmo aprovou.
 */
export async function gerarVariacoes(texto: string, quantidade: number): Promise<string[]> {
  const env = ambiente();
  if (!env.GROQ_API_KEY) throw new ErroGerador(SEM_CHAVE, "gerador_nao_configurado");

  const novas = quantidade - 1;

  let resposta: Response;
  try {
    resposta = await fetch(URL_GROQ, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.GROQ_MODELO,
        messages: [
          { role: "system", content: INSTRUCOES },
          {
            role: "user",
            content: `Gere ${novas} ${novas === 1 ? "variação" : "variações"} deste texto:\n\n${texto}`,
          },
        ],
        response_format: { type: "json_object" },
        // Variedade é o objetivo aqui: com temperatura baixa as cinco opções
        // saem quase idênticas, que é exatamente o que a variação evita.
        temperature: 1,
        max_completion_tokens: 2048,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const motivo =
      e instanceof Error && e.name === "TimeoutError"
        ? `A Groq não respondeu em ${TIMEOUT_MS / 1000}s.`
        : `Falha ao falar com a Groq: ${e instanceof Error ? e.message : String(e)}`;
    throw new ErroGerador(motivo, "gerador_falhou");
  }

  const corpo = (await resposta.json().catch(() => ({}))) as RespostaGroq;

  if (!resposta.ok) {
    // A Groq devolve o motivo em `error.message` — chave inválida, modelo
    // desativado, limite estourado. Repassar evita o "erro inesperado" que
    // não ajuda ninguém a corrigir.
    throw new ErroGerador(
      corpo.error?.message ?? `Groq respondeu HTTP ${resposta.status}.`,
      String(resposta.status),
    );
  }

  const conteudo = corpo.choices?.[0]?.message?.content;
  if (!conteudo) throw new ErroGerador("A Groq não devolveu texto.", "gerador_vazio");

  const dados = lerJson(conteudo);
  const lista =
    typeof dados === "object" && dados !== null && Array.isArray((dados as never)["variacoes"])
      ? ((dados as { variacoes: unknown[] }).variacoes as unknown[])
      : [];

  if (lista.length === 0) {
    throw new ErroGerador("Resposta da Groq em formato inesperado.", "gerador_formato");
  }

  const limpas = lista
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    // Duplicata não é variação: o operador veria duas linhas iguais e a
    // campanha ganharia peso extra num texto só.
    .filter((v, i, todas) => todas.findIndex((o) => o.toLowerCase() === v.toLowerCase()) === i)
    .filter((v) => v.toLowerCase() !== texto.trim().toLowerCase());

  if (limpas.length === 0) {
    throw new ErroGerador("Nenhuma variação utilizável foi gerada.", "gerador_vazio");
  }

  return [texto.trim(), ...limpas].slice(0, quantidade);
}
