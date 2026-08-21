import { afterEach, describe, expect, it, vi } from "vitest";

const envBase = {
  NODE_ENV: "development",
  PORT: "3333",
  ORIGENS_PERMITIDAS: "https://disparoy-frontend.vercel.app/,https://disparoy-frontend-gh12-*.vercel.app,http://localhost:5173",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "super-secret-service-role-key-123456",
  JWT_SECRET: "1234567890abcdef1234567890abcdef",
  SESSAO_HORAS: "12",
  DATABASE_URL: "postgres://user:pass@localhost:5432/app",
  FILA_OPCIONAL: "false",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_SENHA: "123456",
  ADMIN_NOME: "Administrador",
  EVOLUTION_API_URL: "",
  EVOLUTION_API_KEY: "",
  EVOLUTION_WEBHOOK_SECRET: "1234567890abcdef",
  APP_URL_PUBLICA: "",
  GROQ_API_KEY: "",
  GROQ_MODELO: "llama-3.3-70b-versatile",
  META_WHATSAPP_TOKEN: "",
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: "",
  META_GRAPH_API_VERSION: "v21.0",
  DISPARO_CONCORRENCIA_POR_CANAL: "1",
};

/**
 * `vi.stubEnv` e não `Object.assign(process.env, ...)`: o `unstubAllEnvs` do
 * `afterEach` abaixo só desfaz o que foi stubado. Atribuição na mão sobrevive
 * ao arquivo e entrega ao próximo um ambiente válido de brinde — inclusive o
 * par `ADMIN_EMAIL`/`ADMIN_SENHA`, que muda o resultado da validação.
 */
const setEnv = (origens: string) => {
  for (const [chave, valor] of Object.entries({ ...envBase, ORIGENS_PERMITIDAS: origens })) {
    vi.stubEnv(chave, valor);
  }
};

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("origemPermitida", () => {
  it("aceita a origem real do frontend mesmo quando a env inclui barra final e caminho", async () => {
    setEnv("https://disparoy-frontend.vercel.app/entrar,https://disparoy-frontend-gh12-*.vercel.app,http://localhost:5173");

    const { origemPermitida } = await import("./ambiente.js");

    expect(origemPermitida("https://disparoy-frontend.vercel.app")).toBe(true);
    expect(origemPermitida("https://disparoy-frontend-gh12-x.vercel.app")).toBe(true);
  });

  it("rejeita origens fora da lista", async () => {
    setEnv("https://disparoy-frontend.vercel.app,https://disparoy-frontend-gh12-*.vercel.app,http://localhost:5173");

    const { origemPermitida } = await import("./ambiente.js");

    expect(origemPermitida("https://malicioso.com")).toBe(false);
  });
});
