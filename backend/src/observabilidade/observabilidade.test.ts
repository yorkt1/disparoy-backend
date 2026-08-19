import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Ambiente mínimo que PASSA na validação — guarda o caminho normal, para a
 * tolerância a ambiente inválido não virar desculpa para ignorar o `.env`.
 */
const envValido = {
  NODE_ENV: "development",
  SUPABASE_URL: "https://exemplo.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "chave-de-servico-com-mais-de-vinte-caracteres",
  JWT_SECRET: "1234567890abcdef1234567890abcdef",
  DATABASE_URL: "postgres://user:senha@localhost:5432/app",
};

/** Registra as URLs chamadas sem deixar nenhuma request sair de verdade. */
function espionarFetch(): string[] {
  const chamadas: string[] = [];
  vi.stubGlobal("fetch", (url: unknown) => {
    chamadas.push(String(url));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  return chamadas;
}

async function servico() {
  const { ObservabilidadeService } = await import("./observabilidade.service.js");
  return new ObservabilidadeService();
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ObservabilidadeService.relatarErro", () => {
  /**
   * O caso que motivou a tolerância: o worker morreu no boot três dias
   * seguidos por `APP_URL_PUBLICA` faltando, e o alerta que avisaria disso
   * morria na mesma linha — `ambiente()` lança quando a validação falha.
   * Reportar o erro não pode depender de o ambiente estar são.
   */
  it("continua alertando quando o próprio ambiente é inválido", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "isto-nao-e-uma-url");
    vi.stubEnv("ALERTA_WEBHOOK_URL", "https://alerta.exemplo/hook");
    const chamadas = espionarFetch();

    const observabilidade = await servico();

    expect(() =>
      observabilidade.relatarErro("Worker — falha ao iniciar", new Error("APP_URL_PUBLICA")),
    ).not.toThrow();
    expect(chamadas).toEqual(["https://alerta.exemplo/hook"]);
  });

  it("usa a URL validada quando o ambiente está são", async () => {
    for (const [chave, valor] of Object.entries(envValido)) vi.stubEnv(chave, valor);
    vi.stubEnv("ALERTA_WEBHOOK_URL", "https://alerta.exemplo/valido");
    const chamadas = espionarFetch();

    const observabilidade = await servico();
    observabilidade.relatarErro("Worker — exceção não capturada", new Error("qualquer"));

    expect(chamadas).toEqual(["https://alerta.exemplo/valido"]);
  });

  /** Sem webhook configurado o alerta é opcional — não pode virar erro. */
  it("não dispara nada quando não há webhook configurado", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "isto-nao-e-uma-url");
    vi.stubEnv("ALERTA_WEBHOOK_URL", "");
    const chamadas = espionarFetch();

    const observabilidade = await servico();

    expect(() => observabilidade.relatarErro("Worker", new Error("x"))).not.toThrow();
    expect(chamadas).toEqual([]);
  });
});
