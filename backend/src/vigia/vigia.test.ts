import { describe, expect, it, vi } from "vitest";
import { VigiaWorkerService } from "./vigia-worker.service";
import type { FilaService } from "../fila/fila.service";
import type { SupabaseService } from "../supabase/supabase.service";
import type {
  ObservabilidadeService,
  ResultadoAlerta,
} from "../observabilidade/observabilidade.service";

/**
 * O vigia do pulso — cenários H e I do diagnóstico.
 *
 * H: worker morre → incidente registrado E alerta externo emitido quando
 *    configurado, sem virar enxurrada.
 * I: worker volta → incidente resolvido, sem abrir outro à toa; e se cair de
 *    novo, alerta NOVO sai.
 *
 * O que estes testes cobrem é a decisão do TypeScript: quando alertar, quando
 * calar, e o que gravar. A atomicidade de `reivindicar_alerta_incidente` é do
 * Postgres (`update ... where alertado_em is null returning`) e o dublê a
 * imita — cada incidente é reivindicado uma única vez.
 */

const INCIDENTE = 77;

interface Estado {
  /** Minutos desde a última batida do pulso. */
  minutosSemPulso: number;
  /** Incidentes já reivindicados para alerta, por id. */
  reivindicados: Set<number>;
  /** Id devolvido por `abrir_incidente` — muda quando um incidente novo nasce. */
  proximoIncidente: number;
}

interface Chamada {
  nome: string;
  args: Record<string, unknown>;
}

function montar(estado: Estado, resultadoDoAlerta: ResultadoAlerta = "enviado") {
  const chamadas: Chamada[] = [];

  const supabase = {
    tabela: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              batida_em: new Date(Date.now() - estado.minutosSemPulso * 60_000).toISOString(),
            },
            error: null,
          }),
        }),
      }),
    }),
    db: {
      rpc: async (nome: string, args: Record<string, unknown> = {}) => {
        chamadas.push({ nome, args });

        if (nome === "abrir_incidente") return { data: estado.proximoIncidente, error: null };

        if (nome === "reivindicar_alerta_incidente") {
          const id = Number(args.p_id);
          // `update ... where alertado_em is null`: só o primeiro leva.
          if (estado.reivindicados.has(id)) return { data: false, error: null };
          estado.reivindicados.add(id);
          return { data: true, error: null };
        }

        if (nome === "registrar_alerta_incidente" && args.p_estado === "falhou") {
          // `falhou` devolve a reivindicação para a rodada seguinte tentar.
          estado.reivindicados.delete(Number(args.p_id));
        }

        return { data: null, error: null };
      },
    },
  } as unknown as SupabaseService;

  const enviarAlerta = vi.fn(async (): Promise<ResultadoAlerta> => resultadoDoAlerta);
  const observabilidade = {
    enviarAlerta,
    alertaExternoConfigurado: () => resultadoDoAlerta !== "desabilitado",
    relatarErro: () => undefined,
  } as unknown as ObservabilidadeService;

  const vigia = new VigiaWorkerService(
    { bossOpcional: null } as unknown as FilaService,
    supabase,
    observabilidade,
  );

  // `verificar` é privado de propósito — quem o chama é o cron do pg-boss.
  // O teste exercita a unidade real em vez de duplicar a lógica dela.
  const verificar = () =>
    (vigia as unknown as { verificar(): Promise<void> }).verificar.call(vigia);

  return { verificar, chamadas, enviarAlerta, estado };
}

function estadoNovo(extra: Partial<Estado> = {}): Estado {
  return { minutosSemPulso: 0, reivindicados: new Set(), proximoIncidente: INCIDENTE, ...extra };
}

describe("worker morre (cenário H)", () => {
  it("abre incidente e envia o alerta externo", async () => {
    const { verificar, chamadas, enviarAlerta } = montar(estadoNovo({ minutosSemPulso: 10 }));

    await verificar();

    expect(chamadas.some((c) => c.nome === "abrir_incidente")).toBe(true);
    expect(enviarAlerta).toHaveBeenCalledTimes(1);
    expect(
      chamadas.find((c) => c.nome === "registrar_alerta_incidente")?.args.p_estado,
    ).toBe("enviado");
  });

  /**
   * O vigia roda de minuto em minuto. Sem trava, uma queda de duas horas
   * viraria 120 POSTs — o canal de alerta seria silenciado por quem o recebe,
   * justamente antes do próximo incidente de verdade.
   */
  it("não repete o alerta enquanto a mesma queda continua", async () => {
    const { verificar, enviarAlerta } = montar(estadoNovo({ minutosSemPulso: 10 }));

    for (let i = 0; i < 30; i += 1) await verificar();

    expect(enviarAlerta).toHaveBeenCalledTimes(1);
  });

  /**
   * O buraco que existia: um POST que falhava nunca era tentado de novo. Na
   * rodada seguinte o incidente "já existia", e o único aviso externo se
   * perdia no primeiro timeout.
   */
  it("alerta que falha é tentado de novo na rodada seguinte", async () => {
    const { verificar, enviarAlerta } = montar(estadoNovo({ minutosSemPulso: 10 }), "falhou");

    await verificar();
    await verificar();

    expect(enviarAlerta).toHaveBeenCalledTimes(2);
  });

  /**
   * Sem `ALERTA_WEBHOOK_URL` o sistema NÃO finge ter alertado: grava
   * `alerta_estado = 'desabilitado'` no incidente, que fica como evidência.
   * E não fica tentando de novo — não há para onde tentar.
   */
  it("sem webhook configurado, registra 'desabilitado' e não insiste", async () => {
    const { verificar, chamadas, enviarAlerta } = montar(
      estadoNovo({ minutosSemPulso: 10 }),
      "desabilitado",
    );

    await verificar();
    await verificar();

    expect(enviarAlerta).toHaveBeenCalledTimes(1);
    expect(
      chamadas.find((c) => c.nome === "registrar_alerta_incidente")?.args.p_estado,
    ).toBe("desabilitado");
  });

  /** Três minutos é o piso: deploy e GC não podem virar incidente. */
  it("atraso curto não abre incidente", async () => {
    const { verificar, chamadas, enviarAlerta } = montar(estadoNovo({ minutosSemPulso: 2 }));

    await verificar();

    expect(chamadas.some((c) => c.nome === "abrir_incidente")).toBe(false);
    expect(enviarAlerta).not.toHaveBeenCalled();
  });
});

describe("worker volta (cenário I)", () => {
  it("resolve o incidente e não abre outro", async () => {
    const estado = estadoNovo({ minutosSemPulso: 10 });
    const { verificar, chamadas, enviarAlerta } = montar(estado);

    await verificar(); // caiu
    estado.minutosSemPulso = 0; // voltou
    await verificar();
    await verificar();

    expect(chamadas.filter((c) => c.nome === "abrir_incidente")).toHaveLength(1);
    expect(chamadas.filter((c) => c.nome === "resolver_incidente").length).toBeGreaterThan(0);
    expect(enviarAlerta).toHaveBeenCalledTimes(1);
  });

  /**
   * Uma SEGUNDA queda é um incidente NOVO e merece alerta novo.
   *
   * `resolver_incidente` fecha a linha antiga e `abrir_incidente` cria outra,
   * com `alertado_em` nulo — por isso o dublê troca o id.
   */
  it("nova queda depois de voltar gera alerta novo", async () => {
    const estado = estadoNovo({ minutosSemPulso: 10 });
    const { verificar, enviarAlerta } = montar(estado);

    await verificar(); // primeira queda: alerta
    estado.minutosSemPulso = 0;
    await verificar(); // voltou: resolve
    estado.minutosSemPulso = 10;
    estado.proximoIncidente = INCIDENTE + 1; // incidente novo
    await verificar(); // caiu de novo: alerta de novo

    expect(enviarAlerta).toHaveBeenCalledTimes(2);
  });
});
