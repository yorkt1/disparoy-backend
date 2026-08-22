import { ConflictException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { LimitesService } from "./limites.service";
import { LIMITES_POR_PLANO, PLANO_PADRAO, limitesDoPlano } from "./limites-empresa";
import type { SupabaseService } from "../supabase/supabase.service";

/**
 * Limites operacionais por empresa (cenário G do diagnóstico).
 *
 * O que se verifica aqui é o COMPORTAMENTO da regra: bloquear de forma
 * previsível, dizer por quê, e nunca marcar o contato como falha permanente —
 * um limite nosso não pode destruir a campanha do cliente.
 *
 * A atomicidade do contador é do Postgres (`consumir_cota_empresa`, migration
 * 20260822000400) e não pode ser exercida sem banco. O dublê abaixo IMITA a
 * regra daquela função — soma e compara contra o teto — o que verifica o
 * contrato que o TypeScript depende, não a implementação SQL.
 */

const EMPRESA = "11111111-1111-1111-1111-111111111111";

interface Estado {
  plano: string;
  consumidas: number;
  canais: number;
  campanhasAtivas: number;
}

function supabaseFalso(estado: Estado): SupabaseService {
  const contagem = (tabela: string) => (tabela === "canais" ? estado.canais : estado.campanhasAtivas);

  const consulta = (tabela: string) => {
    const encadeavel: Record<string, unknown> = {};
    const devolver = () => encadeavel;
    for (const metodo of ["select", "eq", "in", "order", "limit"]) {
      encadeavel[metodo] = devolver;
    }
    encadeavel.maybeSingle = async () => ({
      data: tabela === "empresas" ? { plano: estado.plano } : null,
      error: null,
    });
    // `then` é o que permite `await consulta` sem `.maybeSingle()` — é assim
    // que a contagem com `{ count: "exact", head: true }` é lida.
    encadeavel.then = (aoResolver: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null, count: contagem(tabela) }).then(aoResolver);
    return encadeavel;
  };

  return {
    tabela: (nome: string) => consulta(nome),
    db: {
      rpc: async (nome: string, args: Record<string, unknown>) => {
        if (nome === "consumir_cota_empresa") {
          const quantidade = Number(args.p_quantidade);
          const limite = args.p_limite as number | null;
          // Mesma regra da função no banco: soma e compara contra o teto.
          if (limite !== null && estado.consumidas + quantidade > limite) {
            return { data: false, error: null };
          }
          estado.consumidas += quantidade;
          return { data: true, error: null };
        }
        if (nome === "devolver_cota_empresa") {
          estado.consumidas = Math.max(estado.consumidas - Number(args.p_quantidade), 0);
          return { data: null, error: null };
        }
        if (nome === "cota_empresa_hoje") return { data: estado.consumidas, error: null };
        return { data: null, error: null };
      },
    },
  } as unknown as SupabaseService;
}

function estadoNovo(extra: Partial<Estado> = {}): Estado {
  return { plano: PLANO_PADRAO, consumidas: 0, canais: 0, campanhasAtivas: 0, ...extra };
}

describe("limites por plano", () => {
  it("plano desconhecido cai no padrão em vez de estourar", () => {
    // A coluna é `text` livre justamente para receber um rótulo novo antes de
    // o deploy que o conhece estar no ar. Um erro aqui derrubaria o disparo de
    // um cliente por causa de uma string.
    expect(limitesDoPlano("plano-que-nao-existe")).toEqual(LIMITES_POR_PLANO[PLANO_PADRAO]);
    expect(limitesDoPlano(null)).toEqual(LIMITES_POR_PLANO[PLANO_PADRAO]);
    expect(limitesDoPlano(undefined)).toEqual(LIMITES_POR_PLANO[PLANO_PADRAO]);
  });

  it("o teto de contatos por planejamento nunca é ilimitado", () => {
    // Sem teto aqui é exatamente o caso que o campo existe para impedir: uma
    // campanha grande devolvendo tudo de uma vez e travando a fila dos outros.
    for (const limites of Object.values(LIMITES_POR_PLANO)) {
      expect(limites.contatosPorPlanejamento).toBeGreaterThan(0);
      expect(Number.isFinite(limites.contatosPorPlanejamento)).toBe(true);
    }
  });
});

describe("cota diária de mensagens (cenário G)", () => {
  it("libera enquanto cabe e bloqueia quando ultrapassa", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].mensagensPorDia!;
    const estado = estadoNovo({ consumidas: teto - 2 });
    const limites = new LimitesService(supabaseFalso(estado));

    expect(await limites.consumirCota(EMPRESA, 2)).toBe(true);
    // Agora está exatamente no teto: o próximo envio não cabe.
    expect(await limites.consumirCota(EMPRESA, 1)).toBe(false);
    expect(estado.consumidas).toBe(teto);
  });

  /**
   * Cota é RESERVA, não cobrança.
   *
   * Uma sequência de 3 passos que falha no primeiro não pode queimar os outros
   * dois do teto do cliente — o efeito seria a campanha parar mais cedo do que
   * precisava, que é justamente o que um limite não deveria causar.
   */
  it("o que não vira mensagem volta para a cota", async () => {
    const estado = estadoNovo();
    const limites = new LimitesService(supabaseFalso(estado));

    expect(await limites.consumirCota(EMPRESA, 3)).toBe(true);
    await limites.devolverCota(EMPRESA, 2);

    expect(await limites.consumoDeHoje(EMPRESA)).toBe(1);
  });

  /** Empresa nula é campanha órfã: barrar por dado faltando é trocar um problema por um pior. */
  it("sem empresa, não há cota a consumir", async () => {
    const limites = new LimitesService(supabaseFalso(estadoNovo()));
    expect(await limites.consumirCota(null, 5)).toBe(true);
  });

  /** Plano interno existe para o caso negociado fora da faixa. */
  it("plano sem teto nunca bloqueia", async () => {
    const estado = estadoNovo({ plano: "interno", consumidas: 999_999 });
    const limites = new LimitesService(supabaseFalso(estado));
    expect(await limites.consumirCota(EMPRESA, 1_000)).toBe(true);
  });

  /**
   * A proteção falhando não pode virar indisponibilidade.
   *
   * Se a RPC de cota der erro, o envio segue e o log registra. O teto do canal
   * continua de pé; parar o disparo de TODOS os clientes porque um contador
   * falhou seria um estrago maior que o que o contador evita.
   */
  it("erro na RPC deixa passar e não derruba o disparo", async () => {
    const supabase = {
      tabela: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
      db: { rpc: async () => ({ data: null, error: { message: "sem conexão" } }) },
    } as unknown as SupabaseService;

    const limites = new LimitesService(supabase);
    expect(await limites.consumirCota(EMPRESA, 1)).toBe(true);
  });
});

describe("teto de canais e de campanhas simultâneas", () => {
  it("recusa criar canal acima do teto, com mensagem que diz o motivo", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].canais!;
    const limites = new LimitesService(supabaseFalso(estadoNovo({ canais: teto })));

    await expect(limites.exigirEspacoParaCanal(EMPRESA)).rejects.toThrow(ConflictException);
    await expect(limites.exigirEspacoParaCanal(EMPRESA)).rejects.toThrow(/limite do plano/);
  });

  it("libera enquanto há espaço", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].canais!;
    const limites = new LimitesService(supabaseFalso(estadoNovo({ canais: teto - 1 })));
    await expect(limites.exigirEspacoParaCanal(EMPRESA)).resolves.toBeUndefined();
  });

  it("recusa iniciar campanha acima do teto de simultâneas", async () => {
    const teto = LIMITES_POR_PLANO[PLANO_PADRAO].campanhasSimultaneas!;
    const limites = new LimitesService(supabaseFalso(estadoNovo({ campanhasAtivas: teto })));

    await expect(limites.exigirEspacoParaCampanha(EMPRESA)).rejects.toThrow(ConflictException);
    await expect(limites.exigirEspacoParaCampanha(EMPRESA)).rejects.toThrow(/Aguarde uma concluir/);
  });

  /** Contagem que falha não pode barrar a criação — ver `consumirCota`. */
  it("erro ao contar não barra", async () => {
    const supabase = {
      tabela: () => {
        const enc: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in"]) enc[m] = () => enc;
        enc.maybeSingle = async () => ({ data: { plano: PLANO_PADRAO }, error: null });
        enc.then = (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: "timeout" }, count: null }).then(r);
        return enc;
      },
      db: { rpc: async () => ({ data: null, error: null }) },
    } as unknown as SupabaseService;

    const limites = new LimitesService(supabase);
    await expect(limites.exigirEspacoParaCanal(EMPRESA)).resolves.toBeUndefined();
  });
});
