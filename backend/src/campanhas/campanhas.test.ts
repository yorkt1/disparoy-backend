import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CampanhasService } from "./campanhas.service";
import { LimitesService } from "../comum/limites.service";
import { LIMITES_POR_PLANO, PLANO_PADRAO } from "../comum/limites-empresa";
import type { AuditoriaService } from "../auditoria/auditoria.service";
import type { CanaisService } from "../canais/canais.service";
import type { FilaService } from "../fila/fila.service";
import type { SupabaseService } from "../supabase/supabase.service";
import type { UsuarioAutenticado } from "../auth/auth.guard";
import type { CampanhaEntrada } from "@disparoy/dominio";

/**
 * Campanhas: persistência independente da fila (cenário A) e isolamento entre
 * empresas na leitura e na escrita (cenário F).
 *
 * O ponto do cenário A é o que o `ROBUSTEZ.md` chama de invariante: o estado
 * mora no BANCO, não na fila. Se o enfileiramento falhar — worker fora,
 * Postgres da fila inalcançável, `FILA_OPCIONAL` ligado — a campanha e o
 * público dela precisam continuar gravados, senão não há o que recuperar
 * depois. Este teste guarda essa ordem: gravar primeiro, enfileirar depois.
 */

const EMPRESA_A = "11111111-1111-1111-1111-111111111111";
const EMPRESA_B = "22222222-2222-2222-2222-222222222222";
const CANAL_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type Registro = Record<string, unknown>;
type Banco = Record<string, Registro[]>;

class ConsultaFalsa implements PromiseLike<{ data: unknown; error: null; count: number }> {
  private readonly iguais: [string, unknown][] = [];
  private readonly dentro: [string, unknown[]][] = [];
  private operacao: { tipo: "select" | "update" | "insert"; valores?: Registro | Registro[] } = {
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
  insert(valores: Registro | Registro[]): this {
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
  in(coluna: string, valores: unknown[]): this {
    this.dentro.push([coluna, valores]);
    return this;
  }
  ilike(): this {
    return this;
  }
  order(): this {
    return this;
  }
  range(): this {
    return this;
  }
  limit(): this {
    return this;
  }

  private linhas(): Registro[] {
    return (this.banco[this.tabela] ?? []).filter(
      (l) =>
        this.iguais.every(([coluna, valor]) => l[coluna] === valor) &&
        this.dentro.every(([coluna, valores]) => valores.includes(l[coluna])),
    );
  }

  private executar(): { data: Registro[]; count: number } {
    const casadas = this.linhas();
    if (this.operacao.tipo === "update") {
      for (const linha of casadas) Object.assign(linha, this.operacao.valores as Registro);
      return { data: casadas, count: casadas.length };
    }
    if (this.operacao.tipo === "insert") {
      const valores = this.operacao.valores;
      const novas = (Array.isArray(valores) ? valores : [valores as Registro]).map((v) => ({
        // Id sorteado como o `default gen_random_uuid()` da tabela faria.
        id: `gerado-${Math.random().toString(36).slice(2, 10)}`,
        ...v,
      }));
      (this.banco[this.tabela] ??= []).push(...novas);
      return { data: novas, count: novas.length };
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

function supabaseFalso(banco: Banco, publicoElegivel = 3): SupabaseService {
  return {
    tabela: (nome: string) => new ConsultaFalsa(banco, nome),
    db: {
      rpc: async (nome: string) => {
        if (nome === "popular_publico_da_campanha") return { data: publicoElegivel, error: null };
        return { data: null, error: null };
      },
    },
  } as unknown as SupabaseService;
}

function campanha(id: string, empresaId: string, status = "em_andamento"): Registro {
  return {
    id,
    nome: `Campanha ${id}`,
    status,
    empresa_id: empresaId,
    lista_id: null,
    sequencia: [{ tipo: "texto", corpo: "Olá" }],
    intervalo_contatos_min: 15,
    intervalo_contatos_max: 45,
    intervalo_mensagens_min: 3,
    intervalo_mensagens_max: 9,
    validar_numeros: false,
    agendada_para: null,
    criada_em: "2026-01-01T00:00:00.000Z",
    iniciada_em: null,
    concluida_em: null,
    template_principal: null,
    pausada_motivo: null,
    rodada: 0,
    total_contatos: 0,
    total_enviadas: 0,
    total_entregues: 0,
    total_lidas: 0,
    total_falhas: 0,
    total_respostas: 0,
    campanha_canais: [],
  };
}

function usuario(id: string, empresaId: string | null): UsuarioAutenticado {
  return { id, email: `${id}@exemplo.com`, nome: id, papel: "admin", empresaId };
}

const ADMIN_A = usuario("admin-a", EMPRESA_A);
const ADMIN_B = usuario("admin-b", EMPRESA_B);

const auditoriaFalsa = { registrar: async () => undefined } as unknown as AuditoriaService;

/** Canais sempre acessíveis e conectados: o assunto aqui é outro. */
function canaisFalsos(): CanaisService {
  return { exigirAcesso: async () => undefined } as unknown as CanaisService;
}

function entrada(extra: Partial<CampanhaEntrada> = {}): CampanhaEntrada {
  return {
    nome: "Campanha nova",
    acao: "disparar",
    canaisIds: [CANAL_A],
    sequencia: [{ tipo: "texto", corpo: "Olá" }],
    intervaloEntreContatos: { minSegundos: 15, maxSegundos: 45 },
    intervaloEntreMensagens: { minSegundos: 3, maxSegundos: 9 },
    validarNumeros: false,
    agendadaPara: null,
    publico: [{ telefone: "+5511900000000", variaveis: {} }],
    ...extra,
  } as CampanhaEntrada;
}

function montar(banco: Banco, fila: Partial<FilaService> = {}) {
  const supabase = supabaseFalso(banco);
  const filaCompleta = {
    agendarCampanha: vi.fn(async () => null),
    replanejar: vi.fn(async () => undefined),
    reenfileirarAgendamento: vi.fn(async () => undefined),
    ...fila,
  } as unknown as FilaService;

  const servico = new CampanhasService(
    supabase,
    auditoriaFalsa,
    canaisFalsos(),
    filaCompleta,
    new LimitesService(supabase),
  );
  return { servico, fila: filaCompleta };
}

function bancoNovo(): Banco {
  return {
    campanhas: [],
    campanha_canais: [],
    canais: [{ id: CANAL_A, nome: "canal-a", status: "conectado", empresa_id: EMPRESA_A }],
    empresas: [
      { id: EMPRESA_A, plano: PLANO_PADRAO },
      { id: EMPRESA_B, plano: PLANO_PADRAO },
    ],
  };
}

// ===========================================================================
// Cenário A — criar campanha com o worker desligado
// ===========================================================================

describe("campanha criada com o worker fora do ar (cenário A)", () => {
  let banco: Banco;

  beforeEach(() => {
    banco = bancoNovo();
  });

  /**
   * O worker desligado NÃO impede a criação: quem enfileira é a API, e a fila
   * é uma tabela no mesmo Postgres. O caso interessante é o degrau seguinte —
   * a fila inteira indisponível — porque é ele que testa a ordem das escritas.
   */
  it("a campanha e o público continuam gravados quando o enfileiramento falha", async () => {
    const { servico } = montar(banco, {
      agendarCampanha: vi.fn(async () => {
        throw new Error("A fila de disparo está indisponível.");
      }),
    });

    await expect(servico.criar(ADMIN_A, entrada(), "127.0.0.1")).rejects.toThrow(/indisponível/);

    // O ponto do teste: a linha sobreviveu ao erro. Sem isto não haveria o que
    // recuperar — `campanhas_a_replanejar` procura campanha `em_andamento` com
    // pendente sem job, e ela precisa EXISTIR para ser encontrada.
    expect(banco.campanhas).toHaveLength(1);
    expect(banco.campanhas[0].status).toBe("em_andamento");
    expect(banco.campanhas[0].empresa_id).toBe(EMPRESA_A);
    // Os canais também: sem o vínculo a campanha não teria por onde sair.
    expect(banco.campanha_canais).toHaveLength(1);
  });

  it("campanha agendada também sobrevive, com a hora preservada", async () => {
    const quandoUmMesDepois = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { servico } = montar(banco, {
      agendarCampanha: vi.fn(async () => {
        throw new Error("A fila de disparo está indisponível.");
      }),
    });

    await expect(
      servico.criar(ADMIN_A, entrada({ agendadaPara: quandoUmMesDepois }), "127.0.0.1"),
    ).rejects.toThrow();

    // `agendada` + `agendada_para` é tudo de que
    // `reivindicar_agendamentos_vencidos` precisa para recuperá-la — inclusive
    // um mês depois, quando nenhum job do pg-boss teria sobrevivido.
    expect(banco.campanhas[0].status).toBe("agendada");
    expect(banco.campanhas[0].agendada_para).toBe(quandoUmMesDepois);
  });
});

// ===========================================================================
// Cenário F — empresa A não alcança recurso da empresa B
// ===========================================================================

describe("isolamento entre empresas nas campanhas (cenário F)", () => {
  let banco: Banco;

  beforeEach(() => {
    banco = bancoNovo();
    banco.campanhas.push(campanha("camp-a", EMPRESA_A), campanha("camp-b", EMPRESA_B));
  });

  it("admin de uma empresa não lê campanha de outra", async () => {
    const { servico } = montar(banco);
    await expect(servico.obter(ADMIN_A, "camp-b")).rejects.toThrow(NotFoundException);
    await expect(servico.obter(ADMIN_B, "camp-a")).rejects.toThrow(NotFoundException);
  });

  it("admin lê a campanha da própria empresa", async () => {
    const { servico } = montar(banco);
    await expect(servico.obter(ADMIN_A, "camp-a")).resolves.toMatchObject({ id: "camp-a" });
  });

  /**
   * Escrita importa mais que leitura: pausar a campanha de outro cliente para
   * o disparo dele no meio.
   */
  it("admin de uma empresa não pausa nem retoma campanha de outra", async () => {
    const { servico } = montar(banco);

    await expect(servico.pausar(ADMIN_A, "camp-b", "127.0.0.1")).rejects.toThrow(NotFoundException);
    await expect(servico.retomar(ADMIN_A, "camp-b", "127.0.0.1")).rejects.toThrow(
      NotFoundException,
    );

    expect(banco.campanhas.find((c) => c.id === "camp-b")?.status).toBe("em_andamento");
  });

  it("a conta global atravessa as empresas, que é o acesso de suporte", async () => {
    const { servico } = montar(banco);
    const global = usuario("global", null);

    await expect(servico.obter(global, "camp-a")).resolves.toMatchObject({ id: "camp-a" });
    await expect(servico.obter(global, "camp-b")).resolves.toMatchObject({ id: "camp-b" });
  });

  it("a listagem de cada admin traz só as próprias campanhas", async () => {
    const { servico } = montar(banco);

    expect((await servico.listar(ADMIN_A)).itens.map((c) => c.id)).toEqual(["camp-a"]);
    expect((await servico.listar(ADMIN_B)).itens.map((c) => c.id)).toEqual(["camp-b"]);
  });
});

// ===========================================================================
// Limite de campanhas simultâneas
// ===========================================================================

describe("teto de campanhas simultâneas por empresa", () => {
  let banco: Banco;

  beforeEach(() => {
    banco = bancoNovo();
  });

  it("recusa a campanha que passa do teto, sem gravar nada", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].campanhasSimultaneas!;
    for (let i = 0; i < teto; i += 1) banco.campanhas.push(campanha(`ativa-${i}`, EMPRESA_A));

    const { servico, fila } = montar(banco);

    await expect(servico.criar(ADMIN_A, entrada(), "127.0.0.1")).rejects.toThrow(
      ConflictException,
    );

    // Barrado ANTES de gravar: uma campanha meio-criada que ninguém enfileira
    // é lixo que o operador vê na tela e não entende.
    expect(banco.campanhas).toHaveLength(teto);
    expect(fila.agendarCampanha).not.toHaveBeenCalled();
  });

  /**
   * Rascunho não ocupa fila nenhuma. Impedir alguém de ESCREVER a próxima
   * campanha porque as três atuais ainda rodam seria transformar uma proteção
   * de capacidade em obstáculo de trabalho.
   */
  it("rascunho não é barrado pelo teto", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].campanhasSimultaneas!;
    for (let i = 0; i < teto; i += 1) banco.campanhas.push(campanha(`ativa-${i}`, EMPRESA_A));

    const { servico, fila } = montar(banco);

    await expect(
      servico.criar(ADMIN_A, entrada({ acao: "rascunho" }), "127.0.0.1"),
    ).resolves.toBeDefined();

    expect(banco.campanhas).toHaveLength(teto + 1);
    // Rascunho não vai para a fila — é o comportamento que já existia.
    expect(fila.agendarCampanha).not.toHaveBeenCalled();
  });

  it("o teto conta por empresa, não pelo sistema inteiro", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].campanhasSimultaneas!;
    // Empresa B lotada não pode atrapalhar a empresa A.
    for (let i = 0; i < teto; i += 1) banco.campanhas.push(campanha(`b-${i}`, EMPRESA_B));

    const { servico } = montar(banco);
    await expect(servico.criar(ADMIN_A, entrada(), "127.0.0.1")).resolves.toBeDefined();
  });

  /**
   * A conta global não pode ser barrada por um teto de empresa.
   *
   * Este teste guarda uma regressão introduzida e corrigida durante esta
   * mudança: a checagem chamava `empresaParaEscrita(usuario)`, que LANÇA para
   * a conta global (`empresaId === null`). O efeito seria o suporte perder o
   * botão de retomar campanha de qualquer cliente — um limite operacional
   * derrubando o acesso que existe justamente para socorrer o cliente.
   */
  it("a conta global retoma campanha de qualquer empresa, sem esbarrar no teto", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].campanhasSimultaneas!;
    for (let i = 0; i < teto; i += 1) banco.campanhas.push(campanha(`b-${i}`, EMPRESA_B));
    banco.campanhas.push(campanha("pausada-b", EMPRESA_B, "pausada"));
    banco.campanha_canais.push({ campanha_id: "pausada-b", canal_id: CANAL_A });

    const { servico } = montar(banco);
    const global = usuario("global", null);

    await expect(servico.retomar(global, "pausada-b", "127.0.0.1")).resolves.toBeDefined();
    expect(banco.campanhas.find((c) => c.id === "pausada-b")?.status).toBe("em_andamento");
  });
});
