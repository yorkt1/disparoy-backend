import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O curinga do CORS.
 *
 * `*` existe porque a Vercel gera um domínio novo a cada deploy. O risco é o
 * atalho óbvio: implementar `*` como `.*` numa regex faz
 * `https://disparoy-*.vercel.app` casar com `https://disparoy-x.vercel.app.invasor.com`,
 * e aí qualquer site consegue ler a API com o token da vítima. O teste existe
 * para que essa troca de uma linha não passe.
 */

async function comOrigens(lista: string) {
  vi.resetModules();
  // `vi.stubEnv` e não `process.env.X =`: o `process.env` é do PROCESSO, não do
  // arquivo. Escrito na mão ele fica lá depois que este arquivo termina, e o
  // próximo arquivo a rodar no mesmo worker herda um ambiente válido que ele
  // nunca pediu — foi assim que `observabilidade.test.ts` passava sozinho e
  // falhava na suíte inteira. O `unstubAllEnvs` do `afterEach` só desfaz o que
  // passou por aqui.
  vi.stubEnv("ORIGENS_PERMITIDAS", lista);
  vi.stubEnv("SUPABASE_URL", "https://exemplo.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-servico-de-teste-com-tamanho");
  vi.stubEnv("JWT_SECRET", "0".repeat(64));
  vi.stubEnv("DATABASE_URL", "postgres://usuario:senha@localhost:5432/postgres");
  vi.stubEnv("NODE_ENV", "test");
  // A extensão é exigida pelo `moduleResolution: node16` do projeto; o vitest
  // resolve `.js` para o `.ts` correspondente.
  return import("./ambiente.js");
}

describe("origens permitidas no CORS", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * O `resetModules` do `beforeEach` não basta: ele não roda DEPOIS do último
   * teste, e `ambiente.ts` guarda `cache`/`padroesCache` no topo do módulo. Sem
   * este `afterEach`, o arquivo seguinte importa um `ambiente` já resolvido com
   * a última lista de origens daqui e recebe respostas que não têm nada a ver
   * com o ambiente que ele mesmo montou.
   */
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("aceita a origem exata e recusa as demais", async () => {
    const { origemPermitida } = await comOrigens("https://disparoy.vercel.app");
    expect(origemPermitida("https://disparoy.vercel.app")).toBe(true);
    expect(origemPermitida("https://outro.vercel.app")).toBe(false);
    expect(origemPermitida("http://disparoy.vercel.app")).toBe(false);
  });

  it("aceita vários domínios separados por vírgula", async () => {
    const { origemPermitida } = await comOrigens(
      "https://disparoy.vercel.app, http://localhost:5173",
    );
    expect(origemPermitida("https://disparoy.vercel.app")).toBe(true);
    expect(origemPermitida("http://localhost:5173")).toBe(true);
  });

  it("o curinga cobre UM rótulo do host, não o resto do mundo", async () => {
    const { origemPermitida } = await comOrigens("https://disparoy-*.vercel.app");

    expect(origemPermitida("https://disparoy-abc123.vercel.app")).toBe(true);
    expect(origemPermitida("https://disparoy-.vercel.app")).toBe(true);

    // O ataque que o `[^./]*` impede: sufixo controlado por terceiro.
    expect(origemPermitida("https://disparoy-x.vercel.app.invasor.com")).toBe(false);
    // E o curinga não pode atravessar ponto para virar subdomínio.
    expect(origemPermitida("https://disparoy-x.y.vercel.app")).toBe(false);
    // Nem barra, que abriria caminho para origem com path forjado.
    expect(origemPermitida("https://disparoy-x/.vercel.app")).toBe(false);
  });

  it("origem vazia cai no padrão de desenvolvimento em vez de liberar geral", async () => {
    // `ORIGENS_PERMITIDAS=` é o estado natural: é o que o painel do Render cria
    // com `sync: false`. Virar lista vazia bloquearia o front inteiro; virar
    // "qualquer um" seria pior.
    const { origemPermitida } = await comOrigens("");
    expect(origemPermitida("http://localhost:5173")).toBe(true);
    expect(origemPermitida("https://qualquer-um.com")).toBe(false);
  });
});
