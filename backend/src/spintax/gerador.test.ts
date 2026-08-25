import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O gerador contra o modo de falha que ele acabou de sofrer em produção.
 *
 * A Groq desligou `llama-3.3-70b-versatile` em 16/08/2026. O nome estava fixo
 * no código, o `.env` não tinha sido tocado, e todo clique em "Gerar variações"
 * virou 422 sem que nada do nosso lado tivesse mudado.
 *
 * O que estes testes cobrem é a ESCOLHA do modelo: que ela pergunte à Groq o
 * que existe, que respeite o pino quando há um, e que se recupere sozinha
 * quando o modelo morre entre a resolução e a chamada.
 *
 * O que eles NÃO cobrem é a qualidade do texto gerado — isso depende do modelo,
 * não de código, e um teste que finge medir isso só dá falsa confiança.
 *
 * `vi.resetModules()` a cada teste, e o import dinâmico que vem com ele, não
 * são cerimônia: `ambiente()` e o cache de modelo do gerador vivem no topo dos
 * respectivos módulos. Sem o reset, o primeiro teste escolheria o modelo de
 * todos os outros e o `vi.stubEnv` seguinte não teria efeito nenhum — a suíte
 * passaria a depender da ordem de execução (ver `vitest.config.ts`).
 */

const CHAVE = "gsk_chave_de_teste";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SUPABASE_URL", "https://exemplo.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-servico-de-teste");
  vi.stubEnv("JWT_SECRET", "0".repeat(32));
  vi.stubEnv("DATABASE_URL", "postgres://usuario:senha@localhost:5432/teste");
  vi.stubEnv("GROQ_API_KEY", CHAVE);
  vi.stubEnv("GROQ_MODELO", "");
});

/**
 * O reset também DEPOIS, e não só antes.
 *
 * `beforeEach` não roda após o último teste: sem este `afterEach`, este arquivo
 * termina deixando `config/ambiente.ts` avaliado e com o `cache` do topo dele
 * preenchido. O arquivo seguinte da suíte herda isso, `ambiente()` para de
 * lançar onde o teste dele espera que lance, e a falha aparece longe da causa —
 * foi exatamente assim que `observabilidade.test.ts` quebrou uma vez (a
 * história completa está em `vitest.config.ts`).
 */
afterEach(() => {
  vi.resetModules();
});

/** Resposta de sucesso do `/chat/completions`, com as variações pedidas. */
function respostaOk(variacoes: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ variacoes }) } }] }),
  } as unknown as Response;
}

/** Resposta de erro, no formato que a Groq usa. */
function respostaErro(status: number, message: string, code?: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message, code } }),
  } as unknown as Response;
}

/** Resposta do `/models`. `inativos` entram com `active: false`. */
function respostaModelos(ids: string[], inativos: string[] = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        ...ids.map((id) => ({ id, active: true })),
        ...inativos.map((id) => ({ id, active: false })),
      ],
    }),
  } as unknown as Response;
}

/**
 * Encaminha cada chamada pela URL e guarda o que foi pedido.
 *
 * `fetch` global e não injeção de dependência: o gerador chama `fetch` direto
 * de propósito (sem SDK — ver o comentário do topo dele), e acrescentar um
 * parâmetro só para o teste mudaria o desenho por causa do teste.
 */
function fingirFetch(rotas: {
  modelos?: () => Response;
  chat?: (corpo: Record<string, unknown>) => Response;
}) {
  const chamadas: { url: string; modelo?: string }[] = [];

  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const endereco = String(url);

    if (endereco.endsWith("/models")) {
      chamadas.push({ url: endereco });
      if (!rotas.modelos) throw new Error("fetch inesperado para /models");
      return rotas.modelos();
    }

    const corpo = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    chamadas.push({ url: endereco, modelo: String(corpo.model) });
    if (!rotas.chat) throw new Error("fetch inesperado para /chat/completions");
    return rotas.chat(corpo);
  });

  return chamadas;
}

/** Só as chamadas de geração, na ordem, pelo modelo que cada uma pediu. */
const modelosPedidos = (chamadas: { modelo?: string }[]) =>
  chamadas.filter((c) => c.modelo).map((c) => c.modelo);

/**
 * O módulo recarregado — ver o `vi.resetModules()` no `beforeEach`.
 *
 * `.js` na importação de um arquivo `.ts`: o backend compila com
 * `moduleResolution: node16`, onde o caminho é o do ARQUIVO EMITIDO. Sem a
 * extensão o `tsc` recusa (TS2835), e o vitest resolve para o `.ts` igual.
 */
const gerador = () => import("./gerador.js");

describe("escolha do modelo da Groq", () => {
  it("usa o preferido quando a conta o tem", async () => {
    const chamadas = fingirFetch({
      modelos: () => respostaModelos(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]),
      chat: () => respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-120b"]);
  });

  /**
   * O defeito de 16/08/2026, encenado: o preferido não existe mais na conta.
   * Antes desta mudança a resposta era 422; agora é a próxima da lista.
   */
  it("cai para o seguinte quando o preferido saiu do catálogo", async () => {
    const chamadas = fingirFetch({
      modelos: () => respostaModelos(["openai/gpt-oss-20b", "whisper-large-v3"]),
      chat: () => respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-20b"]);
  });

  /**
   * `active: false` é a Groq dizendo "está no catálogo e não atende". Escolher
   * um desses trocaria o 422 de hoje por outro igual amanhã.
   */
  it("ignora modelo listado como inativo", async () => {
    const chamadas = fingirFetch({
      modelos: () => respostaModelos(["openai/gpt-oss-20b"], ["openai/gpt-oss-120b"]),
      chat: () => respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-20b"]);
  });

  /**
   * A lista é curada, e este teste é o que a mantém assim: um modelo novo que a
   * Groq lance — de áudio, de voz, de moderação — não pode ser escolhido só por
   * estar disponível. "Sempre o mais recente" de olhos fechados trocaria o
   * gerador de texto por um sintetizador de voz.
   */
  it("não escolhe modelo fora da lista, mesmo estando disponível", async () => {
    const chamadas = fingirFetch({
      modelos: () =>
        respostaModelos([
          "playai-tts",
          "whisper-large-v3",
          "meta-llama/llama-guard-4-12b",
          "openai/gpt-oss-20b",
        ]),
      chat: () => respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-20b"]);
  });

  /** Quem prendeu a versão de propósito não quer a nossa opinião. */
  it("GROQ_MODELO preenchido manda, e a listagem nem acontece", async () => {
    vi.stubEnv("GROQ_MODELO", "openai/gpt-oss-20b");
    const chamadas = fingirFetch({ chat: () => respostaOk(["outra forma de dizer"]) });

    const { gerarVariacoes } = await gerador();
    await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-20b"]);
    expect(chamadas.some((c) => c.url.endsWith("/models"))).toBe(false);
  });

  /**
   * Listagem fora do ar não pode virar botão quebrado: o preferido é um palpite
   * melhor do que recusar. Um modelo vivo responde mesmo sem a listagem — ela
   * serve para descobrir o que MORREU, não para autorizar o que vive.
   */
  it("sem listagem, tenta o preferido em vez de falhar", async () => {
    const chamadas = fingirFetch({
      modelos: () => respostaErro(500, "indisponível"),
      chat: () => respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-120b"]);
  });

  /**
   * A corrida real: a Groq desliga o modelo DEPOIS de a listagem ter dito que
   * ele existe — cache de uma hora, ou desligamento no meio do expediente. Sem
   * o retry, o operador leva o mesmo 422 até alguém reiniciar o processo.
   */
  it("modelo que morre entre a resolução e a chamada é trocado, e a geração vai", async () => {
    let listagens = 0;
    const chamadas = fingirFetch({
      modelos: () => {
        listagens += 1;
        return listagens === 1
          ? respostaModelos(["openai/gpt-oss-120b", "openai/gpt-oss-20b"])
          : respostaModelos(["openai/gpt-oss-20b"]);
      },
      chat: (corpo) =>
        corpo.model === "openai/gpt-oss-120b"
          ? respostaErro(400, "The model `openai/gpt-oss-120b` has been decommissioned.")
          : respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    const variacoes = await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(variacoes).toEqual(["texto original", "outra forma de dizer"]);
  });

  /**
   * Chave inválida e limite estourado precisam CHEGAR ao operador — só modelo
   * morto tem sucessor. Insistir aqui gastaria uma segunda chamada para receber
   * o mesmo erro, e ainda esconderia a causa atrás de outro modelo.
   */
  it("erro que não é de modelo não vira retry", async () => {
    const chamadas = fingirFetch({
      modelos: () => respostaModelos(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]),
      chat: () => respostaErro(401, "Invalid API Key", "invalid_api_key"),
    });

    const { gerarVariacoes } = await gerador();
    await expect(gerarVariacoes("texto original", 2)).rejects.toThrow("Invalid API Key");
    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-120b"]);
  });

  /**
   * Com o pino preenchido, trocar de modelo sozinho seria desfazer a escolha de
   * quem o prendeu — e em silêncio, que é pior do que o erro.
   */
  it("modelo pinado que morreu devolve o erro em vez de trocar sozinho", async () => {
    vi.stubEnv("GROQ_MODELO", "llama-3.3-70b-versatile");
    const chamadas = fingirFetch({
      chat: () => respostaErro(400, "The model `llama-3.3-70b-versatile` has been decommissioned."),
    });

    const { gerarVariacoes } = await gerador();
    await expect(gerarVariacoes("texto original", 2)).rejects.toThrow("decommissioned");
    expect(modelosPedidos(chamadas)).toEqual(["llama-3.3-70b-versatile"]);
  });

  /**
   * Uma consulta por clique dobraria a latência de um botão que o operador
   * espera olhando. O catálogo da Groq muda em semanas, não entre dois cliques.
   */
  it("a listagem é reaproveitada entre gerações", async () => {
    const chamadas = fingirFetch({
      modelos: () => respostaModelos(["openai/gpt-oss-120b"]),
      chat: () => respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    await gerarVariacoes("texto original", 2);
    await gerarVariacoes("outro texto", 2);

    expect(chamadas.filter((c) => c.url.endsWith("/models"))).toHaveLength(1);
    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
  });

  /**
   * A resposta REAL da Groq para o modelo que ela desligou, copiada da API em
   * 24/08/2026 — status, `code` e texto exatos:
   *
   *   404 { error: { code: "model_not_found", message: "The model
   *   `llama-3.3-70b-versatile` does not exist or you do not have access to it." } }
   *
   * Está aqui porque o detector foi escrito contra uma SUPOSIÇÃO do formato
   * antes de alguém conferir. Se a Groq mudar o texto, é este teste que avisa —
   * e não o operador, com o botão quebrado de novo.
   */
  it("reconhece a resposta que a Groq realmente deu para o modelo desligado", async () => {
    const chamadas = fingirFetch({
      modelos: () => respostaModelos(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]),
      chat: (corpo) =>
        corpo.model === "openai/gpt-oss-120b"
          ? respostaErro(
              404,
              "The model `openai/gpt-oss-120b` does not exist or you do not have access to it.",
              "model_not_found",
            )
          : respostaOk(["outra forma de dizer"]),
    });

    const { gerarVariacoes } = await gerador();
    const variacoes = await gerarVariacoes("texto original", 2);

    expect(modelosPedidos(chamadas)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(variacoes).toEqual(["texto original", "outra forma de dizer"]);
  });

  /** Conta sem nenhum dos nossos: o erro precisa dizer como sair do problema. */
  it("nenhum modelo compatível explica o que fazer", async () => {
    fingirFetch({ modelos: () => respostaModelos(["whisper-large-v3", "playai-tts"]) });

    const { gerarVariacoes } = await gerador();
    await expect(gerarVariacoes("texto original", 2)).rejects.toThrow("GROQ_MODELO");
  });
});
