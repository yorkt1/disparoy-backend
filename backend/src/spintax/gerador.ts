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
const URL_MODELOS = "https://api.groq.com/openai/v1/models";

const SEM_CHAVE = "Geração de variações não configurada: preencha GROQ_API_KEY em backend/.env.";

/** Uma chamada não pode segurar o request da API para sempre. */
const TIMEOUT_MS = 60_000;

/** Listar modelos é rápido; travar a geração esperando por isso, não. */
const TIMEOUT_MODELOS_MS = 10_000;

/**
 * Os modelos que servem para ESTA tarefa, do preferido para o último recurso.
 *
 * A lista é curada de propósito, e não "o mais novo que a Groq listar". O
 * `/models` devolve o catálogo inteiro da conta — transcrição de áudio, TTS,
 * moderação, visão — e escolher o mais recente de olhos fechados trocaria o
 * gerador de texto por um sintetizador de voz no dia em que a Groq lançar um.
 * Um nome errado aqui quebra o botão; um nome errado escolhido sozinho quebra
 * o botão E ninguém entende por quê.
 *
 * Critério para entrar: ser modelo de CHAT e aceitar
 * `response_format: json_object`, do qual o gerador depende inteiro (ver
 * `INSTRUCOES`, que manda responder só com um objeto JSON).
 *
 * A ordem tem duas razões empilhadas. Produção antes de preview: `gpt-oss-120b`
 * e `20b` são estáveis, `qwen3.6-27b` é preview e some sem aviso — ele está
 * aqui como último recurso, não como opção. E família antes de tamanho:
 * trocar de família muda o texto que o operador recebe, então o `20b` (mesma
 * família do `120b`) vem antes de sair para outra.
 *
 * `gpt-oss-120b` primeiro porque é o sucessor que a PRÓPRIA Groq indica para o
 * `llama-3.3-70b-versatile` que ela desligou em 16/08/2026 — o desligamento que
 * originou tudo isto.
 */
const MODELOS_PREFERIDOS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b",
] as const;

/**
 * O que a Groq respondeu no último `/models`, e quando.
 *
 * Cache de processo, e é seguro justamente por ser assim: o catálogo muda em
 * semanas, não em minutos, e uma consulta a cada clique em "Gerar variações"
 * dobraria a latência de um botão que o operador espera olhando. Uma hora é
 * curto o bastante para um desligamento ser absorvido sozinho no mesmo dia.
 *
 * Some no restart, junto com o processo. É o comportamento certo: não há nada
 * aqui que precise sobreviver a um deploy, e o banco não é lugar de cache de
 * catálogo de terceiro.
 */
let modeloEmUso: { id: string; resolvidoEm: number } | null = null;
const VALIDADE_CACHE_MS = 60 * 60 * 1000;

/** Força a próxima resolução a perguntar de novo. Usado pelo retry, abaixo. */
function esquecerModeloResolvido(): void {
  modeloEmUso = null;
}

interface ModeloGroq {
  id?: string;
  active?: boolean;
}

/**
 * Pergunta à Groq o que existe NESTA conta. Devolve vazio se não der para
 * perguntar.
 *
 * Conjunto vazio não é erro: quem chama cai no primeiro preferido, que é um
 * palpite melhor do que recusar a geração porque a listagem piscou. A listagem
 * existe para descobrir o que MORREU, e um modelo vivo continua respondendo
 * mesmo sem ela.
 */
async function modelosDisponiveis(chave: string): Promise<Set<string>> {
  try {
    const resposta = await fetch(URL_MODELOS, {
      headers: { Authorization: `Bearer ${chave}` },
      signal: AbortSignal.timeout(TIMEOUT_MODELOS_MS),
    });
    if (!resposta.ok) return new Set();

    const corpo = (await resposta.json()) as { data?: ModeloGroq[] };
    return new Set(
      (corpo.data ?? [])
        // `active: false` é a Groq dizendo "existe no catálogo, não atende".
        // Escolher um desses trocaria o 422 de hoje por outro igual.
        .filter((m) => m.id && m.active !== false)
        .map((m) => m.id as string),
    );
  } catch {
    return new Set();
  }
}

/**
 * Qual modelo usar agora.
 *
 * Três caminhos, nesta ordem:
 *
 *  1. `GROQ_MODELO` preenchido: obedece e não pergunta nada. É o pino de quem
 *     precisa do texto estável mais do que do modelo atual.
 *  2. Cache quente: devolve o de antes, sem ida à rede.
 *  3. Pergunta à Groq e cruza com `MODELOS_PREFERIDOS`. O primeiro preferido
 *     que estiver vivo ganha.
 *
 * Se a listagem não vier, usa o primeiro preferido SEM cachear: cachear um
 * palpite deixaria a escolha errada de pé por uma hora depois de a rede voltar.
 */
async function resolverModelo(chave: string, fixado: string): Promise<string> {
  if (fixado) return fixado;

  const agora = Date.now();
  if (modeloEmUso && agora - modeloEmUso.resolvidoEm < VALIDADE_CACHE_MS) {
    return modeloEmUso.id;
  }

  const escolhido = await escolherEntre(chave, MODELOS_PREFERIDOS);
  if (!escolhido) {
    throw new ErroGerador(
      `Nenhum modelo compatível na conta da Groq. Procurados: ` +
        `${MODELOS_PREFERIDOS.join(", ")}. Escolha um em GROQ_MODELO ` +
        `(console.groq.com/docs/models).`,
      "gerador_sem_modelo",
    );
  }

  modeloEmUso = { id: escolhido, resolvidoEm: agora };
  return escolhido;
}

/**
 * O próximo da lista depois de `recusado`, ou `null` se a lista acabou.
 *
 * Existe porque a listagem MENTE — e não em teoria: conferida contra a API em
 * 24/08/2026, a Groq responde 404 `model_not_found` com "does not exist **or
 * you do not have access to it**". As duas metades dessa frase são estados
 * diferentes, e no segundo o modelo continua aparecendo em `/models`, vivo,
 * para uma conta que não pode chamá-lo.
 *
 * Por isso a exclusão é por NOME e não uma nova consulta: reperguntar traria o
 * mesmo modelo de volta, o retry escolheria o recusado outra vez e o operador
 * levaria o mesmo 422 — que foi exatamente o que o teste do formato real pegou
 * antes de isto existir.
 *
 * Devolve `null` em vez de lançar: quem chama já tem nas mãos o erro que a Groq
 * deu, e ele explica o problema melhor do que "acabaram os modelos".
 */
async function proximoModelo(chave: string, recusado: string): Promise<string | null> {
  esquecerModeloResolvido();

  const restantes = MODELOS_PREFERIDOS.filter((m) => m !== recusado);
  const escolhido = await escolherEntre(chave, restantes);
  if (escolhido) modeloEmUso = { id: escolhido, resolvidoEm: Date.now() };
  return escolhido;
}

/**
 * O primeiro de `candidatos` que a conta tem. Sem listagem, o primeiro da lista.
 *
 * Listagem vazia não é motivo para recusar: um modelo vivo responde mesmo que a
 * consulta ao catálogo tenha falhado, e a listagem serve para descobrir o que
 * MORREU — não para autorizar o que vive. O palpite não é cacheado por quem
 * chama justamente por ser palpite.
 */
async function escolherEntre(
  chave: string,
  candidatos: readonly string[],
): Promise<string | null> {
  if (candidatos.length === 0) return null;

  const vivos = await modelosDisponiveis(chave);
  if (vivos.size === 0) return candidatos[0];

  return candidatos.find((m) => vivos.has(m)) ?? null;
}

/**
 * A resposta é "esse modelo não existe mais"?
 *
 * É o que separa "tenta outro" de "devolve o erro": chave inválida e limite
 * estourado precisam chegar ao operador, um modelo desligado não — para esse a
 * lista tem sucessor e o retry resolve sem ninguém ficar sabendo.
 *
 * Olha status E mensagem porque a Groq usa mais de um jeito. O que ela
 * respondeu de fato para o `llama-3.3-70b-versatile` depois de desligá-lo,
 * conferido contra a API em 24/08/2026:
 *
 *   404 {"error":{"code":"model_not_found","message":"The model
 *   `llama-3.3-70b-versatile` does not exist or you do not have access to it."}}
 *
 * Note que ela NÃO diz "decommissioned" nesse caso — diz "does not exist", e o
 * mesmo texto aparece quando o nome está só errado. Os dois querem a mesma
 * reação (tentar o próximo da lista), então não vale separar. "decommissioned"
 * fica coberto porque é o texto que ela usa no aviso de descontinuação, e o dia
 * em que ele aparecer numa resposta não pode virar 422 na tela de ninguém.
 */
function pareceModeloMorto(status: number, erro?: { message?: string; code?: string }): boolean {
  if (status !== 400 && status !== 404) return false;

  const texto = `${erro?.code ?? ""} ${erro?.message ?? ""}`.toLowerCase();
  return (
    texto.includes("model_not_found") ||
    texto.includes("decommission") ||
    texto.includes("does not exist") ||
    texto.includes("not found")
  );
}

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

/** Uma ida à Groq. Sem retry e sem interpretar nada: só devolve o que veio. */
async function pedirVariacoes(
  chave: string,
  modelo: string,
  texto: string,
  novas: number,
): Promise<{ status: number; corpo: RespostaGroq }> {
  let resposta: Response;
  try {
    resposta = await fetch(URL_GROQ, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${chave}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelo,
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

  return {
    status: resposta.status,
    corpo: (await resposta.json().catch(() => ({}))) as RespostaGroq,
  };
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
  const modelo = await resolverModelo(env.GROQ_API_KEY, env.GROQ_MODELO);
  let { status, corpo } = await pedirVariacoes(env.GROQ_API_KEY, modelo, texto, novas);

  /*
   * Uma segunda chance quando o modelo morreu entre a resolução e a chamada.
   *
   * Acontece de dois jeitos, e os dois são reais: o cache de uma hora ainda
   * aponta para o que a Groq desligou no meio do expediente, ou a listagem não
   * veio (rede) e o modelo saiu de palpite, sem conferência. Sem este retry, o
   * operador leva o mesmo 422 de antes até alguém reiniciar o processo.
   *
   * UMA tentativa, e só com o pino vazio. Com `GROQ_MODELO` preenchido,
   * insistir em outro modelo seria ignorar a escolha de quem prendeu a versão
   * de propósito — o erro precisa chegar até essa pessoa.
   */
  if (!env.GROQ_MODELO && pareceModeloMorto(status, corpo.error)) {
    const substituto = await proximoModelo(env.GROQ_API_KEY, modelo);
    // Sem substituto, o erro da Groq segue para o operador intacto: ele diz o
    // que aconteceu melhor do que qualquer mensagem nossa sobre a lista.
    if (substituto) {
      ({ status, corpo } = await pedirVariacoes(env.GROQ_API_KEY, substituto, texto, novas));
    }
  }

  if (status < 200 || status >= 300) {
    // A Groq devolve o motivo em `error.message` — chave inválida, modelo
    // desativado, limite estourado. Repassar evita o "erro inesperado" que
    // não ajuda ninguém a corrigir.
    throw new ErroGerador(corpo.error?.message ?? `Groq respondeu HTTP ${status}.`, String(status));
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
