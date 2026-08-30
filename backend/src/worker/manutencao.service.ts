import { Injectable, Logger } from "@nestjs/common";
import { statusDoGateway } from "@disparoy/dominio";
import {
  estadoDaInstancia,
  fotoDaInstancia,
  numeroDaInstancia,
} from "../whatsapp/evolution-provider";
import { BUCKET_MIDIA } from "../midia/midia.service";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { FilaService } from "../fila/fila.service";
import { ambiente } from "../config/ambiente";
import {
  carregarCampanha,
  registrarAgendamentoExpirado,
  registrarIncidente,
  type AgendamentoExpirado,
} from "./execucao";

/**
 * Quanto tempo uma reivindicação de agendamento vale antes de a campanha
 * voltar a ser candidata.
 *
 * É a segunda chance de quem morreu entre reivindicar e enfileirar. Precisa
 * ser MENOR que `AGENDAMENTO_TOLERANCIA_MINUTOS` — com os dois iguais, a
 * campanha expiraria no mesmo minuto em que ganharia a retentativa, e a
 * carência não serviria para nada. O piso de 5 minutos daquela variável existe
 * por isto.
 */
const CARENCIA_AGENDAMENTO_MINUTOS = 5;

/**
 * Cron de um minuto: reconcilia o que ficou pelo caminho.
 *
 * Vive fora do `DisparoService` porque o ciclo de vida é outro. O disparo
 * responde a job de fila e é o caminho mais crítico do sistema; isto aqui
 * responde ao relógio e conserta o que aquele caminho não terminou. Juntos
 * numa classe só, mexer na faxina obrigava a reler o envio.
 *
 * Nunca lança. Uma manutenção que falha e derruba o job levaria o pg-boss a
 * reagendar em backoff, e a rotina que conserta o sistema seria a primeira a
 * parar de rodar justamente quando o sistema está ruim.
 */
@Injectable()
export class ManutencaoService {
  private readonly logger = new Logger(ManutencaoService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly whatsapp: WhatsappService,
    private readonly fila: FilaService,
  ) {}

  // ------------------------------------------------------------------------
  // Job 3: manutenção (cron de um minuto)
  // ------------------------------------------------------------------------

  /**
   * Reconcilia o que ficou pelo caminho e agrega os contadores.
   *
   * Todo o resto do sistema assume que o worker termina o que começa. Esta
   * rotina é o que torna essa suposição segura: se ele não terminou, alguém
   * percebe em até um minuto e devolve o trabalho à fila.
   *
   * Nunca lança. Uma manutenção que falha e derruba o job levaria o pg-boss a
   * reagendar em backoff, e a rotina que conserta o sistema seria a primeira a
   * parar de rodar justamente quando o sistema está ruim.
   */
  async executar(): Promise<void> {
    // Antes de qualquer trabalho: o pulso responde "o worker está vivo?", e é
    // o que permite ao painel avisar que nenhuma campanha está saindo. Bater no
    // fim faria uma manutenção que falha no meio parecer worker morto.
    await this.baterPulso();

    // Vem primeiro: reconciliar contatos de um canal que está offline só
    // devolveria trabalho para uma fila que não tem por onde sair.
    await this.vigiarCanais();
    await this.reconciliarTravados();
    // ANTES de reenfileirar, e a ordem é o mecanismo: o que já passou da
    // tolerância vira `falhou` nesta linha e some do filtro da linha seguinte.
    // Invertidas, a mesma rodada de manutenção enfileiraria a campanha atrasada
    // e só depois a expiraria — com o job já em voo.
    await this.expirarAgendamentosVencidos();
    await this.reenfileirarAgendamentosVencidos();
    await this.replanejarPendentesOrfas();
    await this.agregarMetricas();
    await this.concluirOrfas();
    await this.limparEventosAntigos();
    await this.limparAvisosAntigos();
    await this.limparFreiosExpirados();
    await this.limparCotasAntigas();
  }

  /**
   * Campanhas agendadas cuja hora passou e que não têm job vivo.
   *
   * É a rede de segurança do agendamento, e ela NÃO depende da fila.
   *
   * O que ela conserta: `agendarCampanha` guarda o agendamento como um job do
   * pg-boss com `startAfter`. O pg-boss apaga job pela retenção — 14 dias no
   * padrão, contados da CRIAÇÃO. Uma campanha marcada para daqui a 30 dias
   * perdia o job no dia 14 e, no dia marcado, nada acontecia: sem erro, sem
   * incidente, com a campanha parada em `agendada` para sempre. A retenção
   * agora acompanha o agendamento (ver `FilaService.agendarCampanha`), mas
   * isso é só parar de destruir o job — a garantia é esta função.
   *
   * Cobre também o worker fora do ar por dias: o estado vive em `campanhas`, e
   * a primeira manutenção depois do retorno encontra tudo que venceu enquanto
   * ninguém estava olhando. Vale igual para reinício — não há estado em
   * memória de processo aqui.
   *
   * POR QUE NÃO DISPARA ANTES DA HORA: o filtro é `agendada_para <= now()`,
   * avaliado no BANCO. Não existe caminho por onde uma campanha futura entre
   * nesta lista.
   *
   * POR QUE NÃO DUPLICA: a reivindicação é um `update ... returning` atômico,
   * então dois workers não pegam a mesma campanha; se o job do pg-boss tiver
   * sobrevivido e os dois chegarem ao `planejarCampanha`, quem reserva cada
   * contato é `reservar_contatos_pendentes`, e ele só entrega linha com
   * `enfileirado_em is null` — o segundo planejamento encontra zero e encerra.
   */
  private async reenfileirarAgendamentosVencidos(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("reivindicar_agendamentos_vencidos", {
      p_limite: 50,
      p_carencia_minutos: CARENCIA_AGENDAMENTO_MINUTOS,
      // O teto vive no SQL, junto do `agendada_para <= now()`: é o mesmo
      // relógio que decide "já venceu" e "venceu demais". Com duas réplicas de
      // worker, um `Date.now()` atrasado numa delas reenfileiraria o que a
      // outra acabou de expirar.
      p_tolerancia_minutos: ambiente().AGENDAMENTO_TOLERANCIA_MINUTOS,
    });

    if (error) {
      this.logger.error(`Não foi possível recuperar agendamentos vencidos: ${error.message}`);
      return;
    }

    const vencidas = (data ?? []) as { campanha_id: string; rodada: number }[];
    for (const c of vencidas) {
      await this.fila.reenfileirarAgendamento(c.campanha_id, c.rodada ?? 0);
      this.logger.warn(
        `Campanha ${c.campanha_id} estava agendada com a hora vencida e sem job; reenfileirada.`,
      );
    }
  }

  /**
   * Agendamento que passou da tolerância vira `falhou`. Nada é enviado.
   *
   * Cobre o modo de falha que o guarda do `planejarCampanha` não alcança: o
   * job do pg-boss sumiu (retenção, fila recriada) e ninguém mais vai chamar o
   * planejamento daquela campanha. Sem esta varredura ela ficaria `agendada`
   * para sempre, sem envio e sem aviso — o silêncio que 20260822000300 existe
   * para acabar, só que do outro lado.
   *
   * Não relança: a manutenção é a rotina que conserta o sistema, e derrubá-la
   * por causa de uma expiração levaria o pg-boss a reagendá-la em backoff
   * justo quando o sistema está ruim (ver `manutencao`).
   */
  private async expirarAgendamentosVencidos(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("expirar_agendamentos_vencidos", {
      p_tolerancia_minutos: ambiente().AGENDAMENTO_TOLERANCIA_MINUTOS,
      p_limite: 50,
    });

    if (error) {
      this.logger.error(`Não foi possível expirar agendamentos vencidos: ${error.message}`);
      return;
    }

    const expiradas = (data ?? []) as AgendamentoExpirado[];
    for (const c of expiradas) {
      await registrarAgendamentoExpirado(this.supabase, this.auditoria, this.logger, 
        { id: c.campanha_id, nome: c.nome, empresaId: c.empresa_id },
        c,
      );
    }
  }

  /** Histórico de cota por empresa — 180 dias. Ver `limparAvisosAntigos`. */
  private async limparCotasAntigas(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("limpar_cotas_empresa_antigas", {
      p_dias: 180,
    });
    if (error) {
      this.logger.error(`Limpeza de cotas por empresa falhou: ${error.message}`);
      return;
    }
    if (typeof data === "number" && data > 0) {
      this.logger.log(`${data} linha(s) de cota diária antigas removidas.`);
    }
  }

  /**
   * Contadores de rate limit que já viraram pó.
   *
   * `freios` recebe uma linha por chave freada — inclusive do login, que é
   * público: qualquer um na internet faz a tabela crescer. As linhas param de
   * ser consultadas assim que a janela passa, mas nada as apaga, e uma tabela
   * que só cresce acaba deixando lento o próprio caminho que ela protege.
   *
   * Cai aqui e não num cron próprio porque `manutencao()` já é o lugar onde a
   * limpeza periódica mora, e um segundo agendador seria mais uma peça para
   * alguém esquecer de ligar num deploy novo.
   */
  private async limparFreiosExpirados(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("limpar_freios_expirados");
    if (error) {
      this.logger.error(`Limpeza de freios falhou: ${error.message}`);
      return;
    }
    if (typeof data === "number" && data > 0) {
      this.logger.log(`${data} contador(es) de freio expirados removidos.`);
    }
  }

  /**
   * Guarda a foto do número no nosso Storage.
   *
   * Nunca lança: foto é enfeite, e uma falha aqui não pode interromper a
   * vigilância, que é o que devolve campanha travada à fila.
   */
  private async baixarFoto(canalId: string, instancia: string): Promise<string | null> {
    try {
      const foto = await fotoDaInstancia(instancia);
      if (!foto) return null;

      const caminho = `canais/${canalId}.jpg`;
      const { error } = await this.supabase.db.storage
        .from(BUCKET_MIDIA)
        .upload(caminho, foto.bytes, { contentType: foto.tipo, upsert: true });
      if (error) return null;

      const base = ambiente().SUPABASE_URL.replace(/\/+$/, "");
      return `${base}/storage/v1/object/public/${BUCKET_MIDIA}/${caminho}?v=${Date.now()}`;
    } catch {
      return null;
    }
  }

  /**
   * Carimba o sinal de vida do worker.
   *
   * Falha aqui não interrompe a manutenção: perder um pulso é perder um aviso,
   * enquanto abortar a rotina é perder a reconciliação inteira — que é o que de
   * fato conserta campanha travada e canal mentindo.
   */
  private async baterPulso(): Promise<void> {
    const { error } = await this.supabase.db.rpc("bater_pulso_worker");
    if (error) this.logger.error(`Não foi possível bater o pulso: ${error.message}`);
  }

  /**
   * Retenção dos avisos arquivados.
   *
   * Roda junto com o resto, de minuto em minuto, mas o DELETE só encontra algo
   * uma vez por dia — não vale agendamento próprio. `logs_auditoria` não é
   * tocado: auditoria dura para sempre, aviso resolvido não.
   */
  private async limparAvisosAntigos(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("limpar_avisos_antigos", { p_dias: 90 });
    if (error) {
      this.logger.error(`Limpeza de avisos falhou: ${error.message}`);
      return;
    }
    if (typeof data === "number" && data > 0) {
      this.logger.log(`${data} aviso(s) arquivados removidos.`);
    }
  }

  /**
   * Confere o banco contra o gateway, de minuto em minuto.
   *
   * Existe porque `canais.status` só muda quando chega um `CONNECTION_UPDATE`,
   * e o webhook é a primeira coisa que morre quando algo dá errado — VPS caída,
   * webhook nunca registrado, evento perdido num 429. Sem esta rotina, um canal
   * fica `conectado` no banco por horas enquanto está offline de verdade, e
   * todo erro resultante parece defeito do sistema.
   *
   * É também o que fecha o ciclo: quando o canal volta, as campanhas que ele
   * derrubou retomam sozinhas.
   */
  private async vigiarCanais(): Promise<void> {
    /*
     * `aguardando_qr` entra na lista.
     *
     * Ficava de fora porque "ainda não pareou" parecia não ter o que verificar.
     * Mas o canal só sai desse estado pelo webhook `CONNECTION_UPDATE` — e o
     * webhook é justamente o que falha quando `APP_URL_PUBLICA` não é
     * alcançável pelo gateway. Resultado: número pareado de verdade, com sessão
     * aberta, preso em "Aguardando QR" para sempre, sem nada que o corrigisse.
     */
    const { data, error } = await this.supabase
      .tabela("canais")
      .select("id, nome, status, numero, instancia_evolution, foto_url")
      .eq("tipo_conexao", "qrcode")
      .in("status", ["conectado", "desconectado", "aguardando_qr"]);

    if (error) {
      this.logger.error(`Não foi possível listar canais para vigiar: ${error.message}`);
      return;
    }

    const canais = (data ?? []) as {
      id: string;
      nome: string;
      status: string;
      numero: string | null;
      instancia_evolution: string;
      foto_url: string | null;
    }[];

    for (const canal of canais) {
      const estado = await estadoDaInstancia(canal.instancia_evolution);

      // Gateway mudo não muda NADA no banco. Não sabemos, e chutar aqui é
      // exatamente o bug que este arquivo inteiro existe para corrigir. A regra
      // vem do domínio para não existir uma segunda cópia dela na verificação
      // sob demanda da API.
      const real = statusDoGateway(estado);
      if (real === null) continue;

      /*
       * O número também vem daqui quando falta.
       *
       * `canais.numero` era preenchido só pelo webhook, a partir do `ownerJid`.
       * Sem webhook alcançável, um canal pareado ficava sem número — e a tela,
       * vendo "conectado sem número", concluía corretamente que o pareamento
       * não tinha terminado. O dado sempre esteve no gateway; faltava perguntar.
       */
      const atualizacao: Record<string, unknown> = {
        status: real,
        estado_gateway: estado,
        estado_verificado_em: new Date().toISOString(),
      };

      if (canal.numero === null) {
        const numero = await numeroDaInstancia(canal.instancia_evolution);
        if (numero) {
          atualizacao.numero = numero;
          // Quem pareou de fato já estava conectado antes desta verificação;
          // sem isto a coluna ficaria eternamente vazia na tela.
          atualizacao.conectado_em = new Date().toISOString();
        }
      }

      /*
       * A foto entra pelo mesmo gancho do número, e pelo mesmo motivo: o
       * webhook nunca chegou neste sistema, então a vigilância é o único lugar
       * que percebe um canal recém-pareado.
       *
       * Só quando falta — não a cada minuto.
       */
      if (real === "conectado" && !canal.foto_url) {
        const foto = await this.baixarFoto(canal.id, canal.instancia_evolution);
        if (foto) {
          atualizacao.foto_url = foto;
          atualizacao.foto_em = new Date().toISOString();
        }
      }

      await this.supabase.tabela("canais").update(atualizacao).eq("id", canal.id);

      if (real === canal.status) continue;

      if (real === "conectado") {
        await this.canalVoltou(canal.id, canal.nome);
      } else {
        await registrarIncidente(this.supabase, this.logger, "canal_desconectado", {
          canalId: canal.id,
          canalNome: canal.nome,
          detalhe: "detectado pela vigilância periódica",
        });
        this.logger.warn(`Canal ${canal.nome} está offline no gateway; marcado desconectado.`);
      }
    }
  }

  /**
   * Canal voltou: fecha os incidentes dele e solta as campanhas que ele parou.
   *
   * A retomada precisa de um job de planejamento, não só do status: os contatos
   * voltaram para `pendente`, mas quem os enfileira é o `planejarCampanha`.
   * Sem o `replanejar`, a campanha ficaria "em andamento" sem nada acontecendo.
   */
  async canalVoltou(canalId: string, canalNome: string): Promise<void> {
    await this.supabase.db.rpc("resolver_incidentes_do_canal", { p_canal_id: canalId });

    const { data, error } = await this.supabase.db.rpc("retomar_campanhas_do_canal", {
      p_canal_id: canalId,
    });
    if (error) {
      this.logger.error(`Falha ao retomar campanhas de ${canalNome}: ${error.message}`);
      return;
    }

    const retomadas = (data ?? []) as { campanha_id: string; rodada: number }[];
    for (const c of retomadas) {
      await this.fila.replanejar(c.campanha_id, c.rodada);
    }

    this.logger.log(
      `Canal ${canalNome} voltou; ${retomadas.length} campanha(s) retomadas automaticamente.`,
    );
  }

  private async reconciliarTravados(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("reconciliar_disparos", {
      p_minutos: 15,
      p_max_tentativas: 3,
    });
    if (error) {
      this.logger.error(`Reconciliação falhou: ${error.message}`);
      return;
    }

    const linhas = (data ?? []) as { campanha_id: string; retomados: number }[];
    for (const linha of linhas) {
      this.logger.warn(
        `Campanha ${linha.campanha_id}: ${linha.retomados} contatos estavam travados em ` +
          `envio e voltaram para a fila.`,
      );
    }
  }

  /**
   * Reenfileira campanhas em andamento que têm pendente sem job.
   *
   * Cobre dois casos: o contato que a reconciliação acabou de devolver, e a
   * campanha cujo planejamento morreu antes de enfileirar todo mundo.
   */
  private async replanejarPendentesOrfas(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("campanhas_a_replanejar");
    if (error) {
      this.logger.error(`Não foi possível listar campanhas a replanejar: ${error.message}`);
      return;
    }

    for (const linha of (data ?? []) as { campanha_id: string; pendentes: number }[]) {
      const campanha = await carregarCampanha(this.supabase, linha.campanha_id);
      if (!campanha || campanha.status !== "em_andamento") continue;

      await this.fila.replanejar(linha.campanha_id, campanha.rodada);
      this.logger.log(
        `Campanha "${campanha.nome}": ${linha.pendentes} contatos sem job, replanejando.`,
      );
    }
  }

  private async agregarMetricas(): Promise<void> {
    const { error } = await this.supabase.db.rpc("recalcular_metricas_campanhas_ativas");
    if (error) this.logger.error(`Recálculo de métricas falhou: ${error.message}`);
  }

  private async concluirOrfas(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("concluir_campanhas_orfas");
    if (error) {
      this.logger.error(`Conclusão de campanhas órfãs falhou: ${error.message}`);
      return;
    }
    if (typeof data === "number" && data > 0) {
      this.logger.log(`${data} campanha(s) sem pendências foram concluídas.`);
    }
  }

  /**
   * Retenção dos payloads brutos de webhook.
   *
   * Roda de minuto em minuto junto com o resto, mas o DELETE só encontra algo
   * uma vez por dia — não vale um agendamento próprio só para isso.
   */
  private async limparEventosAntigos(): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("limpar_eventos_webhook", { p_dias: 14 });
    if (error) {
      this.logger.error(`Limpeza de eventos falhou: ${error.message}`);
      return;
    }
    if (typeof data === "number" && data > 0) {
      this.logger.log(`${data} evento(s) de webhook antigos removidos.`);
    }
  }
}
