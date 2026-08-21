import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A URL da foto vem do GATEWAY, que é software de terceiro numa VPS que não é
 * nossa. Quem controlar a resposta dele escolhe o endereço que a nossa API vai
 * buscar, de dentro da rede do Render — e o resultado ainda vai parar no
 * Storage, de onde dá para ler depois. Estes testes existem para que afrouxar a
 * checagem quebre algo em vez de passar despercebido.
 */
describe("fotoDaInstancia", () => {
  /** Endereços realmente buscados, na ordem. */
  let buscados: string[] = [];

  const responder = (corpo: unknown) =>
    new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  // `Uint8Array<ArrayBuffer>` explícito: o parâmetro genérico solto é
  // `ArrayBufferLike`, que inclui `SharedArrayBuffer` e não serve como corpo.
  const responderImagem = (bytes: Uint8Array<ArrayBuffer>) =>
    new Response(new Blob([bytes]), { status: 200, headers: { "content-type": "image/jpeg" } });

  async function carregarProvedor() {
    // Ver `agenda.test.ts`: `process.env` escrito na mão vaza para o arquivo
    // seguinte no mesmo worker; `stubEnv` é o que o `unstubAllEnvs` desfaz.
    for (const [chave, valor] of Object.entries({
      NODE_ENV: "development",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "super-secret-service-role-key-123456",
      JWT_SECRET: "1234567890abcdef1234567890abcdef",
      DATABASE_URL: "postgres://user:pass@localhost:5432/app",
      EVOLUTION_API_URL: "https://evolution.example.com",
      EVOLUTION_API_KEY: "chave-de-teste",
      EVOLUTION_WEBHOOK_SECRET: "1234567890abcdef",
      APP_URL_PUBLICA: "",
    })) {
      vi.stubEnv(chave, valor);
    }
    vi.resetModules();
    return import("./evolution-provider.js");
  }

  /** Faz o gateway anunciar `urlDaFoto` e serve `bytes` a quem for buscá-la. */
  function comFotoEm(urlDaFoto: string, bytes = new Uint8Array([1, 2, 3])) {
    vi.stubGlobal("fetch", async (alvo: string | URL) => {
      const endereco = String(alvo);
      buscados.push(endereco);
      if (endereco.includes("instance/fetchInstances")) {
        return responder([{ name: "inst", profilePicUrl: urlDaFoto }]);
      }
      return responderImagem(bytes);
    });
  }

  beforeEach(() => {
    buscados = [];
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("aceita o domínio de mídia do WhatsApp", async () => {
    comFotoEm("https://pps.whatsapp.net/v/foto.jpg");
    const { fotoDaInstancia } = await carregarProvedor();

    const foto = await fotoDaInstancia("inst");

    expect(foto?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(buscados.some((u) => u.includes("pps.whatsapp.net"))).toBe(true);
  });

  it("recusa host de fora, sem chegar a buscá-lo", async () => {
    // O endereço de metadados da nuvem: alcançável de dentro, invisível de fora.
    comFotoEm("http://169.254.169.254/latest/meta-data/");
    const { fotoDaInstancia } = await carregarProvedor();

    expect(await fotoDaInstancia("inst")).toBeNull();
    // Recusar depois de buscar já teria feito o pedido — a checagem só vale
    // se acontecer ANTES do fetch.
    expect(buscados.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  it("não deixa o sufixo ser imitado por subdomínio", async () => {
    comFotoEm("https://whatsapp.net.invasor.com/foto.jpg");
    const { fotoDaInstancia } = await carregarProvedor();

    expect(await fotoDaInstancia("inst")).toBeNull();
    expect(buscados.some((u) => u.includes("invasor.com"))).toBe(false);
  });

  it("recusa esquema que não seja https", async () => {
    comFotoEm("http://pps.whatsapp.net/v/foto.jpg");
    const { fotoDaInstancia } = await carregarProvedor();

    expect(await fotoDaInstancia("inst")).toBeNull();
  });

  it("corta o download que passa do teto", async () => {
    // 3 MB contra um teto de 2 MB, servidos em pedaços de 256 KB para o corte
    // acontecer no meio do fluxo, e não depois de tudo já estar na memória.
    const pedaco = new Uint8Array(256 * 1024);
    let restantes = 12;
    vi.stubGlobal("fetch", async (alvo: string | URL) => {
      const endereco = String(alvo);
      buscados.push(endereco);
      if (endereco.includes("instance/fetchInstances")) {
        return responder([{ name: "inst", profilePicUrl: "https://pps.whatsapp.net/v/foto.jpg" }]);
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controlador) {
            if (restantes-- <= 0) return controlador.close();
            controlador.enqueue(pedaco);
          },
        }),
        { status: 200, headers: { "content-type": "image/jpeg" } },
      );
    });

    const { fotoDaInstancia } = await carregarProvedor();

    expect(await fotoDaInstancia("inst")).toBeNull();
  });
});
