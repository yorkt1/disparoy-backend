import { describe, expect, it } from "vitest";
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
