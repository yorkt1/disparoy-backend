import { beforeEach, describe, expect, it, vi } from "vitest";
import { DisparoService } from "./disparo.service";
import { LimitesService } from "../comum/limites.service";
import { LIMITES_POR_PLANO, PLANO_PADRAO } from "../comum/limites-empresa";
import type { AuditoriaService } from "../auditoria/auditoria.service";
import type { SupabaseService } from "../supabase/supabase.service";
import type { WhatsappService } from "../whatsapp/whatsapp.service";
import type { ContatoAgendado, FilaService } from "../fila/fila.service";

/**
 * O worker contra os modos de falha que o diagnóstico apontou.
 *
 * O que estes testes conseguem provar e o que NÃO conseguem, dito de saída
 * para ninguém confundir cobertura com garantia:
 *
 *  - PROVAM o comportamento do TypeScript: que a manutenção chama a
 *    reconciliação de agendamentos, que o resultado dela vira job, que a cota
 *    da empresa devolve o contato para `pendente` em vez de marcá-lo `falhou`,
 *    que a reserva respeita o teto do plano.
 *  - NÃO PROVAM a atomicidade do Postgres. `for update skip locked` e
 *    `enfileirado_em is null` só podem ser exercidos com um banco de verdade,
 *    e não há um aqui. O que o dublê abaixo faz é SIMULAR essa semântica
 *    (cada id é entregue uma única vez) para verificar a única coisa que
 *    depende do código: que o worker não reenfileira o que já foi reservado.
 *
 * O dublê do Supabase cobre só o subconjunto do builder que estes caminhos
 * usam — mesma abordagem de `comum/isolamento.test.ts`.
 */

const EMPRESA = "11111111-1111-1111-1111-111111111111";
const CAMPANHA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CANAL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/**
 * O worker lê `AGENDAMENTO_TOLERANCIA_MINUTOS` de `ambiente()`, e `ambiente()`
 * valida o pacote INTEIRO: sem as quatro chaves obrigatórias ele lança, e a
 * manutenção morreria aqui por falta de `.env` — não por defeito nenhum.
 *
 * `vi.stubEnv` e não `process.env.X =`: `process.env` é do PROCESSO e o valor
 * escrito na mão vaza para os outros arquivos da suíte. O motivo completo está
 * no comentário de `vitest.config.ts`, junto do defeito que ele custou.
 */
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://exemplo.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-servico-de-teste");
  vi.stubEnv("JWT_SECRET", "0".repeat(32));
  vi.stubEnv("DATABASE_URL", "postgres://usuario:senha@localhost:5432/teste");
});

type Registro = Record<string, unknown>;
type Banco = Record<string, Registro[]>;

interface ChamadaRpc {
  nome: string;
  args: Registro;
}

class ConsultaFalsa implements PromiseLike<{ data: unknown; error: null; count: number }> {
  private readonly iguais: [string, unknown][] = [];
  private readonly pertence: [string, unknown[]][] = [];
  private operacao: { tipo: "select" | "update" | "insert"; valores?: Registro } = {
    tipo: "select",
  };

  constructor(
    private readonly banco: Banco,
    private readonly tabela: string,
  ) {}

  select(): this {
    return this;
  }
  update(valores: Registro): this {
    this.operacao = { tipo: "update", valores };
    return this;
  }
  insert(valores: Registro): this {
    this.operacao = { tipo: "insert", valores };
    return this;
  }
  eq(coluna: string, valor: unknown): this {
    this.iguais.push([coluna, valor]);
    return this;
  }
  is(coluna: string, valor: unknown): this {
    this.iguais.push([coluna, valor]);
    return this;
  }
  /**
   * Filtra de verdade, e não por capricho: o `update` do planejamento usa
   * `.in("status", ...)` justamente para NÃO ressuscitar campanha expirada ou
   * pausada. Com um `in` que devolve `this` sem olhar nada, o teste dessa
   * proteção passaria com a proteção removida.
   */
  in(coluna: string, valores: unknown[]): this {
    this.pertence.push([coluna, valores]);
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }

  private linhas(): Registro[] {
    return (this.banco[this.tabela] ?? []).filter(
      (l) =>
        this.iguais.every(([coluna, valor]) => l[coluna] === valor) &&
        this.pertence.every(([coluna, valores]) => valores.includes(l[coluna])),
    );
  }

  private executar(): { data: Registro[]; count: number } {
    const casadas = this.linhas();
    if (this.operacao.tipo === "update") {
      for (const linha of casadas) Object.assign(linha, this.operacao.valores);
      return { data: casadas, count: casadas.length };
    }
    if (this.operacao.tipo === "insert") {
      const nova = { ...this.operacao.valores };
      (this.banco[this.tabela] ??= []).push(nova);
      return { data: [nova], count: 1 };
    }
    return { data: casadas, count: casadas.length };
  }

  async maybeSingle(): Promise<{ data: Registro | null; error: null }> {
    return { data: this.executar().data[0] ?? null, error: null };
  }
  async single(): Promise<{ data: Registro | null; error: null }> {
    return this.maybeSingle();
  }
  then<R1 = { data: unknown; error: null; count: number }, R2 = never>(
    aoResolver?: ((v: { data: unknown; error: null; count: number }) => R1 | PromiseLike<R1>) | null,
    aoRejeitar?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const { data, count } = this.executar();
    return Promise.resolve({ data, error: null as null, count }).then(aoResolver, aoRejeitar);
  }
}

/**
 * Monta o dublê. `rpcs` sobrescreve o resultado de uma RPC específica; o que
 * não for declarado devolve `{ data: null, error: null }`, que é o suficiente
 * para as RPCs de observabilidade (métricas, incidentes) não atrapalharem.
 */
function supabaseFalso(
  banco: Banco,
  rpcs: Record<string, (args: Registro) => unknown> = {},
): { servico: SupabaseService; chamadas: ChamadaRpc[] } {
  const chamadas: ChamadaRpc[] = [];
  const servico = {
    tabela: (nome: string) => new ConsultaFalsa(banco, nome),
    db: {
      rpc: async (nome: string, args: Registro = {}) => {
        chamadas.push({ nome, args });
        const feitor = rpcs[nome];
        return { data: feitor ? feitor(args) : null, error: null };
      },
    },
  } as unknown as SupabaseService;

  return { servico, chamadas };
}

function filaFalsa() {
  return {
    agendarContatosEmLote: vi.fn(async (_: ContatoAgendado[]) => undefined),
    replanejar: vi.fn(async () => undefined),
    reenfileirarAgendamento: vi.fn(async () => undefined),
    agendarCampanha: vi.fn(async () => null),
  };
}

const auditoriaFalsa = { registrar: async () => undefined } as unknown as AuditoriaService;

function campanhaEmAndamento(extra: Registro = {}): Registro {
  return {
    id: CAMPANHA,
    nome: "Campanha de teste",
    status: "em_andamento",
    rodada: 0,
    sequencia: [{ tipo: "texto", corpo: "Olá" }],
    iniciada_em: null,
    validar_numeros: false,
    empresa_id: EMPRESA,
    intervalo_contatos_min: 15,
    intervalo_contatos_max: 45,
    intervalo_mensagens_min: 3,
    intervalo_mensagens_max: 9,
    ...extra,
  };
}

function montar(banco: Banco, rpcs: Record<string, (args: Registro) => unknown> = {}) {
  const { servico, chamadas } = supabaseFalso(banco, rpcs);
  const fila = filaFalsa();
  const limites = new LimitesService(servico);
  const disparo = new DisparoService(
    servico,
    auditoriaFalsa,
    {} as unknown as WhatsappService,
    fila as unknown as FilaService,
    limites,
  );
  return { disparo, fila, chamadas, limites };
}

// ===========================================================================
// B, C e D — o agendamento não depende do job sobreviver na fila
// ===========================================================================

describe("campanha agendada continua executável (cenários B, C e D)", () => {
  /**
   * C — campanha marcada para mais de 14 dias.
   *
   * O job do pg-boss pode ter sido apagado pela retenção. A recuperação não
   * olha a fila: ela pergunta ao BANCO quem está `agendada` com a hora
   * vencida. O que este teste prova é que a manutenção de fato faz essa
   * pergunta e transforma a resposta em job — o filtro `agendada_para <=
   * now()` vive no SQL e está coberto na revisão da migration, não aqui.
   */
  it("a manutenção reenfileira toda campanha agendada e vencida", async () => {
    const { disparo, fila } = montar(
      { campanhas: [], campanha_contatos: [], canais: [] },
      {
        reivindicar_agendamentos_vencidos: () => [
          { campanha_id: CAMPANHA, rodada: 0 },
          { campanha_id: "cccccccc-cccc-cccc-cccc-cccccccccccc", rodada: 3 },
        ],
      },
    );

    await disparo.manutencao();

    expect(fila.reenfileirarAgendamento).toHaveBeenCalledTimes(2);
    expect(fila.reenfileirarAgendamento).toHaveBeenCalledWith(CAMPANHA, 0);
    // A rodada acompanha: um job carimbado com rodada errada seria descartado
    // como vencido ao acordar, e a campanha ficaria parada de novo.
    expect(fila.reenfileirarAgendamento).toHaveBeenCalledWith(
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
      3,
    );
  });

  /**
   * D — worker offline por vários dias.
   *
   * Não há estado em memória de processo neste caminho: a primeira manutenção
   * depois do retorno faz exatamente a mesma pergunta e encontra tudo que
   * venceu enquanto ninguém estava olhando. O teste que prova isso é o de
   * cima; este garante o outro lado — que a reivindicação é consultada em TODA
   * rodada de manutenção, e não uma vez no boot.
   */
  it("a reconciliação de agendamentos roda em toda manutenção", async () => {
    const { disparo, chamadas } = montar({ campanhas: [], canais: [] });

    await disparo.manutencao();
    await disparo.manutencao();

    const vezes = chamadas.filter((c) => c.nome === "reivindicar_agendamentos_vencidos").length;
    expect(vezes).toBe(2);
  });

  it("nada é enfileirado quando não há agendamento vencido", async () => {
    const { disparo, fila } = montar(
      { campanhas: [], canais: [] },
      { reivindicar_agendamentos_vencidos: () => [] },
    );

    await disparo.manutencao();

    expect(fila.reenfileirarAgendamento).not.toHaveBeenCalled();
  });

  /**
   * Uma manutenção que estoura no meio deixa de reconciliar o resto — e a
   * rotina que conserta o sistema seria a primeira a parar justamente quando
   * ele está ruim. O erro da RPC precisa ser absorvido.
   */
  it("erro ao reivindicar não derruba o resto da manutenção", async () => {
    const { servico, chamadas } = supabaseFalso({ campanhas: [], canais: [] });
    // Só esta RPC falha; as demais seguem normais.
    const original = servico.db.rpc.bind(servico.db);
    (servico.db as unknown as { rpc: unknown }).rpc = async (nome: string, args: Registro = {}) =>
      nome === "reivindicar_agendamentos_vencidos"
        ? (chamadas.push({ nome, args }), { data: null, error: { message: "sem conexão" } })
        : original(nome, args);

    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await expect(disparo.manutencao()).resolves.toBeUndefined();
    // Chegou até o fim: a limpeza de cotas é a última coisa da rotina.
    expect(chamadas.some((c) => c.nome === "limpar_cotas_empresa_antigas")).toBe(true);
  });
});

// ===========================================================================
// Agendamento que perdeu a hora não sai atrasado — ele falha
// ===========================================================================

describe("agendamento expirado", () => {
  /** Canal conectado no banco: sem ele o planejamento falha por outro motivo. */
  function comCanalConectado(banco: Banco): Banco {
    banco.campanha_canais = [
      {
        campanha_id: CAMPANHA,
        canais: {
          id: CANAL,
          nome: "canal",
          numero: "+5511900000000",
          instancia_evolution: "disparoy_x_abc",
          tipo_conexao: "qrcode",
          status: "conectado",
          limite_diario: null,
          estagio_aquecimento: 1,
          enviadas_hoje: 0,
          solicitado_em: "2026-01-01T00:00:00.000Z",
          conectado_em: "2026-01-01T00:00:00.000Z",
          meta_phone_number_id: null,
          estado_gateway: "open",
          estado_verificado_em: "2026-01-01T00:00:00.000Z",
          foto_url: null,
        },
      },
    ];
    return banco;
  }

  /**
   * Dublê de `expirar_agendamento_se_vencido`: devolve linha quando expirou,
   * conjunto vazio quando não havia o que expirar. É o contrato do UPDATE
   * condicional — a decisão é do banco, e o worker só lê a resposta.
   */
  const expirou = () => [
    { atraso_segundos: 21_600, motivo: "O horário agendado passou há 6 h 0 min..." },
  ];
  const naoExpirou = () => [];

  /**
   * O defeito que motivou tudo isto: worker fora do ar na hora marcada, volta
   * depois, e o pg-boss entrega o job com o `startAfter` já vencido — portanto
   * na hora. Nenhuma varredura opina, porque o job existe.
   */
  it("campanha agendada fora da tolerância não enfileira contato nenhum", async () => {
    const banco = comCanalConectado({
      campanhas: [campanhaEmAndamento({ status: "agendada" })],
      canais: [],
    });
    const { servico, chamadas } = supabaseFalso(banco, {
      expirar_agendamento_se_vencido: expirou,
      reservar_contatos_pendentes: () => [{ contato_id: 1 }],
    });
    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });

    expect(fila.agendarContatosEmLote).not.toHaveBeenCalled();
    // Nem chegou a reservar: parar depois da reserva deixaria os contatos com
    // `enfileirado_em` preenchido para jobs que nunca existiram.
    expect(chamadas.some((c) => c.nome === "reservar_contatos_pendentes")).toBe(false);
    expect(banco.campanhas[0].status).toBe("agendada");
  });

  /** O operador precisa saber QUAL campanha não saiu, não só que algo falhou. */
  it("a expiração abre incidente de infra com a campanha", async () => {
    const banco = comCanalConectado({
      campanhas: [campanhaEmAndamento({ status: "agendada" })],
      canais: [],
    });
    const { servico, chamadas } = supabaseFalso(banco, {
      expirar_agendamento_se_vencido: expirou,
    });
    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });

    const incidente = chamadas.find((c) => c.nome === "abrir_incidente");
    expect(incidente?.args.p_codigo).toBe("agendamento_expirado");
    // `infra` e não `canal`: o horário passou porque o NOSSO processo não
    // estava de pé, não porque o WhatsApp do cliente caiu.
    expect(incidente?.args.p_categoria).toBe("infra");
    expect(incidente?.args.p_campanha_id).toBe(CAMPANHA);
  });

  /** Dentro da tolerância, um atraso de minutos não pode matar a campanha. */
  it("campanha agendada dentro da tolerância segue e enfileira", async () => {
    const banco = comCanalConectado({
      campanhas: [campanhaEmAndamento({ status: "agendada" })],
      canais: [],
    });
    const { servico } = supabaseFalso(banco, {
      expirar_agendamento_se_vencido: naoExpirou,
      reservar_contatos_pendentes: () => [{ contato_id: 1 }],
      reservar_janela_de_envio: () => new Date().toISOString(),
    });
    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });

    expect(fila.agendarContatosEmLote).toHaveBeenCalledTimes(1);
    expect(banco.campanhas[0].status).toBe("em_andamento");
  });

  /**
   * A corrida de verdade: a campanha estava `agendada` quando este worker a
   * leu, e outro a expirou antes da promoção. O compare-and-swap do banco
   * devolve vazio para este — ele não sabe que perdeu, e sem o
   * `.in("status", ...)` da promoção escreveria `em_andamento` por cima do
   * `falhou` que o outro acabou de gravar. A campanha sairia inteira, atrasada.
   */
  it("expiração feita por outro worker não é desfeita pela promoção", async () => {
    const banco = comCanalConectado({
      campanhas: [campanhaEmAndamento({ status: "agendada" })],
      canais: [],
    });
    const { servico } = supabaseFalso(banco, {
      // O outro worker chegou primeiro: gravou `falhou` e este recebe vazio.
      expirar_agendamento_se_vencido: () => {
        banco.campanhas[0].status = "falhou";
        return [];
      },
      reservar_contatos_pendentes: () => [{ contato_id: 1 }],
      reservar_janela_de_envio: () => new Date().toISOString(),
    });
    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });

    expect(banco.campanhas[0].status).toBe("falhou");
  });

  /**
   * `falhou` é terminal: nada no produto retoma uma campanha nesse estado
   * (`retomar` a recusa, `campanhas_a_replanejar` só olha `em_andamento`).
   * Um replanejamento que chegasse assim mesmo — retry do pg-boss, job antigo
   * acordando — é sempre engano.
   */
  it("campanha já marcada falhou não volta para em_andamento", async () => {
    const banco = comCanalConectado({
      campanhas: [campanhaEmAndamento({ status: "falhou" })],
      canais: [],
    });
    const { servico, chamadas } = supabaseFalso(banco, {
      expirar_agendamento_se_vencido: naoExpirou,
      reservar_contatos_pendentes: () => [{ contato_id: 1 }],
    });
    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });

    expect(banco.campanhas[0].status).toBe("falhou");
    expect(fila.agendarContatosEmLote).not.toHaveBeenCalled();
    // Nem perguntou o horário: `falhou` já é terminal, e a RPC só existe para
    // decidir sobre campanha que ainda está `agendada`.
    expect(chamadas.some((c) => c.nome === "expirar_agendamento_se_vencido")).toBe(false);
  });

  /**
   * Erro do banco no meio da conferência não pode virar "então manda".
   *
   * Relançar devolve o job ao retry do pg-boss com a campanha ainda
   * `agendada`: ou a retentativa consegue perguntar e ela sai no horário, ou a
   * tolerância passa e a varredura da manutenção a expira. Engolir o erro
   * seria o defeito original voltando pela porta do tratamento de erro.
   */
  it("erro ao conferir o horário aborta o planejamento em vez de enviar", async () => {
    const banco = comCanalConectado({
      campanhas: [campanhaEmAndamento({ status: "agendada" })],
      canais: [],
    });
    const { servico } = supabaseFalso(banco);
    const original = servico.db.rpc.bind(servico.db);
    (servico.db as unknown as { rpc: unknown }).rpc = async (nome: string, args: Registro = {}) =>
      nome === "expirar_agendamento_se_vencido"
        ? { data: null, error: { message: "sem conexão" } }
        : original(nome, args);

    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await expect(disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 })).rejects.toThrow();
    expect(fila.agendarContatosEmLote).not.toHaveBeenCalled();
    expect(banco.campanhas[0].status).toBe("agendada");
  });

  /**
   * O outro modo de falha: o job do pg-boss sumiu (retenção, fila recriada) e
   * ninguém vai chamar `planejarCampanha` daquela campanha nunca mais. Sem a
   * varredura ela ficaria `agendada` para sempre — sem envio e sem aviso.
   */
  it("a manutenção expira o que passou da tolerância antes de reenfileirar", async () => {
    const ordem: string[] = [];
    const { disparo, fila } = montar(
      { campanhas: [], campanha_contatos: [], canais: [] },
      {
        expirar_agendamentos_vencidos: () => {
          ordem.push("expirar");
          return [
            {
              campanha_id: CAMPANHA,
              empresa_id: EMPRESA,
              nome: "Promoção de terça",
              atraso_segundos: 90_000,
              motivo: "O horário agendado passou há 1 d 1 h...",
            },
          ];
        },
        reivindicar_agendamentos_vencidos: () => {
          ordem.push("reivindicar");
          return [];
        },
      },
    );

    await disparo.manutencao();

    // A ordem é o mecanismo: invertidas, a mesma rodada enfileiraria a
    // campanha atrasada e só depois a expiraria — com o job já em voo.
    expect(ordem).toEqual(["expirar", "reivindicar"]);
    expect(fila.reenfileirarAgendamento).not.toHaveBeenCalled();
  });

  /** A varredura é observabilidade: falhar nela não pode derrubar o resto. */
  it("erro ao expirar não derruba a manutenção", async () => {
    const { servico, chamadas } = supabaseFalso({ campanhas: [], canais: [] });
    const original = servico.db.rpc.bind(servico.db);
    (servico.db as unknown as { rpc: unknown }).rpc = async (nome: string, args: Registro = {}) =>
      nome === "expirar_agendamentos_vencidos"
        ? (chamadas.push({ nome, args }), { data: null, error: { message: "sem conexão" } })
        : original(nome, args);

    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await expect(disparo.manutencao()).resolves.toBeUndefined();
    // Chegou até o fim: a limpeza de cotas é a última coisa da rotina.
    expect(chamadas.some((c) => c.nome === "limpar_cotas_empresa_antigas")).toBe(true);
  });

  /**
   * O teto precisa chegar ao SQL: é lá, com o relógio único, que "venceu
   * demais" é decidido. Uma reivindicação sem tolerância voltaria a
   * reenfileirar campanha da semana passada.
   */
  it("a reivindicação recebe a tolerância junto da carência", async () => {
    const { disparo, chamadas } = montar({ campanhas: [], canais: [] });

    await disparo.manutencao();

    const claim = chamadas.find((c) => c.nome === "reivindicar_agendamentos_vencidos");
    expect(typeof claim?.args.p_tolerancia_minutos).toBe("number");
    // A carência precisa caber DENTRO da tolerância, senão a segunda tentativa
    // de reenfileirar nunca acontece: a campanha expira antes de ser retentada.
    expect(Number(claim?.args.p_carencia_minutos)).toBeLessThan(
      Number(claim?.args.p_tolerancia_minutos),
    );
  });
});

// ===========================================================================
// E — dois processos disputando o mesmo contato
// ===========================================================================

describe("reserva de contatos (cenário E)", () => {
  /**
   * Simula o `for update skip locked` do Postgres: cada id sai UMA vez.
   *
   * É o contrato que `reservar_contatos_pendentes` cumpre no banco. O que se
   * verifica aqui é o lado que depende do código: dois planejamentos
   * concorrentes da mesma campanha não podem agendar o mesmo contato duas
   * vezes.
   */
  function reservaComSkipLocked(disponiveis: number[]) {
    const restantes = [...disponiveis];
    return (args: Registro) => {
      const limite = Number(args.p_limite ?? 0);
      return restantes.splice(0, limite).map((id) => ({ contato_id: id }));
    };
  }

  it("dois planejamentos concorrentes não enfileiram o mesmo contato", async () => {
    const banco: Banco = {
      campanhas: [campanhaEmAndamento()],
      campanha_canais: [],
      canais: [],
    };

    const { servico } = supabaseFalso(banco, {
      reservar_contatos_pendentes: reservaComSkipLocked([1, 2, 3, 4]),
      reservar_janela_de_envio: () => new Date().toISOString(),
    });

    // `canaisConectadosDa` lê `campanha_canais` com join; o dublê devolve a
    // linha crua, então o canal entra pela tabela `campanha_canais`.
    banco.campanha_canais.push({
      campanha_id: CAMPANHA,
      canais: {
        id: CANAL,
        nome: "canal",
        numero: "+5511900000000",
        instancia_evolution: "disparoy_x_abc",
        tipo_conexao: "qrcode",
        status: "conectado",
        limite_diario: null,
        estagio_aquecimento: 1,
        enviadas_hoje: 0,
        solicitado_em: "2026-01-01T00:00:00.000Z",
        conectado_em: "2026-01-01T00:00:00.000Z",
        meta_phone_number_id: null,
        estado_gateway: "open",
        estado_verificado_em: "2026-01-01T00:00:00.000Z",
        foto_url: null,
      },
    });

    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await Promise.all([
      disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 }),
      disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 }),
    ]);

    const enfileirados = fila.agendarContatosEmLote.mock.calls
      .flatMap(([lote]) => lote)
      .map((c) => c.dados.contatoId);

    expect([...enfileirados].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(new Set(enfileirados).size).toBe(enfileirados.length);
  });

  /** O teto do plano é o que impede uma campanha grande de travar a fila. */
  it("a reserva pede ao banco o teto de contatos do plano", async () => {
    const banco: Banco = { campanhas: [campanhaEmAndamento()], campanha_canais: [], canais: [] };
    const { servico, chamadas } = supabaseFalso(banco, {
      reservar_contatos_pendentes: () => [],
    });

    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    // Sem canal conectado a campanha falha antes de reservar; o canal entra
    // para o caminho chegar até a reserva.
    banco.campanha_canais.push({
      campanha_id: CAMPANHA,
      canais: {
        id: CANAL,
        nome: "canal",
        numero: "+5511900000000",
        instancia_evolution: "disparoy_x_abc",
        tipo_conexao: "qrcode",
        status: "conectado",
        limite_diario: null,
        estagio_aquecimento: 1,
        enviadas_hoje: 0,
        solicitado_em: "2026-01-01T00:00:00.000Z",
        conectado_em: "2026-01-01T00:00:00.000Z",
        meta_phone_number_id: null,
        estado_gateway: "open",
        estado_verificado_em: "2026-01-01T00:00:00.000Z",
        foto_url: null,
      },
    });

    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });

    const reserva = chamadas.find((c) => c.nome === "reservar_contatos_pendentes");
    expect(reserva?.args.p_limite).toBe(LIMITES_POR_PLANO[PLANO_PADRAO].contatosPorPlanejamento);
  });
});

// ===========================================================================
// A linha do tempo da campanha — levas não podem se sobrepor
// ===========================================================================

describe("janela de envio", () => {
  /** Dublê de `reservar_janela_de_envio`: guarda `fila_ate` e o empurra. */
  function janelaSimulada(estado: { filaAte: number }) {
    return {
      reservar_janela_de_envio: (args: Registro) => {
        const inicio = Math.max(estado.filaAte, Date.now());
        estado.filaAte = inicio + Number(args.p_duracao_segundos) * 1000;
        return new Date(inicio).toISOString();
      },
      devolver_janela_de_envio: (args: Registro) => {
        const gravado =
          new Date(String(args.p_inicio)).getTime() + Number(args.p_duracao_segundos) * 1000;
        // Compare-and-swap: só devolve se ninguém mexeu depois.
        if (estado.filaAte !== gravado) return false;
        estado.filaAte = new Date(String(args.p_inicio)).getTime();
        return true;
      },
    };
  }

  function canalConectado(): Registro {
    return {
      campanha_id: CAMPANHA,
      canais: {
        id: CANAL,
        nome: "canal",
        numero: "+5511900000000",
        instancia_evolution: "disparoy_x_abc",
        tipo_conexao: "qrcode",
        status: "conectado",
        limite_diario: null,
        estagio_aquecimento: 1,
        enviadas_hoje: 0,
        solicitado_em: "2026-01-01T00:00:00.000Z",
        conectado_em: "2026-01-01T00:00:00.000Z",
        meta_phone_number_id: null,
        estado_gateway: "open",
        estado_verificado_em: "2026-01-01T00:00:00.000Z",
        foto_url: null,
      },
    };
  }

  /**
   * O defeito que a janela conserta: cada planejamento começava o atraso em
   * ZERO, então a segunda leva caía POR CIMA da primeira e a cadência de
   * 15–45 s virava dois envios no mesmo instante — o padrão que faz o número
   * ser bloqueado. Vale para as levas da paginação e para os contatos que a
   * reconciliação devolve, que já sofriam disso antes desta mudança.
   */
  it("a segunda leva é agendada DEPOIS da primeira, nunca por cima", async () => {
    const estado = { filaAte: 0 };
    const restantes = [1, 2, 3, 4, 5, 6];
    const banco: Banco = {
      campanhas: [campanhaEmAndamento()],
      campanha_canais: [canalConectado()],
      canais: [],
    };

    const { servico } = supabaseFalso(banco, {
      ...janelaSimulada(estado),
      reservar_contatos_pendentes: () => restantes.splice(0, 3).map((id) => ({ contato_id: id })),
    });

    const fila = filaFalsa();
    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });
    await disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 });

    const levas = fila.agendarContatosEmLote.mock.calls.map(([lote]) => lote);
    expect(levas).toHaveLength(2);

    const ultimoDaPrimeira = Math.max(...levas[0].map((c) => c.atrasoSegundos));
    const primeiroDaSegunda = Math.min(...levas[1].map((c) => c.atrasoSegundos));

    expect(primeiroDaSegunda).toBeGreaterThan(ultimoDaPrimeira);
  });

  /**
   * Enfileiramento que falha devolve a janela.
   *
   * Sem isto, `fila_ate` ficaria empurrado por uma leva que não virou job
   * nenhum, e o replanejamento seguinte agendaria depois do buraco — numa leva
   * de 2.000 contatos são ~16 h de silêncio, sem nada na tela explicando.
   */
  it("janela é devolvida quando o enfileiramento falha", async () => {
    const estado = { filaAte: 0 };
    const banco: Banco = {
      campanhas: [campanhaEmAndamento()],
      campanha_canais: [canalConectado()],
      canais: [],
    };

    const { servico, chamadas } = supabaseFalso(banco, {
      ...janelaSimulada(estado),
      reservar_contatos_pendentes: () => [{ contato_id: 1 }, { contato_id: 2 }],
    });

    const fila = filaFalsa();
    fila.agendarContatosEmLote = vi.fn(async () => {
      throw new Error("fila fora do ar");
    });

    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      fila as unknown as FilaService,
      new LimitesService(servico),
    );

    const antes = estado.filaAte;
    await expect(disparo.planejarCampanha({ campanhaId: CAMPANHA, rodada: 0 })).rejects.toThrow(
      /fila fora do ar/,
    );

    expect(chamadas.some((c) => c.nome === "devolver_janela_de_envio")).toBe(true);
    // Voltou para onde estava: a leva que não saiu não deixou buraco.
    expect(estado.filaAte).toBeLessThanOrEqual(Math.max(antes, Date.now()));
  });
});

// ===========================================================================
// G — cliente ultrapassa o limite diário
// ===========================================================================

describe("limite diário da empresa no caminho do envio (cenário G)", () => {
  function bancoDeEnvio(): Banco {
    return {
      campanhas: [campanhaEmAndamento()],
      empresas: [{ id: EMPRESA, plano: PLANO_PADRAO }],
      canais: [
        {
          id: CANAL,
          nome: "canal",
          numero: "+5511900000000",
          instancia_evolution: "disparoy_x_abc",
          tipo_conexao: "qrcode",
          status: "conectado",
          limite_diario: null,
          estagio_aquecimento: 1,
          enviadas_hoje: 0,
          solicitado_em: "2026-01-01T00:00:00.000Z",
          conectado_em: "2026-01-01T00:00:00.000Z",
          meta_phone_number_id: null,
          estado_gateway: "open",
          estado_verificado_em: "2026-01-01T00:00:00.000Z",
          foto_url: null,
        },
      ],
      campanha_contatos: [
        {
          id: 1,
          campanha_id: CAMPANHA,
          contato_id: null,
          telefone: "+5511900000001",
          variaveis: {},
          status: "pendente",
          enfileirado_em: "2026-01-01T00:00:00.000Z",
          enviando_desde: null,
        },
      ],
      mensagens_enviadas: [],
    };
  }

  /**
   * O contato volta para `pendente`, NÃO vira `falhou`.
   *
   * É a regra que o resto do worker já segue para falha de canal (ver
   * `ARQUITETURA-ATRIBUICAO-DE-FALHA.md`): culpa que não é do destinatário nem
   * do conteúdo devolve o contato à fila. Marcar `falhou` em massa por causa
   * de um limite NOSSO destruiria a campanha do cliente sem possibilidade de
   * reenvio — que é exatamente o estrago que o limite deveria evitar.
   */
  it("bloqueia o envio devolvendo o contato para pendente", async () => {
    const banco = bancoDeEnvio();
    const { disparo } = montar(banco, {
      // Teto estourado: a RPC recusa.
      consumir_cota_empresa: () => false,
    });

    await disparo.dispararContato({ campanhaId: CAMPANHA, contatoId: 1, canalId: CANAL, rodada: 0 });

    const contato = banco.campanha_contatos[0];
    expect(contato.status).toBe("pendente");
    expect(contato.enfileirado_em).toBeNull();
    // Nenhuma mensagem foi gravada: o envio não aconteceu.
    expect(banco.mensagens_enviadas).toHaveLength(0);
  });

  /** Adiar por limite é decisão correta e INVISÍVEL: precisa virar incidente. */
  it("registra o bloqueio como incidente, com código próprio", async () => {
    const { disparo, chamadas } = montar(bancoDeEnvio(), {
      consumir_cota_empresa: () => false,
    });

    await disparo.dispararContato({ campanhaId: CAMPANHA, contatoId: 1, canalId: CANAL, rodada: 0 });

    const incidente = chamadas.find(
      (c) => c.nome === "abrir_incidente" && c.args.p_codigo === "limite_empresa_atingido",
    );
    expect(incidente).toBeDefined();
    expect(incidente?.args.p_categoria).toBe("limite");
    expect(incidente?.args.p_campanha_id).toBe(CAMPANHA);
    // A mensagem precisa dizer que nada foi perdido — é a dúvida imediata de
    // quem vê a campanha desacelerar.
    expect(String(incidente?.args.p_detalhe)).toContain("amanhã");
  });

  /**
   * A cota do canal é consumida DEPOIS da da empresa, e quando ela recusa a da
   * empresa volta. Sem isso, um canal com teto baixo queimaria o dia inteiro
   * do cliente em minutos, por envios que nunca aconteceram.
   */
  it("cota da empresa é devolvida quando o canal é quem recusa", async () => {
    const { disparo, chamadas } = montar(bancoDeEnvio(), {
      consumir_cota_empresa: () => true,
      consumir_cota_canal: () => false,
    });

    await disparo.dispararContato({ campanhaId: CAMPANHA, contatoId: 1, canalId: CANAL, rodada: 0 });

    const ordem = chamadas.map((c) => c.nome);
    expect(ordem.indexOf("consumir_cota_empresa")).toBeLessThan(
      ordem.indexOf("consumir_cota_canal"),
    );
    expect(chamadas.some((c) => c.nome === "devolver_cota_empresa")).toBe(true);
  });
});

// ===========================================================================
// Jobs mortos — a informação não pode se perder em silêncio
// ===========================================================================

describe("job morto", () => {
  it("grava uma linha por job, com o payload e o id da dead letter", async () => {
    const { disparo, chamadas } = montar({}, { registrar_job_morto: () => 42 });

    await disparo.registrarJobMorto({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      name: "disparo-mortos",
      data: { campanhaId: CAMPANHA, canalId: CANAL, contatoId: 7 },
    });

    const registro = chamadas.find((c) => c.nome === "registrar_job_morto");
    expect(registro).toBeDefined();
    expect(registro?.args.p_job_id).toBe("dddddddd-dddd-dddd-dddd-dddddddddddd");
    expect(registro?.args.p_payload).toEqual({
      campanhaId: CAMPANHA,
      canalId: CANAL,
      contatoId: 7,
    });
    // A fila de ORIGEM é deduzida do payload: o pg-boss não a preserva, e
    // `job.name` na dead letter é sempre "disparo-mortos".
    expect(registro?.args.p_fila).toBe("disparo-contato");
  });

  /**
   * O código do incidente precisa ser PRÓPRIO.
   *
   * `desconhecido` significa outra coisa na taxonomia — "o gateway devolveu um
   * erro que ainda não classificamos" —, e usá-lo aqui fazia o diagnóstico de
   * falhas de envio contar job morto junto, mandando o operador procurar um
   * problema de WhatsApp que não existia.
   */
  it("abre incidente com código próprio e aponta para o registro", async () => {
    const { disparo, chamadas } = montar({}, { registrar_job_morto: () => 99 });

    await disparo.registrarJobMorto({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      name: "disparo-mortos",
      data: { campanhaId: CAMPANHA, contatoId: 7 },
    });

    const incidente = chamadas.find((c) => c.nome === "abrir_incidente");
    expect(incidente?.args.p_codigo).toBe("job_morto");
    expect(incidente?.args.p_categoria).toBe("infra");
    expect(String(incidente?.args.p_detalhe)).toContain("reprocessar_job_morto(99)");
  });

  /** Falhar ao registrar a falha é o único caso sem para onde escalar. */
  it("ainda abre o incidente quando a gravação do job morto falha", async () => {
    const { servico, chamadas } = supabaseFalso({});
    const original = servico.db.rpc.bind(servico.db);
    (servico.db as unknown as { rpc: unknown }).rpc = async (nome: string, args: Registro = {}) =>
      nome === "registrar_job_morto"
        ? (chamadas.push({ nome, args }), { data: null, error: { message: "tabela ausente" } })
        : original(nome, args);

    const disparo = new DisparoService(
      servico,
      auditoriaFalsa,
      {} as unknown as WhatsappService,
      filaFalsa() as unknown as FilaService,
      new LimitesService(servico),
    );

    await disparo.registrarJobMorto({ id: undefined, name: "disparo-mortos", data: {} });

    const incidente = chamadas.find((c) => c.nome === "abrir_incidente");
    expect(incidente).toBeDefined();
    expect(String(incidente?.args.p_detalhe)).toContain("NÃO pôde ser gravado");

    /*
     * E NÃO inventa um registro que não existe.
     *
     * Este teste pegou um defeito de verdade: `Number(null)` é 0 e
     * `Number.isFinite(0)` é `true`, então a gravação falhando produzia um
     * incidente mandando o operador rodar `reprocessar_job_morto(0)`. Um
     * ponteiro para lugar nenhum é pior que ponteiro nenhum — justamente aqui,
     * que é o caminho de PERDER a informação.
     */
    expect(String(incidente?.args.p_detalhe)).not.toContain("reprocessar_job_morto(0)");
  });
});
