import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapearAgenda } from "./evolution-provider.js";

/**
 * Os formatos aqui saíram de uma agenda real de 1871 entradas: 1805 pessoas,
 * 55 grupos, 6 `lid` e 5 `newsletter`.
 */
describe("mapearAgenda", () => {
  it("aceita só pessoas", () => {
    const r = mapearAgenda([
      { remoteJid: "5548991237324@s.whatsapp.net", pushName: "Gui" },
      { remoteJid: "120363422229204625@g.us", pushName: "Equipe Arte em cuidar" },
      { remoteJid: "120363404701403742@newsletter", pushName: "Pack de Figurinhas" },
      { remoteJid: "146706547804@lid", pushName: null },
      { remoteJid: "5511988887777@broadcast", pushName: "Lista" },
    ]);
    expect(r).toEqual([{ nome: "Gui", telefone: "+5548991237324" }]);
  });

  it("descarta a conta oficial do WhatsApp, que vem em toda agenda", () => {
    expect(mapearAgenda([{ remoteJid: "0@s.whatsapp.net", pushName: "WhatsApp" }])).toEqual([]);
  });

  it("tira número repetido", () => {
    // A mesma pessoa aparece mais de uma vez com frequência; a planilha não
    // pode mandar duas mensagens para ela.
    const r = mapearAgenda([
      { remoteJid: "5548991237324@s.whatsapp.net", pushName: "Gui" },
      { remoteJid: "5548991237324@s.whatsapp.net", pushName: "Guilherme" },
    ]);
    expect(r).toHaveLength(1);
  });

  it("procura o nome nos três campos que a Evolution usa", () => {
    const r = mapearAgenda([
      { remoteJid: "5511900000001@s.whatsapp.net", pushName: "Por pushName" },
      { remoteJid: "5511900000002@s.whatsapp.net", name: "Por name" },
      { remoteJid: "5511900000003@s.whatsapp.net", verifiedName: "Por verifiedName" },
      { remoteJid: "5511900000004@s.whatsapp.net" },
    ]);
    expect(r.map((c) => c.nome).sort()).toEqual(["", "Por name", "Por pushName", "Por verifiedName"]);
  });

  it("aceita a resposta embrulhada em objeto", () => {
    // A Evolution já devolveu array cru e `{ contacts: [...] }` entre versões.
    const dentro = { contacts: [{ remoteJid: "5548991237324@s.whatsapp.net", pushName: "Gui" }] };
    expect(mapearAgenda(dentro)).toHaveLength(1);
  });

  it("não quebra com resposta inesperada", () => {
    expect(mapearAgenda(null)).toEqual([]);
    expect(mapearAgenda({})).toEqual([]);
    expect(mapearAgenda("erro")).toEqual([]);
    expect(mapearAgenda([null, undefined, {}])).toEqual([]);
  });

  it("ordena por nome, em português", () => {
    const r = mapearAgenda([
      { remoteJid: "5511900000001@s.whatsapp.net", pushName: "Zeca" },
      { remoteJid: "5511900000002@s.whatsapp.net", pushName: "Ácaro" },
      { remoteJid: "5511900000003@s.whatsapp.net", pushName: "Bruno" },
    ]);
    expect(r.map((c) => c.nome)).toEqual(["Ácaro", "Bruno", "Zeca"]);
  });
});

/**
 * Não existe mais cache com prazo — só deduplicação de chamadas EM VOO, no
 * mesmo processo. Estes testes existem porque o comportamento anterior (5 min
 * guardados) causava um vazamento invisível entre réplicas: nada falhava, a
 * planilha simplesmente saía com a agenda de outra pessoa. Ver o comentário de
 * `contatosDaInstancia` em `evolution-provider.ts` para o motivo da troca.
 */
describe("busca da agenda", () => {
  const agendaCrua = [{ remoteJid: "5548991237324@s.whatsapp.net", pushName: "Gui" }];

  /** Quantas vezes o gateway foi consultado de verdade. */
  let buscas = 0;
  /** Atrasa a resposta para poder simular duas chamadas realmente concorrentes. */
  let atrasoMs = 0;

  const responder = (corpo: unknown) =>
    new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  /**
   * Import dinâmico a cada teste: a deduplicação é módulo-privada, então
   * estado limpo é módulo novo.
   */
  async function carregarProvedor() {
    // `vi.stubEnv` e não `Object.assign(process.env, ...)`: o `process.env` é do
    // processo, e o vitest reaproveita worker entre arquivos. Escrito na mão,
    // este ambiente sobrevive ao arquivo e o próximo a rodar herda um
    // `EVOLUTION_API_URL` que ele não configurou. Só o que passa por `stubEnv`
    // é desfeito pelo `unstubAllEnvs` do `afterEach`.
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

  beforeEach(() => {
    buscas = 0;
    atrasoMs = 0;
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const caminho = String(url);
      if (caminho.includes("chat/findContacts")) {
        buscas++;
        if (atrasoMs > 0) await new Promise((r) => setTimeout(r, atrasoMs));
        return responder(agendaCrua);
      }
      return responder({});
    });
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("duas chamadas concorrentes na MESMA instância dividem uma busca só", async () => {
    const { contatosDaInstancia } = await carregarProvedor();
    atrasoMs = 20; // dá tempo da segunda chamada colidir antes da primeira responder.

    const [a, b] = await Promise.all([contatosDaInstancia("inst"), contatosDaInstancia("inst")]);

    expect(buscas).toBe(1);
    expect(a).toEqual(b);
  });

  it("chamadas concorrentes em instâncias diferentes NÃO se misturam", async () => {
    const { contatosDaInstancia } = await carregarProvedor();
    atrasoMs = 20;

    await Promise.all([contatosDaInstancia("inst"), contatosDaInstancia("outra")]);

    expect(buscas).toBe(2);
  });

  it("chamadas sequenciais buscam de novo, sempre — não há mais janela guardada", async () => {
    // Esta é a troca deliberada: sem TTL em memória, uma consulta feita 1 s
    // depois da outra paga o round-trip de novo. É o preço de não haver mais
    // agenda de terceiro parada na memória entre requisições — e do backend
    // poder rodar em mais de uma réplica sem uma servir o número da outra.
    const { contatosDaInstancia } = await carregarProvedor();

    await contatosDaInstancia("inst");
    await contatosDaInstancia("inst");

    expect(buscas).toBe(2);
  });

  it("esquecerAgenda não lança e não muda o resultado — virou no-op", async () => {
    const { contatosDaInstancia, esquecerAgenda } = await carregarProvedor();

    await contatosDaInstancia("inst");
    expect(() => esquecerAgenda("inst")).not.toThrow();
    await contatosDaInstancia("inst");

    expect(buscas).toBe(2);
  });
});
