import { Injectable } from "@nestjs/common";
import type { AmostraFalha, CategoriaFalha, Diagnostico, ResumoFalha } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";

interface LinhaResumo {
  codigo: string;
  categoria: CategoriaFalha | null;
  total: number | string;
  canais: number | string;
  campanhas: number | string;
  primeira_em: string;
  ultima_em: string;
}

interface LinhaAmostra {
  padrao: string;
  exemplo: string;
  codigo: string;
  categoria: CategoriaFalha | null;
  total: number | string;
  ultima_em: string;
}

/**
 * `count(*)` em Postgres é `bigint`, e o PostgREST serializa bigint como string
 * para não perder precisão em JavaScript. São contagens de mensagem — nunca
 * chegam perto de 2^53 —, mas sem esta conversão o painel soma strings e o
 * total vira "12" + "7" = "127".
 */
function numero(v: number | string): number {
  return typeof v === "number" ? v : Number(v);
}

/**
 * Leitura agregada das falhas.
 *
 * Toda a agregação acontece no banco, via as funções da migration, e não aqui:
 * trazer as linhas cruas para contar em memória significaria puxar uma linha
 * por mensagem falhada — dezenas de milhares numa campanha ruim — para devolver
 * vinte.
 */
@Injectable()
export class DiagnosticoService {
  constructor(private readonly supabase: SupabaseService) {}

  async resumo(dias: number): Promise<Diagnostico> {
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

    // Em paralelo: são leituras independentes e a tela mostra as duas juntas.
    const [falhas, amostras] = await Promise.all([
      this.falhas(desde),
      this.amostras(desde, null, 30),
    ]);

    return { desde, falhas, amostras };
  }

  /** Amostras de um código só — usado quando o operador abre uma linha. */
  async amostrasDoCodigo(dias: number, codigo: string, limite = 30): Promise<AmostraFalha[]> {
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
    return this.amostras(desde, codigo, limite);
  }

  private async falhas(desde: string): Promise<ResumoFalha[]> {
    const { data, error } = await this.supabase.db.rpc("diagnostico_falhas", { p_desde: desde });
    if (error) throw new Error(`Falha ao agregar diagnóstico: ${error.message}`);

    return ((data ?? []) as LinhaResumo[]).map((l) => ({
      codigo: l.codigo,
      categoria: l.categoria,
      total: numero(l.total),
      canais: numero(l.canais),
      campanhas: numero(l.campanhas),
      primeiraEm: l.primeira_em,
      ultimaEm: l.ultima_em,
    }));
  }

  private async amostras(
    desde: string,
    codigo: string | null,
    limite: number,
  ): Promise<AmostraFalha[]> {
    const { data, error } = await this.supabase.db.rpc("diagnostico_amostras", {
      p_desde: desde,
      p_codigo: codigo,
      p_limite: limite,
    });
    if (error) throw new Error(`Falha ao listar amostras de erro: ${error.message}`);

    return ((data ?? []) as LinhaAmostra[]).map((l) => ({
      padrao: l.padrao,
      exemplo: l.exemplo,
      codigo: l.codigo,
      categoria: l.categoria,
      total: numero(l.total),
      ultimaEm: l.ultima_em,
    }));
  }
}
