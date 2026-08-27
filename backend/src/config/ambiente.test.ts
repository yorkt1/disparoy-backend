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
  // Vazio = o gerador escolhe o modelo sozinho. Ver `spintax/gerador.ts`.
  GROQ_MODELO: "",
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

/**
 * A URL pública precisa ser alcançável DE FORA, e não só existir.
 *
 * `http://localhost:3333` passou meses em produção neste sistema: a API subia
 * sem erro, o painel funcionava, as campanhas saíam — e a Evolution, que roda
 * em outra máquina, tentava entregar cada evento no localhost dela mesma.
 * Nenhuma entrega, leitura ou resposta foi registrada nesse período, e nada
 * apontava para a causa. O boot é o único lugar em que isso é barato de pegar.
 */
describe("APP_URL_PUBLICA em produção", () => {
  const producao = (url: string) => {
    for (const [chave, valor] of Object.entries({
      ...envBase,
      NODE_ENV: "production",
      EVOLUTION_API_URL: "https://evolution.example.com",
      EVOLUTION_API_KEY: "chave-da-evolution-123456",
      APP_URL_PUBLICA: url,
    })) {
      vi.stubEnv(chave, valor);
    }
  };

  const carregar = async () => {
    const { ambiente } = await import("./ambiente.js");
    return ambiente();
  };

  it("aceita a URL pública de verdade", async () => {
    producao("https://disparoy-backend.onrender.com");
    await expect(carregar()).resolves.toBeDefined();
  });

  it("recusa localhost", async () => {
    producao("http://localhost:3333");
    await expect(carregar()).rejects.toThrow(/alcançável/i);
  });

  it("recusa endereço de rede privada", async () => {
    producao("http://192.168.0.10:3333");
    await expect(carregar()).rejects.toThrow(/alcançável/i);
  });

  it("recusa loopback por IP", async () => {
    producao("http://127.0.0.1:3333");
    await expect(carregar()).rejects.toThrow(/alcançável/i);
  });
});
