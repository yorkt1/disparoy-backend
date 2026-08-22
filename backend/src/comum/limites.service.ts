import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import {
  explicarLimite,
  limitesDoPlano,
  PLANO_PADRAO,
  type LimitesEmpresa,
} from "./limites-empresa";

/**
 * Aplica os limites operacionais por empresa.
 *
 * Existe pelo mesmo motivo de `comum/escopo.ts`: a regra é uma só e é
 * consultada de lugares distantes — a API ao criar canal e campanha, o worker
 * a cada envio. Três cópias divergem, e a que divergir vira o cliente que
 * passa pelo teto sem que ninguém perceba.
 *
 * Nada aqui BLOQUEIA envio já aceito: quando a cota diária acaba, o contato
 * volta para `pendente` e sai amanhã. Marcar `falhou` em massa por causa de um
 * limite nosso destruiria a campanha do cliente — é a mesma regra que o resto
 * do worker já segue para falha de canal (ver `ARQUITETURA-ATRIBUICAO-DE-FALHA`).
 */
@Injectable()
export class LimitesService {
  private readonly logger = new Logger(LimitesService.name);

  /**
   * Cache curto do plano.
   *
   * `dispararContato` roda uma vez por contato — numa campanha de 20 mil
   * pessoas seriam 20 mil SELECTs em `empresas` só para ler uma string que
   * muda uma vez por ano. 60 s é curto o bastante para uma mudança de plano
   * valer sem deploy e longo o bastante para o custo sumir.
   */
  private readonly cachePlano = new Map<string, { plano: string; expiraEm: number }>();
  private static readonly TTL_CACHE_MS = 60_000;

  constructor(private readonly supabase: SupabaseService) {}

  async limitesDe(empresaId: string): Promise<LimitesEmpresa> {
    return limitesDoPlano(await this.planoDe(empresaId));
  }

  private async planoDe(empresaId: string): Promise<string> {
    const agora = Date.now();
    const cacheado = this.cachePlano.get(empresaId);
    if (cacheado && cacheado.expiraEm > agora) return cacheado.plano;

    const { data, error } = await this.supabase
      .tabela("empresas")
      .select("plano")
      .eq("id", empresaId)
      .maybeSingle();

    // Falha de leitura cai no plano padrão em vez de estourar: um erro
    // transitório no banco não pode virar "nenhum cliente consegue disparar".
    if (error) {
      this.logger.warn(`Não foi possível ler o plano da empresa ${empresaId}: ${error.message}`);
      return PLANO_PADRAO;
    }

    const plano = (data as { plano?: string } | null)?.plano ?? PLANO_PADRAO;
    this.cachePlano.set(empresaId, { plano, expiraEm: agora + LimitesService.TTL_CACHE_MS });
    return plano;
  }

  // ------------------------------------------------------------------------
  // Limites verificados na API, antes de aceitar
  // ------------------------------------------------------------------------

  /**
   * Recusa criar canal acima do teto.
   *
   * Conta os canais que EXISTEM, não os conectados: um canal aguardando QR já
   * ocupa uma instância na Evolution, e é a instância que custa.
   */
  async exigirEspacoParaCanal(empresaId: string): Promise<void> {
    const { canais: teto } = await this.limitesDe(empresaId);
    if (teto === null) return;

    const { count, error } = await this.supabase
      .tabela("canais")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", empresaId);

    // Não barra por falha de contagem: recusar criar canal porque o COUNT
    // falhou trocaria uma proteção por uma indisponibilidade.
    if (error) {
      this.logger.warn(`Não foi possível contar canais da empresa ${empresaId}: ${error.message}`);
      return;
    }

    if ((count ?? 0) >= teto) {
      throw new ConflictException(explicarLimite("canais", teto));
    }
  }

  /**
   * Recusa iniciar mais uma campanha acima do teto de simultâneas.
   *
   * `pausada_por_canal` entra na contagem: ela volta sozinha quando o canal
   * reconecta, então continua sendo trabalho reservado na fila. `pausada` pelo
   * operador NÃO entra — quem pausou tomou a decisão de liberar a vaga.
   */
  async exigirEspacoParaCampanha(empresaId: string): Promise<void> {
    const { campanhasSimultaneas: teto } = await this.limitesDe(empresaId);
    if (teto === null) return;

    const { count, error } = await this.supabase
      .tabela("campanhas")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", empresaId)
      .in("status", ["em_andamento", "agendada", "pausada_por_canal"]);

    if (error) {
      this.logger.warn(
        `Não foi possível contar campanhas ativas da empresa ${empresaId}: ${error.message}`,
      );
      return;
    }

    if ((count ?? 0) >= teto) {
      throw new ConflictException(explicarLimite("campanhas", teto));
    }
  }

  // ------------------------------------------------------------------------
  // Cota diária — consumida pelo worker, no caminho do envio
  // ------------------------------------------------------------------------

  /**
   * Reserva `quantidade` mensagens da cota do dia. `false` = estourou.
   *
   * Reserva, não cobrança: o que não virar mensagem volta por `devolverCota`,
   * exatamente como a cota do canal. Sem isso, uma sequência de 3 passos que
   * falha no primeiro queimaria 3 do teto do cliente.
   *
   * Empresa nula (campanha órfã, caso teórico) devolve `true`: barrar envio
   * por causa de dado faltando seria trocar um problema por um pior. A
   * campanha sem empresa é o defeito, e ele tem dono próprio.
   */
  async consumirCota(empresaId: string | null, quantidade: number): Promise<boolean> {
    if (empresaId === null || quantidade <= 0) return true;

    const { mensagensPorDia } = await this.limitesDe(empresaId);
    const { data, error } = await this.supabase.db.rpc("consumir_cota_empresa", {
      p_empresa_id: empresaId,
      p_quantidade: quantidade,
      p_limite: mensagensPorDia,
    });

    if (error) {
      // Deixa passar e registra. Um erro na RPC de cota não pode parar o
      // disparo de todos os clientes — o teto do canal continua de pé, e o log
      // é o que permite descobrir que a proteção parou de funcionar.
      this.logger.error(`Falha ao consumir cota da empresa ${empresaId}: ${error.message}`);
      return true;
    }

    return data === true;
  }

  async devolverCota(empresaId: string | null, quantidade: number): Promise<void> {
    if (empresaId === null || quantidade <= 0) return;

    const { error } = await this.supabase.db.rpc("devolver_cota_empresa", {
      p_empresa_id: empresaId,
      p_quantidade: quantidade,
    });
    if (error) this.logger.warn(`Não foi possível devolver cota da empresa: ${error.message}`);
  }

  /** Quantas mensagens a empresa já consumiu hoje — para log e para a tela. */
  async consumoDeHoje(empresaId: string): Promise<number> {
    const { data } = await this.supabase.db.rpc("cota_empresa_hoje", { p_empresa_id: empresaId });
    return typeof data === "number" ? data : 0;
  }
}
