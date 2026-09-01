import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Canal, MensagemSequencia, Spintax } from "@disparoy/dominio";
import { WhatsappService } from "./whatsapp.service";

/**
 * O provedor real fala com a Evolution por HTTP. Aqui ele vira um caderninho:
 * o que interessa é QUAIS passos foram pedidos, não o que o gateway responde.
 */
const enviados: string[] = [];

vi.mock("./evolution-provider", () => ({
  evolutionConfigurada: () => true,
  provedorEvolution: {
    tipo: "qrcode",
    capacidades: {},
    enviar: async (envio: { corpoRenderizado: string }) => {
      enviados.push(envio.corpoRenderizado);
      return { ok: true, idExterno: `id-${enviados.length}` };
    },
    validarNumeros: async () => [],
    iniciarSessao: async () => ({ canalId: "c", qr: "", expiraEm: "" }),
    encerrarSessao: async () => undefined,
  },
}));

vi.mock("./meta-cloud", () => ({
  metaConfigurada: () => false,
  provedorMetaCloud: { tipo: "api_oficial", capacidades: {}, enviar: async () => ({ ok: false }) },
}));

const canal = {
  id: "canal-1",
  nome: "Canal",
  tipoConexao: "qrcode",
  status: "conectado",
  instanciaEvolution: "instancia-1",
} as unknown as Canal;

const sequencia = [
  { id: "m1", tipo: "texto", corpo: "primeira" },
  { id: "m2", tipo: "texto", corpo: "segunda" },
  { id: "m3", tipo: "texto", corpo: "terceira" },
] as unknown as MensagemSequencia[];

describe("retomada da sequência", () => {
  beforeEach(() => {
    enviados.length = 0;
  });

  it("envia tudo quando nada saiu antes", async () => {
    const servico = new WhatsappService();
    await servico.dispararSequencia({
      canal,
      destinatario: { telefone: "+5511999999999", variaveis: {} },
      sequencia,
      variacoes: [],
    });

    expect(enviados).toEqual(["primeira", "segunda", "terceira"]);
  });

  it("não reenvia os passos que já foram entregues", async () => {
    /**
     * O caso que o `pularPassos` existe para cobrir: o job tem retry, e sem
     * ele uma sequência que falha no terceiro passo reenviava os dois
     * primeiros na nova tentativa. A pessoa recebia "primeira" duas vezes — e
     * mensagem repetida em disparo é o que faz o contato denunciar o número.
     */
    const servico = new WhatsappService();
    const resultados = await servico.dispararSequencia({
      canal,
      destinatario: { telefone: "+5511999999999", variaveis: {} },
      sequencia,
      variacoes: [],
      pularPassos: new Set([1, 2]),
    });

    expect(enviados).toEqual(["terceira"]);
    // O passo continua numerado como o terceiro, e não como "o primeiro desta
    // tentativa": é essa numeração que casa com `mensagens_enviadas`.
    expect(resultados.map((r) => r.passo)).toEqual([3]);
  });

  it("não envia nada quando a sequência inteira já saiu", async () => {
    const servico = new WhatsappService();
    const resultados = await servico.dispararSequencia({
      canal,
      destinatario: { telefone: "+5511999999999", variaveis: {} },
      sequencia,
      variacoes: [],
      pularPassos: new Set([1, 2, 3]),
    });

    expect(enviados).toEqual([]);
    expect(resultados).toEqual([]);
  });

  it("interrompe o restante da sequência depois de uma falha", async () => {
    // Insistir depois de um bloqueio só aumenta o risco na conta.
    const servico = new WhatsappService();
    const provedor = servico.provedorPara(canal);
    vi.spyOn(provedor, "enviar").mockResolvedValueOnce({
      ok: false,
      erro: "bloqueado",
      codigo: "conteudo_recusado",
    });

    const resultados = await servico.dispararSequencia({
      canal,
      destinatario: { telefone: "+5511999999999", variaveis: {} },
      sequencia,
      variacoes: [],
    });

    expect(resultados).toHaveLength(1);
    expect(resultados[0].resultado.ok).toBe(false);
    expect(enviados).toEqual([]);
  });
});

/**
 * O sorteio da variação, no lugar em que ele acontece de verdade.
 *
 * Faltava: todos os casos acima passam `variacoes: []`, então nada aqui
 * exercitava `renderizarMensagem` com uma lista real. O domínio tem teste
 * próprio, mas o domínio não é o que dispara — se `dispararSequencia` sorteasse
 * uma vez e reaproveitasse, ou passasse o corpo cru ao provedor, a suíte
 * inteira continuaria verde e todo contato receberia o mesmo texto.
 *
 * É exatamente a suspeita que motivou estes testes, e o que eles respondem:
 * o sorteio é POR ENVIO, não por campanha.
 */
describe("variações no envio", () => {
  const OPCOES = ["Oi", "Olá", "E aí"];

  const variacoes = [
    { id: "s1", nome: "saudacao", opcoes: OPCOES, criadoEm: "" },
  ] as unknown as Spintax[];

  const umPasso = [
    { id: "m1", tipo: "texto", corpo: "{{*saudacao*}} {{1}}" },
  ] as unknown as MensagemSequencia[];

  beforeEach(() => {
    enviados.length = 0;
  });

  it("resolve {{*nome*}} e {{1}} antes de entregar ao provedor", async () => {
    const servico = new WhatsappService();
    await servico.dispararSequencia({
      canal,
      destinatario: { telefone: "+5511999999999", variaveis: { "1": "Ana" } },
      sequencia: umPasso,
      variacoes,
    });

    expect(enviados).toHaveLength(1);
    // O marcador não pode sobrar no que sai: o contato leria "{{*saudacao*}}".
    expect(enviados[0]).not.toContain("{{");
    expect(OPCOES.map((o) => `${o} Ana`)).toContain(enviados[0]);
  });

  it("sorteia por envio: contatos diferentes não recebem todos o mesmo texto", async () => {
    const servico = new WhatsappService();

    // Trinta envios independentes, como o worker faz — um `dispararSequencia`
    // por contato. Com três opções, sair tudo igual tem chance de 3*(1/3)^30:
    // se este teste falhar, é bug, não azar.
    for (let i = 0; i < 30; i += 1) {
      await servico.dispararSequencia({
        canal,
        destinatario: { telefone: `+551199999${String(i).padStart(4, "0")}`, variaveis: {} },
        sequencia: umPasso,
        variacoes,
      });
    }

    expect(enviados).toHaveLength(30);
    expect(new Set(enviados).size).toBeGreaterThan(1);
  });

  it("mantém a referência literal quando a variação não foi carregada", async () => {
    // O worker devolve [] quando a campanha não tem empresa. O texto sai com o
    // marcador visível de propósito — melhor do que sair com o de outra empresa.
    const servico = new WhatsappService();
    await servico.dispararSequencia({
      canal,
      destinatario: { telefone: "+5511999999999", variaveis: {} },
      sequencia: umPasso,
      variacoes: [],
    });

    expect(enviados[0]).toBe("{{*saudacao*}} {{1}}");
  });
});
