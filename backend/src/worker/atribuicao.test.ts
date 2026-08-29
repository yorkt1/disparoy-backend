import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Canal, CodigoFalha } from "@disparoy/dominio";
import type { AuditoriaService } from "../auditoria/auditoria.service";
import type { SupabaseService } from "../supabase/supabase.service";
import type { WhatsappService } from "../whatsapp/whatsapp.service";
import type { FilaService, JobContato } from "../fila/fila.service";
import { LimitesService } from "../comum/limites.service";

/**
 * Atribuição de falha: o veredito do gateway.
 *
 * O arquivo que `ARQUITETURA-ATRIBUICAO-DE-FALHA.md` cita na tabela de testes e
 * que nunca tinha sido escrito. `disparo.test.ts` cobre planejamento, reserva e
 * cota; a decisão de QUEM levou a culpa não era exercida em lugar nenhum — a
 * peça que o documento chama de "a que responde à sua pergunta".
 *
 * O que estes testes provam e o que NÃO provam:
 *
 *  - PROVAM a decisão dentro de `tratarSuspeitaDeCanal`: que resposta do
 *    gateway leva a contato `falhou`, que resposta devolve o contato para
 *    `pendente`, quando o canal é rebaixado e quando o código é trocado.
 *  - NÃO PROVAM a ligação entre `dispararContato` e essa decisão para os
 *    códigos de infra: chegar até lá pelo caminho público exige simular o
 *    pipeline de envio inteiro.
 *
 * A chamada é direta ao método privado, de propósito: o que está sob teste é
 * uma decisão sobre quatro entradas, e alcançá-la por fora acrescentaria
 * dezenas de linhas de dublê sem acrescentar uma asserção.
 */

/*
 * `vi.hoisted` é o que permite ao dublê existir antes da fábrica do `vi.mock`.
 *
 * O `vi.mock` é içado acima de TODOS os imports do arquivo, inclusive o de
 * `disparo.service` logo abaixo — por isso o serviço já enxerga esta função no
 * lugar da verdadeira. Sem `vi.hoisted`, declarar o `vi.fn()` aqui em cima
 * ainda seria tarde demais e a fábrica leria `undefined`.
 *
 * O resto do módulo fica intacto (`original()`): `disparo.service.ts` importa
 * várias outras funções de lá e todas continuam reais.
 */
const estadoDaInstancia = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock("../whatsapp/evolution-provider", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  estadoDaInstancia,
}));

import { DisparoService } from "./disparo.service";

const CAMPANHA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CANAL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface Atualizacao {
  tabela: string;
  valores: Record<string, unknown>;
}

interface ChamadaRpc {
  nome: string;
  args: Record<string, unknown>;
}

/**
 * Dublê que registra o que foi ESCRITO, que é o produto destes testes.
 *
 * Toda leitura devolve vazio: nenhum caminho exercido aqui depende do que o
 * banco responde — `concluir_campanha_se_terminou` devolvendo `null` já encerra
 * `finalizarSeTerminou` na primeira linha.
 */
function supabaseFalso(): {
  servico: SupabaseService;
  atualizacoes: Atualizacao[];
  rpcs: ChamadaRpc[];
} {
  const atualizacoes: Atualizacao[] = [];
  const rpcs: ChamadaRpc[] = [];

  const consulta = (tabela: string) => {
    const alvo = {
      update(valores: Record<string, unknown>) {
        atualizacoes.push({ tabela, valores });
        return alvo;
      },
      select: () => alvo,
      eq: () => alvo,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolver: (v: { data: null; error: null }) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolver),
    };
    return alvo;
  };

  const servico = {
    tabela: consulta,
    db: {
      rpc: async (nome: string, args: Record<string, unknown> = {}) => {
        rpcs.push({ nome, args });
        return { data: null, error: null };
      },
    },
  } as unknown as SupabaseService;

  return { servico, atualizacoes, rpcs };
}

function canalConectado(extra: Partial<Canal> = {}): Canal {
  return {
    id: CANAL,
    nome: "Canal de teste",
    numero: "+5511900000000",
    instanciaEvolution: "disparoy_x_abc",
    tipoConexao: "qrcode",
    status: "conectado",
    limiteDiario: null,
    estagioAquecimento: 1,
    enviadasHoje: 0,
    solicitadoEm: "2026-01-01T00:00:00.000Z",
    conectadoEm: "2026-01-01T00:00:00.000Z",
    estadoGateway: "open",
    estadoVerificadoEm: "2026-01-01T00:00:00.000Z",
    fotoUrl: null,
    ...extra,
  };
}

const JOB: JobContato = { campanhaId: CAMPANHA, contatoId: 1, canalId: CANAL };

/** O método sob teste é privado; o acesso é explícito em vez de disfarçado. */
interface ComAtribuicao {
  tratarSuspeitaDeCanal(
    job: JobContato,
    canal: Canal,
    suspeita: CodigoFalha,
    detalhe: string,
  ): Promise<void>;
}

function montar() {
  const { servico, atualizacoes, rpcs } = supabaseFalso();
  const auditoria = { registrar: async () => undefined } as unknown as AuditoriaService;

  const disparo = new DisparoService(
    servico,
    auditoria,
    {} as unknown as WhatsappService,
    {} as unknown as FilaService,
    new LimitesService(servico),
  );

  return {
    atribuir: (disparo as unknown as ComAtribuicao).tratarSuspeitaDeCanal.bind(disparo),
    atualizacoes,
    rpcs,
  };
}

/** O que foi gravado em `campanha_contatos`, que é onde o contato morre. */
function encerramentos(atualizacoes: Atualizacao[]): Record<string, unknown>[] {
  return atualizacoes.filter((a) => a.tabela === "campanha_contatos").map((a) => a.valores);
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://exemplo.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-servico-de-teste");
  vi.stubEnv("JWT_SECRET", "0".repeat(32));
  vi.stubEnv("DATABASE_URL", "postgres://usuario:senha@localhost:5432/teste");
  estadoDaInstancia.mockReset();
});

describe("gateway responde `open`", () => {
  /**
   * O caso que a tabela do documento descreve: a suspeita era de canal, o
   * gateway a desmentiu, sobrou o destinatário ou o conteúdo.
   */
  it("suspeita de canal vira falha do contato, sem pausar a campanha", async () => {
    estadoDaInstancia.mockResolvedValue("open");
    const { atribuir, atualizacoes, rpcs } = montar();

    await atribuir(JOB, canalConectado(), "canal_desconectado", "status local do canal");

    expect(encerramentos(atualizacoes)).toEqual([
      expect.objectContaining({ status: "falhou", falha_codigo: "canal_desconectado" }),
    ]);
    expect(rpcs.map((r) => r.nome)).not.toContain("pausar_campanha_por_canal");
  });

  /** Template recusado é culpa do conteúdo: falha de verdade, e definitiva. */
  it("suspeita de conteúdo vira falha do contato", async () => {
    estadoDaInstancia.mockResolvedValue("open");
    const { atribuir, atualizacoes } = montar();

    await atribuir(JOB, canalConectado(), "template_rejeitado", "template fora do ar");

    expect(encerramentos(atualizacoes)).toEqual([
      expect.objectContaining({ status: "falhou", falha_codigo: "template_rejeitado" }),
    ]);
  });

  /**
   * O defeito que este arquivo nasceu para travar.
   *
   * Sessão viva prova que o WhatsApp do CLIENTE está de pé — não prova nada
   * sobre a nossa infraestrutura. Um envio pode estourar timeout enquanto a
   * consulta de estado, feita logo depois e mais barata, responde normalmente.
   * O contato era encerrado como `falhou` carregando `falha_categoria = infra`,
   * sem reenvio possível, apesar de `retentavel: true` na taxonomia.
   */
  it("suspeita de infra NÃO encerra o contato, mesmo com a sessão viva", async () => {
    estadoDaInstancia.mockResolvedValue("open");
    const { atribuir, atualizacoes, rpcs } = montar();

    await atribuir(JOB, canalConectado(), "gateway_timeout", "socket hang up");

    expect(encerramentos(atualizacoes)).toEqual([]);
    expect(rpcs.map((r) => r.nome)).toContain("pausar_campanha_por_canal");
  });

  it("suspeita de configuração também não encerra o contato", async () => {
    estadoDaInstancia.mockResolvedValue("open");
    const { atribuir, atualizacoes, rpcs } = montar();

    await atribuir(JOB, canalConectado(), "canal_mal_configurado", "webhook ausente");

    expect(encerramentos(atualizacoes)).toEqual([]);
    expect(rpcs.map((r) => r.nome)).toContain("pausar_campanha_por_canal");
  });

  /** Culpa nossa não pode virar incidente no nome do cliente. */
  it("o incidente de culpa nossa conserva o código de infra", async () => {
    estadoDaInstancia.mockResolvedValue("open");
    const { atribuir, rpcs } = montar();

    await atribuir(JOB, canalConectado(), "gateway_timeout", "socket hang up");

    const incidente = rpcs.find((r) => r.nome === "abrir_incidente");
    expect(incidente?.args.p_codigo).toBe("gateway_timeout");
    expect(incidente?.args.p_categoria).toBe("infra");
  });

  /** A sessão está viva: rebaixar o canal seria acusar o inocente. */
  it("não rebaixa o canal quando a culpa é nossa", async () => {
    estadoDaInstancia.mockResolvedValue("open");
    const { atribuir, atualizacoes } = montar();

    await atribuir(JOB, canalConectado(), "gateway_timeout", "socket hang up");

    const status = atualizacoes.filter((a) => a.tabela === "canais").map((a) => a.valores.status);
    expect(status).not.toContain("desconectado");
  });

  /** O cache mentia; o gateway respondeu. Corrigir vale para qualquer culpa. */
  it("corrige o cache do canal que estava desatualizado", async () => {
    estadoDaInstancia.mockResolvedValue("open");
    const { atribuir, atualizacoes } = montar();

    await atribuir(JOB, canalConectado({ status: "desconectado" }), "gateway_timeout", "x");

    const status = atualizacoes.filter((a) => a.tabela === "canais").map((a) => a.valores.status);
    expect(status).toContain("conectado");
  });
});

describe("gateway confirma a queda", () => {
  it("`close` rebaixa o canal e devolve o contato para a fila", async () => {
    estadoDaInstancia.mockResolvedValue("close");
    const { atribuir, atualizacoes, rpcs } = montar();

    await atribuir(JOB, canalConectado(), "canal_desconectado", "connection closed");

    expect(encerramentos(atualizacoes)).toEqual([]);
    expect(rpcs.map((r) => r.nome)).toContain("pausar_campanha_por_canal");

    const canais = atualizacoes.filter((a) => a.tabela === "canais").map((a) => a.valores);
    expect(canais).toContainEqual(
      expect.objectContaining({ status: "desconectado", ultimo_erro_codigo: "canal_desconectado" }),
    );
  });
});

describe("gateway não responde", () => {
  /**
   * `indisponivel` é "não consegui perguntar", nunca "perguntei e caiu". Tratar
   * os dois igual é o bug que a camada inteira existe para corrigir.
   */
  it("troca a suspeita por gateway_indisponivel e não rebaixa o canal", async () => {
    estadoDaInstancia.mockResolvedValue("indisponivel");
    const { atribuir, atualizacoes, rpcs } = montar();

    await atribuir(JOB, canalConectado(), "canal_desconectado", "sem resposta");

    const incidente = rpcs.find((r) => r.nome === "abrir_incidente");
    expect(incidente?.args.p_codigo).toBe("gateway_indisponivel");

    const status = atualizacoes.filter((a) => a.tabela === "canais").map((a) => a.valores.status);
    expect(status).not.toContain("desconectado");
    expect(encerramentos(atualizacoes)).toEqual([]);
  });
});
