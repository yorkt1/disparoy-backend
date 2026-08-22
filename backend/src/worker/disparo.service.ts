import { Injectable, Logger } from "@nestjs/common";
import type {
  Canal,
  CodigoFalha,
  MensagemSequencia,
  ResultadoEnvio,
  Spintax,
} from "@disparoy/dominio";
import { categoriaDe, explicar, paraCampanha, statusDoGateway } from "@disparoy/dominio";
import {
  estadoDaInstancia,
  fotoDaInstancia,
  numeroDaInstancia,
} from "../whatsapp/evolution-provider";
import { BUCKET_MIDIA } from "../midia/midia.service";
import { SupabaseService } from "../supabase/supabase.service";
import { AuditoriaService } from "../auditoria/auditoria.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import {
  FILA_CAMPANHA,
  FILA_CONTATO,
  FilaService,
  type ContatoAgendado,
  type JobCampanha,
  type JobContato,
} from "../fila/fila.service";
import { COLUNAS_CANAL, paraCanal, type LinhaCanal } from "../comum/mapeadores";
import { LimitesService } from "../comum/limites.service";
import { explicarLimite, LIMITES_POR_PLANO, PLANO_PADRAO } from "../comum/limites-empresa";
import { ambiente } from "../config/ambiente";

const COLUNAS_EXECUCAO =
  "id, nome, status, rodada, sequencia, iniciada_em, validar_numeros, empresa_id, " +
  "intervalo_contatos_min, intervalo_contatos_max, intervalo_mensagens_min, intervalo_mensagens_max";

interface LinhaExecucao {
  id: string;
  nome: string;
  status: string;
  rodada: number | null;
  sequencia: unknown;
  iniciada_em: string | null;
  validar_numeros: boolean;
  // Não é opcional no banco (`empresa_obrigatoria`), mas a coluna é lida como
  // string | null aqui porque um SELECT montado em runtime não carrega o
  // "not null" do schema — só o dado que veio.
  empresa_id: string | null;
  intervalo_contatos_min: number;
  intervalo_contatos_max: number;
  intervalo_mensagens_min: number;
  intervalo_mensagens_max: number;
}

/** Só o que o worker precisa para executar — não a campanha inteira. */
interface CampanhaEmExecucao {
  id: string;
  nome: string;
  status: string;
  rodada: number;
  sequencia: MensagemSequencia[];
  iniciadaEm: string | null;
  validarNumeros: boolean;
  /**
   * Dona da campanha — carregada só para marcar a auditoria dos eventos que o
   * PRÓPRIO worker gera (`campanha.pausada` por reconciliação, `campanha.
   * concluida`). Sem isto, `AuditoriaService.registrar` não tem como derivar a
   * empresa: não há `usuarioId` num evento de sistema, é `null` de propósito.
   */
  empresaId: string | null;
  intervaloContatosMin: number;
  intervaloContatosMax: number;
  intervaloMensagensMin: number;
  intervaloMensagensMax: number;
}

interface DestinoDaFila {
  id: number;
  contatoId: string;
  telefone: string;
  variaveis: Record<string, string>;
}

/**
 * Execução da campanha.
 *
 * Dois jobs em vez de um laço longo:
 *  - `disparo-campanha` só planeja: reserva os pendentes, distribui entre os
 *    canais em rodízio e enfileira um job por contato com o atraso sorteado.
 *  - `disparo-contato` envia a sequência de UM contato e termina.
 *
 * Assim o intervalo de 15–45 s vira `startAfter` no banco, não um processo
 * dormindo. Se o worker cair no meio de uma campanha de 25 horas, outro assume
 * os jobs sem perder nada.
 *
 * Três invariantes sustentam isso, e todas moram no banco — não na fila:
 *  - `enfileirado_em` garante que um contato só vira job uma vez;
 *  - `rodada` aposenta jobs de execuções anteriores (pausar/retomar);
 *  - `mensagens_enviadas` diz quais passos já saíram, então retry retoma de
 *    onde parou em vez de reenviar tudo.
 */
@Injectable()
export class DisparoService {
  private readonly logger = new Logger(DisparoService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly auditoria: AuditoriaService,
    private readonly whatsapp: WhatsappService,
    private readonly fila: FilaService,
    private readonly limites: LimitesService,
  ) {}

  // ------------------------------------------------------------------------
  // Job 1: planejar
  // ------------------------------------------------------------------------

  async planejarCampanha(job: JobCampanha): Promise<void> {
    const campanha = await this.carregarCampanha(job.campanhaId);
    if (!campanha) {
      this.logger.warn(`Campanha ${job.campanhaId} sumiu antes de iniciar.`);
      return;
    }
    if (this.rodadaVencida(job, campanha)) return;
    if (campanha.status === "pausada" || campanha.status === "concluida") {
      this.logger.log(`Campanha "${campanha.nome}" está ${campanha.status}; nada a planejar.`);
      return;
    }

    const canais = await this.canaisConectadosDa(job.campanhaId);
    if (canais.length === 0) {
      await this.marcarFalha(job, "Nenhum canal conectado no momento do disparo.");
      return;
    }

    await this.supabase
      .tabela("campanhas")
      .update({
        status: "em_andamento",
        iniciada_em: campanha.iniciadaEm ?? new Date().toISOString(),
      })
      .eq("id", job.campanhaId);

    /**
     * Reserva os pendentes num único UPDATE ... RETURNING.
     *
     * É aqui que mora a garantia contra envio duplicado. Antes, o planejamento
     * lia os pendentes e enfileirava um por um: se o job fosse repetido — retry
     * do pg-boss, dois cliques em "Disparar", retomada de campanha pausada — o
     * mesmo contato virava job de novo e recebia a mensagem outra vez.
     *
     * Com o filtro `enfileirado_em is null` dentro do próprio UPDATE, dois
     * planejamentos concorrentes disputam a linha no Postgres e só um a leva.
     */
    const reservados = await this.reservarPendentes(job.campanhaId, campanha.empresaId);
    if (reservados.length === 0) {
      await this.finalizarSeTerminou(job.campanhaId);
      return;
    }

    // Rodízio entre os canais: reduz o volume por número, que é o que mais
    // pesa no risco de bloqueio.
    let atrasoAcumulado = 0;
    const atrasos = reservados.map(() => {
      const atraso = atrasoAcumulado;
      atrasoAcumulado += this.sortearIntervalo(
        campanha.intervaloContatosMin,
        campanha.intervaloContatosMax,
      );
      return atraso;
    });

    /**
     * Onde esta leva começa na linha do tempo da campanha.
     *
     * Todo planejamento anterior começava o atraso em ZERO. Com um
     * planejamento só por campanha isso estava certo; com mais de um deixou de
     * estar, e mais de um já acontecia antes desta mudança — `reconciliar_
     * disparos` devolve contatos travados e `replanejarPendentesOrfas` chama o
     * planejamento de novo, com a campanha ainda cheia de jobs agendados para
     * as próximas horas. Os recuperados eram agendados a partir de agora e
     * caíam POR CIMA dos que já estavam marcados: a cadência de 15–45 s virava
     * dois envios no mesmo instante, que é exatamente o padrão que faz o
     * número ser bloqueado.
     *
     * `reservar_janela_de_envio` resolve isso no banco, num UPDATE só: cada
     * leva reserva o próprio trecho da linha do tempo e empurra `fila_ate`.
     * Dois planejamentos concorrentes recebem trechos que não se sobrepõem.
     */
    const inicio = await this.reservarJanela(job.campanhaId, atrasoAcumulado);
    const deslocamentoBase = Math.max((inicio.getTime() - Date.now()) / 1000, 0);

    const agendados: ContatoAgendado[] = reservados.map((contatoId, i) => ({
      dados: {
        campanhaId: job.campanhaId,
        contatoId,
        canalId: canais[i % canais.length].id,
        rodada: campanha.rodada,
      },
      atrasoSegundos: deslocamentoBase + atrasos[i],
    }));

    try {
      await this.fila.agendarContatosEmLote(agendados);
    } catch (e) {
      // A reserva já está gravada; sem devolvê-la, estes contatos ficariam
      // marcados como enfileirados para jobs que nunca existiram — pendentes
      // para sempre, invisíveis para o replanejamento.
      await this.devolverReserva(reservados);
      // E a janela também: `fila_ate` foi empurrado por uma leva que não virou
      // job nenhum. Sem devolver, o replanejamento seguinte agendaria DEPOIS
      // do buraco — numa leva de 2.000 contatos são ~16 h de silêncio, sem
      // nada na tela explicando por quê.
      await this.devolverJanela(job.campanhaId, inicio, atrasoAcumulado);
      throw e;
    }

    this.logger.log(
      `Campanha "${campanha.nome}": ${reservados.length} contatos em ${canais.length} canais ` +
        `(primeiro em ~${Math.round(deslocamentoBase / 60)} min, ` +
        `último em ~${Math.round((deslocamentoBase + atrasoAcumulado) / 60)} min).`,
    );
  }

  // ------------------------------------------------------------------------
  // Job 2: enviar para um contato
  // ------------------------------------------------------------------------

  async dispararContato(job: JobContato): Promise<void> {
    const campanha = await this.carregarCampanha(job.campanhaId);
    // Pausar no meio precisa parar de verdade: os jobs já enfileirados só
    // descobrem isso aqui, então a checagem vem antes de qualquer envio.
    if (!campanha || campanha.status === "pausada") return;
    if (this.rodadaVencida(job, campanha)) return;

    const [canal, destino] = await Promise.all([
      this.carregarCanal(job.canalId),
      this.carregarDestino(job.contatoId),
    ]);
    if (!canal || !destino) return;

    if (canal.status !== "conectado") {
      /**
       * NÃO marca o contato como falhou.
       *
       * `canais.status` é cache do webhook, e webhook perdido queimava a
       * campanha inteira por engano: cada job acordava, marcava `falhou` e
       * consumia a si mesmo. Em vinte minutos, 4.800 contatos destruídos e a
       * campanha fechando como "concluída" com 4% de entrega — sem nada para
       * reenviar a não ser UPDATE manual no banco.
       *
       * Quem decide de quem é a culpa é o gateway, não o cache.
       */
      await this.tratarSuspeitaDeCanal(job, canal, "canal_desconectado", "status local do canal");
      return;
    }

    /**
     * Passos que já saíram numa tentativa anterior.
     *
     * O job tem `retryLimit: 2`. Sem esta checagem, uma sequência de três
     * mensagens que falha na terceira reenviava as duas primeiras no retry — a
     * pessoa recebia "Oi, tudo bem?" duas vezes, o que num disparo é pior que
     * a falha original: é o que faz o contato denunciar o número.
     */
    const jaEnviados = await this.passosJaEnviados(job.contatoId);
    const restantes = campanha.sequencia.length - jaEnviados.size;
    if (restantes <= 0) {
      await this.encerrarContato(job, "concluido", null);
      return;
    }

    /**
     * Cota diária da EMPRESA, antes da do canal.
     *
     * O teto do canal protege o NÚMERO contra bloqueio; este protege o worker,
     * que é um processo só compartilhado por todos os clientes. Sem ele, um
     * cliente que importa 300 mil contatos ocupa a fila por dias e as campanhas
     * dos outros ficam "em andamento" a 0% — sem erro em lugar nenhum, que é a
     * falha mais difícil de diagnosticar que este produto tem.
     *
     * Vem primeiro de propósito: se a empresa já estourou o dia, não faz
     * sentido consumir cota do canal para devolvê-la na linha seguinte.
     *
     * O contato volta para `pendente` e sai amanhã. Marcar `falhou` por causa
     * de um limite NOSSO destruiria a campanha do cliente — é a mesma regra que
     * o resto do worker segue para falha de canal (ver
     * `ARQUITETURA-ATRIBUICAO-DE-FALHA.md`).
     */
    const temCotaDaEmpresa = await this.limites.consumirCota(campanha.empresaId, restantes);
    if (!temCotaDaEmpresa) {
      const teto = campanha.empresaId
        ? (await this.limites.limitesDe(campanha.empresaId)).mensagensPorDia
        : null;

      this.logger.warn(
        `Empresa ${campanha.empresaId} atingiu o limite diário de mensagens; contato adiado.`,
      );
      // Incidente, e não só log: adiar por limite é decisão correta do sistema
      // e invisível para quem está olhando a campanha desacelerar. Mesmo
      // tratamento que `cota_diaria_atingida` do canal já recebe.
      await this.registrarIncidenteDaEmpresa(campanha.empresaId, {
        campanhaId: job.campanhaId,
        detalhe: explicarLimite("mensagens", teto ?? 0),
      });
      await this.liberarParaReplanejar(job.contatoId);
      return;
    }

    /**
     * Cota diária do canal, consumida no banco com lock.
     *
     * Estourar o teto de um número novo é o caminho mais rápido para bloqueio,
     * então o contato volta para `pendente` — a campanha continua amanhã em vez
     * de queimar o canal hoje. Reserva só o que falta enviar: cobrar de novo
     * pelos passos já entregues consumiria cota duas vezes no retry.
     */
    const { data: temCota } = await this.supabase.db.rpc("consumir_cota_canal", {
      p_canal_id: canal.id,
      p_quantidade: restantes,
    });
    if (temCota !== true) {
      // A cota da empresa foi consumida na linha de cima e nenhuma mensagem
      // vai sair: sem devolver, o teto diário do cliente seria queimado por um
      // envio que não aconteceu — e num canal com limite baixo isso zeraria o
      // dia inteiro dele em minutos.
      await this.limites.devolverCota(campanha.empresaId, restantes);
      this.logger.warn(`Canal ${canal.nome} atingiu o limite diário; contato adiado.`);
      // Abre incidente em vez de só logar: adiar por cota é decisão correta do
      // sistema, mas invisível. O operador via a campanha desacelerar sem saber
      // por quê, e o motivo morria no stdout do Render.
      await this.registrarIncidente("cota_diaria_atingida", {
        canalId: canal.id,
        canalNome: canal.nome,
        campanhaId: job.campanhaId,
      });
      // Volta a ser candidato ao replanejamento; sem isto o contato ficaria
      // reservado para um job que já terminou.
      await this.liberarParaReplanejar(job.contatoId);
      return;
    }

    await this.supabase
      .tabela("campanha_contatos")
      .update({
        status: "enviando",
        canal_id: canal.id,
        // Carimbo que o reaper lê: sem ele, um worker morto deixa este contato
        // em "enviando" para sempre e a campanha nunca conclui.
        enviando_desde: new Date().toISOString(),
      })
      .eq("id", job.contatoId);

    if (campanha.validarNumeros) {
      const [checagem] = await this.whatsapp.validarNumeros(canal, [destino.telefone]);
      if (checagem?.verificado && !checagem.existeNoWhatsApp) {
        await this.devolverCota(canal.id, restantes);
        await this.limites.devolverCota(campanha.empresaId, restantes);
        await this.encerrarContato(
          job,
          "invalido",
          explicar("numero_inexistente"),
          "numero_inexistente",
        );
        return;
      }
    }

    const variacoes = await this.variacoes(campanha.empresaId);
    let enviados = 0;
    let falha: { codigo: CodigoFalha; detalhe: string } | null = null;

    await this.whatsapp.dispararSequencia({
      canal,
      destinatario: { telefone: destino.telefone, variaveis: destino.variaveis },
      sequencia: campanha.sequencia,
      variacoes,
      pularPassos: jaEnviados,
      aoTerminarPasso: async (passo) => {
        await this.gravarMensagem(job, canal.id, passo);
        if (!passo.resultado.ok) {
          falha = { codigo: passo.resultado.codigo, detalhe: passo.resultado.erro };
          return;
        }
        enviados += 1;
        await this.esperar(
          this.sortearIntervalo(campanha.intervaloMensagensMin, campanha.intervaloMensagensMax) *
            1000,
        );
      },
    });

    // Cota é reserva, não cobrança: o que não virou mensagem volta para o
    // canal. Em número novo, cota queimada à toa é campanha parada mais cedo.
    // A da empresa segue a mesma regra, e pelo mesmo motivo — um passo que
    // falhou não pode consumir o teto diário do cliente.
    await this.devolverCota(canal.id, restantes - enviados);
    await this.limites.devolverCota(campanha.empresaId, restantes - enviados);

    if (!falha) {
      await this.encerrarContato(job, "concluido", null);
      return;
    }

    // O TypeScript perde o estreitamento dentro do callback assíncrono.
    const motivo = falha as { codigo: CodigoFalha; detalhe: string };

    /**
     * Falha que afeta todos os próximos envios igualmente não pode encerrar só
     * este contato: insistir transformaria uma falha em cinco mil. O contato
     * volta para `pendente` e a campanha pausa, depois de confirmar no gateway
     * de quem foi a culpa.
     */
    if (paraCampanha(motivo.codigo)) {
      await this.tratarSuspeitaDeCanal(job, canal, motivo.codigo, motivo.detalhe);
      return;
    }

    await this.encerrarContato(
      job,
      motivo.codigo === "numero_inexistente" ? "invalido" : "falhou",
      explicar(motivo.codigo, { canal: canal.nome, detalhe: motivo.detalhe }),
      motivo.codigo,
    );
  }

  // ------------------------------------------------------------------------
  // Atribuição de falha
  // ------------------------------------------------------------------------

  /**
   * Confirma no gateway antes de acusar alguém.
   *
   * Esta função é a resposta à pergunta que o sistema inteiro não sabia
   * responder: a falha foi do WhatsApp do cliente, ou foi nossa?
   *
   * O contato NUNCA vira `falhou` aqui. Se a culpa é do canal ou da infra, ele
   * volta para `pendente` e a campanha pausa — falha permanente fica reservada
   * a causas permanentes, como número que não existe.
   */
  private async tratarSuspeitaDeCanal(
    job: JobContato,
    canal: Canal,
    suspeita: CodigoFalha,
    detalhe: string,
  ): Promise<void> {
    const estado = await estadoDaInstancia(canal.instanciaEvolution);

    await this.supabase
      .tabela("canais")
      .update({ estado_verificado_em: new Date().toISOString(), estado_gateway: estado })
      .eq("id", canal.id);

    /**
     * O gateway respondeu que a sessão está viva: a suspeita era falsa.
     *
     * A falha foi do destinatário ou do conteúdo, e a campanha não tem por que
     * parar. Aproveita para corrigir o cache, que estava mentindo.
     */
    if (estado === "open") {
      if (canal.status !== "conectado") {
        await this.supabase.tabela("canais").update({ status: "conectado" }).eq("id", canal.id);
      }
      await this.encerrarContato(
        job,
        "falhou",
        explicar(suspeita, { canal: canal.nome, detalhe }),
        suspeita,
      );
      return;
    }

    // Gateway mudo significa que o problema é NOSSO, não do WhatsApp do
    // cliente. Trocar o código aqui é o que impede o sistema de acusar o
    // inocente — que é exatamente o bug que tudo isto existe para corrigir.
    const codigo: CodigoFalha = estado === "indisponivel" ? "gateway_indisponivel" : suspeita;

    // Só rebaixa o canal quando o gateway CONFIRMOU que a sessão caiu.
    if (estado === "close" || estado === "connecting") {
      await this.supabase
        .tabela("canais")
        .update({ status: "desconectado", ultimo_erro_codigo: codigo })
        .eq("id", canal.id);
    }

    await this.registrarIncidente(codigo, {
      canalId: canal.id,
      canalNome: canal.nome,
      campanhaId: job.campanhaId,
      detalhe,
    });

    const { data: devolvidos, error } = await this.supabase.db.rpc("pausar_campanha_por_canal", {
      p_campanha_id: job.campanhaId,
      p_canal_id: canal.id,
      p_motivo: explicar(codigo, { canal: canal.nome, detalhe }),
    });

    if (error) {
      this.logger.error(`Não foi possível pausar a campanha ${job.campanhaId}: ${error.message}`);
      return;
    }

    this.logger.warn(
      `Campanha ${job.campanhaId} pausada por ${codigo} (gateway: ${estado}); ` +
        `${devolvidos ?? 0} contatos devolvidos à fila.`,
    );
  }

  /** Abre ou incrementa o incidente aberto daquele canal e código. */
  private async registrarIncidente(
    codigo: CodigoFalha,
    ctx: { canalId?: string; canalNome?: string; campanhaId?: string; detalhe?: string },
  ): Promise<void> {
    const { error } = await this.supabase.db.rpc("abrir_incidente", {
      p_categoria: categoriaDe(codigo),
      p_codigo: codigo,
      p_titulo: explicar(codigo, { canal: ctx.canalNome, detalhe: ctx.detalhe }),
      p_canal_id: ctx.canalId ?? null,
      p_campanha_id: ctx.campanhaId ?? null,
      p_detalhe: ctx.detalhe ?? null,
    });
    // Não relança: incidente é observabilidade. Derrubar um disparo porque o
    // registro do aviso falhou seria trocar um problema por um pior.
    if (error) this.logger.error(`Falha ao registrar incidente ${codigo}: ${error.message}`);
  }

  /**
   * Incidente de limite da EMPRESA — fora da união `CodigoFalha`, de propósito.
   *
   * Aquele tipo classifica falha de ENVIO de mensagem, e o compilador recusar
   * caminho não coberto é o que o mantém útil (ver `shared/src/whatsapp/
   * falhas.ts`). "O cliente bateu no teto do plano" não é falha de envio: é
   * uma decisão de capacidade nossa. `incidentes.codigo` é `text`, não o enum,
   * e o vigia do worker já usa esse espaço da mesma forma (`worker_parado`).
   */
  private async registrarIncidenteDaEmpresa(
    empresaId: string | null,
    ctx: { campanhaId?: string; detalhe?: string },
  ): Promise<void> {
    const { error } = await this.supabase.db.rpc("abrir_incidente", {
      p_categoria: "limite",
      p_codigo: "limite_empresa_atingido",
      p_titulo: "Limite diário de mensagens da empresa atingido",
      p_canal_id: null,
      p_campanha_id: ctx.campanhaId ?? null,
      p_detalhe: ctx.detalhe ?? null,
    });
    if (error) {
      this.logger.error(
        `Falha ao registrar incidente de limite da empresa ${empresaId}: ${error.message}`,
      );
    }
  }

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
  async manutencao(): Promise<void> {
    // Antes de qualquer trabalho: o pulso responde "o worker está vivo?", e é
    // o que permite ao painel avisar que nenhuma campanha está saindo. Bater no
    // fim faria uma manutenção que falha no meio parecer worker morto.
    await this.baterPulso();

    // Vem primeiro: reconciliar contatos de um canal que está offline só
    // devolveria trabalho para uma fila que não tem por onde sair.
    await this.vigiarCanais();
    await this.reconciliarTravados();
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
      p_carencia_minutos: 5,
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
        await this.registrarIncidente("canal_desconectado", {
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

  /**
   * Job que esgotou as tentativas e caiu na dead letter.
   *
   * A fila de mortos existia desde o começo e nunca teve leitor: os jobs
   * ficavam guardados no schema `fila` e ninguém olhava. Depois passou a abrir
   * um incidente — e aí a informação se perdia de outro jeito.
   *
   * `abrir_incidente` é upsert sobre `(categoria, codigo, canal_id)`. Todo job
   * morto sem canal caía na MESMA chave: o primeiro criava a linha, e do
   * segundo em diante só `ocorrencias` subia e `detalhe` era sobrescrito pelo
   * mais recente. Quinhentos contatos perdidos viravam um incidente dizendo
   * "ocorrencias: 500" e o id do último. Não dava para saber QUAIS ficaram
   * para trás, logo não dava para recuperá-los — o registro existia e não
   * servia para nada.
   *
   * Agora cada job morto é uma LINHA em `jobs_mortos`, com o payload inteiro.
   * O incidente continua, com código próprio (`job_morto`), no papel que faz
   * bem: avisar que aconteceu. Quem responde "o quê, exatamente" é a tabela.
   *
   * Recuperação é MANUAL (`reprocessar_job_morto`), e isso é decisão: um job
   * que já gastou os retries provou que aquele caminho não funciona, e
   * reinsistir sozinho vira laço consumindo a fila. No caso mais provável —
   * mídia que a Evolution recusa, número que trava a instância — o
   * reprocessamento automático transformaria uma falha permanente em carga
   * permanente.
   */
  async registrarJobMorto(job: { id?: string; name?: string; data?: unknown }): Promise<void> {
    const dados = (job.data ?? {}) as {
      campanhaId?: string;
      canalId?: string;
      contatoId?: number;
    };
    /*
     * A fila de ORIGEM é deduzida do payload, não lida de `job.name`.
     *
     * O pg-boss não preserva a origem: ao mover para a dead letter ele INSERE
     * uma linha nova na fila de destino copiando só `data`, `output`,
     * `retry_limit` e `keep_until` (ver `plans.js`, `dlq_jobs`). `job.name`
     * aqui é sempre "disparo-mortos", o que não ajuda ninguém a entender o que
     * quebrou. A forma do payload distingue os dois casos que existem, e é a
     * informação que de fato está disponível.
     */
    const filaDeOrigem =
      dados.contatoId !== undefined
        ? FILA_CONTATO
        : dados.campanhaId !== undefined
          ? FILA_CAMPANHA
          : (job.name ?? "desconhecida");

    this.logger.error(`Job morto vindo de ${filaDeOrigem} (dead letter ${job.id ?? "?"}).`);

    const { data: id, error } = await this.supabase.db.rpc("registrar_job_morto", {
      p_fila: filaDeOrigem,
      // `?? null`: um job antigo pode não trazer id, e a coluna aceita nulo
      // justamente para o registro não se perder por causa disso.
      p_job_id: job.id ?? null,
      p_payload: dados,
      p_motivo: "Esgotou as tentativas e caiu na dead letter.",
    });

    if (error) {
      // Isto é o registro da falha falhando. Não há para onde escalar além do
      // log — e é exatamente por isso que ele é `error` e carrega o payload.
      this.logger.error(
        `Falha ao gravar o job morto (o payload seria perdido): ${error.message} — ` +
          `payload: ${JSON.stringify(dados)}`,
      );
    }

    await this.registrarIncidenteDeJobMorto({
      canalId: dados.canalId,
      campanhaId: dados.campanhaId,
      // `Number(null)` é 0, e `Number.isFinite(0)` é true: sem esta guarda, a
      // gravação FALHANDO produzia um incidente mandando o operador rodar
      // `reprocessar_job_morto(0)`, que não existe. Um registro inventado é
      // pior que registro nenhum — este é o caminho de perder informação, e
      // ele não pode mentir sobre onde ela está.
      registro: typeof id === "number" && Number.isFinite(id) ? id : null,
      contatoId: dados.contatoId,
    });
  }

  /**
   * Incidente de job morto. Código próprio, fora da união `CodigoFalha`.
   *
   * `desconhecido` era o código usado antes, e ele significa outra coisa: "o
   * gateway devolveu um erro que a taxonomia ainda não classifica" (ver
   * `shared/src/whatsapp/falhas.ts`). Misturar as duas coisas fazia o
   * diagnóstico de falhas de ENVIO contar jobs mortos junto, e o operador
   * procurava um problema de WhatsApp que não existia.
   */
  private async registrarIncidenteDeJobMorto(ctx: {
    canalId?: string;
    campanhaId?: string;
    contatoId?: number;
    registro: number | null;
  }): Promise<void> {
    const referencia =
      ctx.registro === null
        ? "O registro em jobs_mortos NÃO pôde ser gravado — o payload está apenas no log do worker."
        : `Registro ${ctx.registro} em jobs_mortos. ` +
          `Reprocessar com: select reprocessar_job_morto(${ctx.registro});`;

    const { error } = await this.supabase.db.rpc("abrir_incidente", {
      p_categoria: "infra",
      p_codigo: "job_morto",
      p_titulo: "Um job de disparo esgotou as tentativas",
      p_canal_id: ctx.canalId ?? null,
      p_campanha_id: ctx.campanhaId ?? null,
      p_detalhe: (ctx.contatoId ? `Contato ${ctx.contatoId}. ` : "") + referencia,
    });
    if (error) this.logger.error(`Falha ao registrar incidente de job morto: ${error.message}`);
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
      const campanha = await this.carregarCampanha(linha.campanha_id);
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

  /**
   * Expurgo de `mensagens_enviadas` — chamado pela fila `retencao`, uma vez
   * por dia, não pela `manutencao` de minuto em minuto.
   *
   * Só apaga de campanha `concluida`/`falhou`: uma pausada pode retomar, e a
   * retomada lê `passo` desta mesma tabela para saber onde parou (ver
   * `ROBUSTEZ.md`) — apagar essas linhas destruiria o estado que evita
   * reenviar mensagem já entregue.
   */
  async purgarMensagensAntigas(dias = 365): Promise<void> {
    const { data, error } = await this.supabase.db.rpc("purgar_mensagens_antigas", {
      p_dias: dias,
    });
    if (error) {
      this.logger.error(`Expurgo de mensagens antigas falhou: ${error.message}`);
      return;
    }
    if (typeof data === "number" && data > 0) {
      this.logger.log(`${data} mensagem(ns) com mais de ${dias} dias removidas.`);
    }
  }

  // ------------------------------------------------------------------------
  // Apoio
  // ------------------------------------------------------------------------

  /**
   * Job nascido numa execução anterior da campanha.
   *
   * Acontece toda vez que alguém pausa e retoma: os jobs antigos continuam na
   * fila e vão acordar em algum momento. Sem esta porta, eles enviariam junto
   * com os novos e o contato receberia duas vezes.
   *
   * Job sem `rodada` é de antes desta mudança — aceito, para uma fila que já
   * estava cheia no momento do deploy não ser descartada inteira.
   */
  private rodadaVencida(job: { rodada?: number }, campanha: CampanhaEmExecucao): boolean {
    if (job.rodada === undefined) return false;
    if (job.rodada === campanha.rodada) return false;

    this.logger.debug(
      `Job da rodada ${job.rodada} descartado; campanha ${campanha.id} está na ${campanha.rodada}.`,
    );
    return true;
  }

  /** Intervalo aleatório: cadência fixa é assinatura de robô. */
  private sortearIntervalo(min: number, max: number): number {
    const piso = Math.min(min, max);
    const teto = Math.max(min, max);
    return Math.round(piso + Math.random() * (teto - piso));
  }

  private esperar(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async carregarCampanha(id: string): Promise<CampanhaEmExecucao | null> {
    const { data } = await this.supabase
      .tabela("campanhas")
      .select(COLUNAS_EXECUCAO)
      .eq("id", id)
      .maybeSingle();

    if (!data) return null;
    // O supabase-js não infere tipo de um SELECT montado em runtime.
    const l = data as unknown as LinhaExecucao;

    return {
      id: l.id,
      nome: l.nome,
      status: l.status,
      rodada: l.rodada ?? 0,
      sequencia: Array.isArray(l.sequencia) ? (l.sequencia as MensagemSequencia[]) : [],
      iniciadaEm: l.iniciada_em,
      validarNumeros: l.validar_numeros,
      empresaId: l.empresa_id,
      intervaloContatosMin: l.intervalo_contatos_min,
      intervaloContatosMax: l.intervalo_contatos_max,
      intervaloMensagensMin: l.intervalo_mensagens_min,
      intervaloMensagensMax: l.intervalo_mensagens_max,
    };
  }

  /**
   * Reserva os pendentes — com TETO — e devolve os ids em ordem estável.
   *
   * Antes: `update ... where enfileirado_em is null` sobre a campanha inteira.
   * Uma campanha de 200 mil contatos devolvia 200 mil ids num array de
   * JavaScript e virava 400 inserts de lote numa tacada só, com o job de
   * planejamento segurando a fila do começo ao fim. Enquanto isso, NENHUMA
   * outra campanha planejava — um cliente grande travava a fila dos outros.
   *
   * A atomicidade é a mesma, e é o ponto: continua sendo UM `update ...
   * returning`, agora dentro de `reservar_contatos_pendentes`. Dois workers
   * chamando isto ao mesmo tempo NÃO recebem o mesmo contato — o `for update
   * skip locked` do subselect faz o segundo nem enxergar as linhas travadas
   * pelo primeiro, e o `enfileirado_em is null` continua no WHERE do UPDATE
   * como segunda trava.
   *
   * O que fica de fora do teto sai no ciclo seguinte: `campanhas_a_replanejar`
   * roda de minuto em minuto procurando exatamente "pendente sem job". Nenhum
   * contato se perde — ele só é agendado mais tarde, e `reservar_janela_de_
   * envio` garante que "mais tarde" seja DEPOIS do último já agendado, não por
   * cima dele.
   */
  private async reservarPendentes(campanhaId: string, empresaId: string | null): Promise<number[]> {
    const { data, error } = await this.supabase.db.rpc("reservar_contatos_pendentes", {
      p_campanha_id: campanhaId,
      p_limite: await this.tetoPorPlanejamento(empresaId),
    });

    if (error) throw new Error(`Falha ao reservar contatos da campanha: ${error.message}`);

    // O RETURNING do Postgres não promete ordem, e a ordem importa: define o
    // rodízio de canais e o atraso acumulado de cada contato.
    return ((data ?? []) as { contato_id: number }[])
      .map((l) => Number(l.contato_id))
      .sort((a, b) => a - b);
  }

  /** Quantos contatos um planejamento reserva por vez, pelo plano da empresa. */
  private async tetoPorPlanejamento(empresaId: string | null): Promise<number> {
    if (empresaId === null) return LIMITES_POR_PLANO[PLANO_PADRAO].contatosPorPlanejamento;
    return (await this.limites.limitesDe(empresaId)).contatosPorPlanejamento;
  }

  /**
   * Reserva o trecho da linha do tempo desta leva e devolve onde ele começa.
   *
   * Ver `reservar_janela_de_envio` na migration 20260822000300 para o porquê:
   * sem isto, duas levas da mesma campanha são agendadas uma por cima da
   * outra e a cadência de 15–45 s vira dois envios no mesmo instante.
   */
  private async reservarJanela(campanhaId: string, duracaoSegundos: number): Promise<Date> {
    const { data, error } = await this.supabase.db.rpc("reservar_janela_de_envio", {
      p_campanha_id: campanhaId,
      p_duracao_segundos: Math.round(duracaoSegundos),
    });

    if (error) {
      // Cair para "agora" mantém o comportamento anterior a esta mudança —
      // pior do que a janela, melhor do que não agendar nada.
      this.logger.warn(`Não foi possível reservar a janela de envio: ${error.message}`);
      return new Date();
    }
    const inicio = typeof data === "string" ? new Date(data) : new Date();
    return Number.isNaN(inicio.getTime()) ? new Date() : inicio;
  }

  /**
   * Desfaz a reserva da janela quando o enfileiramento falhou.
   *
   * A RPC é compare-and-swap: só escreve se `fila_ate` ainda for o que esta
   * leva gravou. Se outro planejamento avançou a linha do tempo no meio, ela
   * não faz nada — devolver ali encavalaria a leva do outro, que é o problema
   * que a janela existe para evitar.
   */
  private async devolverJanela(
    campanhaId: string,
    inicio: Date,
    duracaoSegundos: number,
  ): Promise<void> {
    const { error } = await this.supabase.db.rpc("devolver_janela_de_envio", {
      p_campanha_id: campanhaId,
      p_inicio: inicio.toISOString(),
      p_duracao_segundos: Math.round(duracaoSegundos),
    });
    // Não relança: quem chamou já está tratando um erro, e o pior caso aqui é
    // a campanha retomar depois de um intervalo maior — não perder contato.
    if (error) this.logger.warn(`Não foi possível devolver a janela de envio: ${error.message}`);
  }

  /**
   * Devolve a reserva, em fatias.
   *
   * O `.in()` do supabase-js vira lista na QUERY STRING. Com 5.000 ids a URL
   * passa de 60 KB e o PostgREST responde 414 — justamente no caminho de
   * recuperação de erro, que é o pior lugar possível para falhar em silêncio.
   */
  private async devolverReserva(ids: number[]): Promise<void> {
    const FATIA = 500;
    for (let i = 0; i < ids.length; i += FATIA) {
      const { error } = await this.supabase
        .tabela("campanha_contatos")
        .update({ enfileirado_em: null })
        .in("id", ids.slice(i, i + FATIA));

      // Não relança: quem chamou já está tratando um erro, e a reconciliação
      // periódica alcança o que sobrar aqui.
      if (error) this.logger.error(`Falha ao devolver reserva de contatos: ${error.message}`);
    }
  }

  private async liberarParaReplanejar(contatoId: number): Promise<void> {
    await this.supabase
      .tabela("campanha_contatos")
      .update({ status: "pendente", enfileirado_em: null, enviando_desde: null })
      .eq("id", contatoId);
  }

  /**
   * Passos desta linha de campanha que já foram entregues ao WhatsApp.
   *
   * `falhou` fica de fora: passo que falhou precisa ser tentado de novo.
   */
  private async passosJaEnviados(campanhaContatoId: number): Promise<Set<number>> {
    const { data } = await this.supabase
      .tabela("mensagens_enviadas")
      .select("passo, status")
      .eq("campanha_contato_id", campanhaContatoId);

    const passos = new Set<number>();
    for (const l of (data ?? []) as { passo: number; status: string }[]) {
      if (l.status !== "falhou") passos.add(l.passo);
    }
    return passos;
  }

  private async devolverCota(canalId: string, quantidade: number): Promise<void> {
    if (quantidade <= 0) return;
    const { error } = await this.supabase.db.rpc("devolver_cota_canal", {
      p_canal_id: canalId,
      p_quantidade: quantidade,
    });
    if (error) this.logger.warn(`Não foi possível devolver cota do canal: ${error.message}`);
  }

  private async canaisConectadosDa(campanhaId: string): Promise<Canal[]> {
    const { data } = await this.supabase
      .tabela("campanha_canais")
      .select(`canais(${COLUNAS_CANAL})`)
      .eq("campanha_id", campanhaId);

    return ((data ?? []) as unknown as { canais: LinhaCanal | null }[])
      .map((l) => l.canais)
      .filter((c): c is LinhaCanal => c !== null && c.status === "conectado")
      .map(paraCanal);
  }

  private async carregarCanal(id: string): Promise<Canal | null> {
    const { data } = await this.supabase
      .tabela("canais")
      .select(COLUNAS_CANAL)
      .eq("id", id)
      .maybeSingle();
    return data ? paraCanal(data as unknown as LinhaCanal) : null;
  }

  private async carregarDestino(id: number): Promise<DestinoDaFila | null> {
    const { data } = await this.supabase
      .tabela("campanha_contatos")
      .select("id, contato_id, telefone, variaveis")
      .eq("id", id)
      .maybeSingle();

    if (!data) return null;
    const l = data as { id: number; contato_id: string; telefone: string; variaveis: unknown };
    const variaveis =
      l.variaveis && typeof l.variaveis === "object" && !Array.isArray(l.variaveis)
        ? Object.fromEntries(
            Object.entries(l.variaveis as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v ?? ""),
            ]),
          )
        : {};

    return { id: l.id, contatoId: l.contato_id, telefone: l.telefone, variaveis };
  }

  /**
   * Variações da EMPRESA dona da campanha.
   *
   * Sem o filtro, esta consulta trazia a tabela `spintax` inteira. O índice
   * único é `(empresa_id, nome)` justamente porque duas empresas podem ter uma
   * variação com o mesmo nome — `{{*saudacao*}}` é o nome que todo mundo
   * escolhe —, e `indexarVariacoes` reduz a lista a um objeto por nome, onde a
   * última carregada vence. O resultado era a campanha de um cliente sair com
   * o texto escrito por outro, entregue de verdade ao destinatário: não é
   * leitura indevida, é conteúdo alheio publicado em nome de quem não o
   * escreveu.
   *
   * `empresa_id` é NOT NULL em `campanhas` e em `spintax` desde a migration
   * `20260815000600_empresa_obrigatoria`. O `null` aqui é só o caso teórico de
   * um SELECT em runtime não carregar a coluna — e, nele, nenhuma variação é o
   * padrão seguro: o texto sai com `{{*nome*}}` literal, visível, em vez de
   * sair com a frase de outra empresa.
   */
  private async variacoes(empresaId: string | null): Promise<Spintax[]> {
    if (empresaId === null) return [];

    const { data } = await this.supabase
      .tabela("spintax")
      .select("id, nome, opcoes, criado_em")
      .eq("empresa_id", empresaId);

    return ((data ?? []) as { id: string; nome: string; opcoes: unknown; criado_em: string }[]).map(
      (l) => ({
        id: l.id,
        nome: l.nome,
        opcoes: Array.isArray(l.opcoes) ? l.opcoes.map(String) : [],
        criadoEm: l.criado_em,
      }),
    );
  }

  private async gravarMensagem(
    job: JobContato,
    canalId: string,
    passo: {
      passo: number;
      corpoRenderizado: string;
      resultado: ResultadoEnvio;
    },
  ): Promise<void> {
    const r = passo.resultado;
    await this.supabase.tabela("mensagens_enviadas").insert({
      campanha_id: job.campanhaId,
      campanha_contato_id: job.contatoId,
      canal_id: canalId,
      passo: passo.passo,
      corpo_renderizado: passo.corpoRenderizado,
      id_externo: r.ok ? r.idExterno : null,
      status: r.ok ? "enviada" : "falhou",
      erro: r.ok ? null : r.erro,
      // O código era calculado pelo provedor e descartado exatamente aqui: o
      // dado que dizia de quem era a culpa existia por uma função e sumia na
      // seguinte. A coluna nem existia na tabela.
      erro_codigo: r.ok ? null : r.codigo,
      erro_categoria: r.ok ? null : categoriaDe(r.codigo),
    });
  }

  private async encerrarContato(
    job: JobContato,
    status: "concluido" | "falhou" | "invalido",
    motivo: string | null,
    codigo?: CodigoFalha,
  ): Promise<void> {
    await this.supabase
      .tabela("campanha_contatos")
      .update({
        status,
        motivo,
        // Guardado ao lado do texto, não no lugar dele: o código agrupa e
        // filtra, o texto explica o caso específico.
        falha_codigo: codigo ?? null,
        falha_categoria: codigo ? categoriaDe(codigo) : null,
        processado_em: new Date().toISOString(),
        enviando_desde: null,
      })
      .eq("id", job.contatoId);

    // Contador desta campanha, agora que ela mudou de verdade. As demais
    // agregações ficam com a manutenção, de minuto em minuto.
    await this.supabase.db.rpc("recalcular_metricas_campanha", { p_campanha_id: job.campanhaId });
    await this.finalizarSeTerminou(job.campanhaId);
  }

  private async marcarFalha(job: JobCampanha, motivo: string): Promise<void> {
    await this.supabase.tabela("campanhas").update({ status: "falhou" }).eq("id", job.campanhaId);
    this.logger.error(`Campanha ${job.campanhaId} falhou: ${motivo}`);

    const campanha = await this.carregarCampanha(job.campanhaId);
    await this.auditoria.registrar({
      usuarioId: null,
      usuarioNome: "Sistema",
      acao: "campanha.pausada",
      tipoEntidade: "campanha",
      entidadeId: job.campanhaId,
      entidadeRotulo: campanha?.nome ?? job.campanhaId,
      // Explícito e não derivado: não há usuário para consultar em `perfis`
      // aqui, o autor é o próprio worker. Sem isto o log ficaria sem dono e
      // invisível ao admin da empresa — só a conta global o veria.
      empresaId: campanha?.empresaId ?? null,
      detalhes: { motivo },
    });
  }

  /** Fecha a campanha quando não sobra contato pendente. */
  private async finalizarSeTerminou(campanhaId: string): Promise<void> {
    const { data } = await this.supabase.db.rpc("concluir_campanha_se_terminou", {
      p_campanha_id: campanhaId,
    });
    if (data !== true) return;

    const campanha = await this.carregarCampanha(campanhaId);
    await this.auditoria.registrar({
      usuarioId: null,
      usuarioNome: "Sistema",
      acao: "campanha.concluida",
      tipoEntidade: "campanha",
      entidadeId: campanhaId,
      entidadeRotulo: campanha?.nome ?? campanhaId,
      empresaId: campanha?.empresaId ?? null,
    });
    this.logger.log(`Campanha ${campanha?.nome ?? campanhaId} concluída.`);
  }

  concorrenciaPorCanal(): number {
    return ambiente().DISPARO_CONCORRENCIA_POR_CANAL;
  }
}
