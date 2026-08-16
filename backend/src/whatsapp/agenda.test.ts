import type { Canal } from "@disparoy/dominio";
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
 * O cache é indexado pela INSTÂNCIA, e a instância sobrevive à troca de número.
 * Estes testes existem porque o vazamento é invisível: nada falha, a planilha
 * simplesmente sai com a agenda de outra pessoa.
 */
describe("cache da agenda", () => {
  const canal = { id: "canal-1", instanciaEvolution: "inst" } as Canal;
  const agendaCrua = [{ remoteJid: "5548991237324@s.whatsapp.net", pushName: "Gui" }];

  /** Quantas vezes o gateway foi consultado de verdade. */
  let buscas = 0;

  const responder = (corpo: unknown) =>
    new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  /**
   * Import dinâmico a cada teste: o cache é módulo-privado, então cache limpo é
   * módulo novo.
   */
  async function carregarProvedor() {
    Object.assign(process.env, {
      NODE_ENV: "development",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "super-secret-service-role-key-123456",
      JWT_SECRET: "1234567890abcdef1234567890abcdef",
      DATABASE_URL: "postgres://user:pass@localhost:5432/app",
      EVOLUTION_API_URL: "https://evolution.example.com",
      EVOLUTION_API_KEY: "chave-de-teste",
      EVOLUTION_WEBHOOK_SECRET: "1234567890abcdef",
      // Vazia de propósito: sem ela `registrarWebhook` devolve aviso e não
      // encosta na rede, o que deixa o teste focado no cache.
      APP_URL_PUBLICA: "",
    });
    vi.resetModules();
    return import("./evolution-provider.js");
  }

  beforeEach(() => {
    buscas = 0;
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const caminho = String(url);
      if (caminho.includes("chat/findContacts")) {
        buscas++;
        return responder(agendaCrua);
      }
      // O connect precisa devolver QR, senão o pareamento lança antes da hora.
      if (caminho.includes("instance/connect")) return responder({ base64: "qr-falso" });
      return responder({});
    });
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("não repete a busca dentro da janela", async () => {
    const { contatosDaInstancia } = await carregarProvedor();

    await contatosDaInstancia("inst");
    await contatosDaInstancia("inst");

    expect(buscas).toBe(1);
  });

  it("esquece a agenda ao reparear — o número pode ser outro", async () => {
    const { contatosDaInstancia, provedorEvolution } = await carregarProvedor();

    await contatosDaInstancia("inst");
    await provedorEvolution.iniciarSessao(canal, { renovar: true });
    await contatosDaInstancia("inst");

    expect(buscas).toBe(2);
  });

  it("esquece a agenda mesmo num pareamento que não veio de um desconectar", async () => {
    // A sessão também cai sozinha, pelo webhook ou pelo worker: nesses casos
    // ninguém chama `encerrarSessao`, e só o pareamento seguinte limpa.
    const { contatosDaInstancia, provedorEvolution } = await carregarProvedor();

    await contatosDaInstancia("inst");
    await provedorEvolution.iniciarSessao(canal, {});
    await contatosDaInstancia("inst");

    expect(buscas).toBe(2);
  });

  it("esquece a agenda ao desconectar", async () => {
    const { contatosDaInstancia, provedorEvolution } = await carregarProvedor();

    await contatosDaInstancia("inst");
    await provedorEvolution.encerrarSessao(canal);
    await contatosDaInstancia("inst");

    expect(buscas).toBe(2);
  });

  it("não derruba o cache de outra instância", async () => {
    const { contatosDaInstancia, provedorEvolution } = await carregarProvedor();

    await contatosDaInstancia("inst");
    await contatosDaInstancia("outra");
    await provedorEvolution.encerrarSessao(canal);
    await contatosDaInstancia("outra");

    expect(buscas).toBe(2);
  });
});
