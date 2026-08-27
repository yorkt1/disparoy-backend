import { Injectable, Logger } from "@nestjs/common";
import { ehPedidoDeSaida, explicar, normalizarTelefone } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { ObservabilidadeService } from "../observabilidade/observabilidade.service";
import { numeroDaInstancia } from "../whatsapp/evolution-provider";
import { ContatosService } from "../contatos/contatos.service";
// O tipo mora com o relatório porque é lá que ele vira coluna. Uma união
// copiada nos dois lados diverge, e a que divergir grava um `tipo` que o
// `check` da tabela recusa — em produção, dentro de um webhook.
import type { TipoResposta } from "../campanhas/relatorio";

/**
 * Processamento dos eventos da Evolution API.
 *
 * O controller responde 200 imediatamente e chama isto em segundo plano: se a
 * Evolution não receber resposta rápida ela reenvia o evento, e um webhook
 * lento vira uma tempestade de duplicatas.
 */

/**
 * Corpo de uma mensagem recebida. Só os campos de texto são nomeados; os de
 * mídia entram pelo índice.
 *
 * O WhatsApp tem dezenas de tipos de mensagem e a lista cresce sozinha —
 * declarar todos aqui seria manter um espelho de um protocolo de terceiro que
 * ninguém vai atualizar. `conteudoDaMensagem` sabe os que interessam.
 */
interface MensagemEvolution {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  [k: string]: unknown;
}

/** Formato dos eventos que consumimos. Campos extras são ignorados. */
interface PayloadEvolution {
  event?: string;
  instance?: string;
  data?: {
    key?: { id?: string; remoteJid?: string; fromMe?: boolean };
    status?: string;
    message?: MensagemEvolution;
    messageTimestamp?: number | string;
    state?: string;
    qrcode?: { base64?: string };
    base64?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export type StatusMensagem = "enfileirada" | "enviada" | "entregue" | "lida" | "falhou";

/** Status da Evolution/Baileys → status do domínio. */
export const MAPA_STATUS: Record<string, Exclude<StatusMensagem, "enfileirada">> = {
  PENDING: "enviada",
  SERVER_ACK: "enviada",
  DELIVERY_ACK: "entregue",
  READ: "lida",
  PLAYED: "lida",
  ERROR: "falhou",
};

/** Progressão natural de uma mensagem. `falhou` está fora: não é um estágio. */
const PROGRESSAO: readonly StatusMensagem[] = ["enfileirada", "enviada", "entregue", "lida"];

/**
 * O status novo representa avanço em relação ao atual?
 *
 * A ordem de chegada dos webhooks não é garantida: a Evolution manda
 * `DELIVERY_ACK` depois de `READ` com alguma frequência, e aplicar o mais
 * recente que chegou faria uma mensagem lida voltar a "entregue" no relatório —
 * o número de leituras cairia sozinho enquanto o operador olha a tela.
 *
 * `falhou` sempre passa: é estado terminal vindo do gateway, não um degrau.
 */
export function avancaStatus(atual: string, novo: StatusMensagem): boolean {
  if (novo === "falhou") return true;
  return PROGRESSAO.indexOf(novo) > PROGRESSAO.indexOf(atual as StatusMensagem);
}

/** O que `registrarEvento` descobriu sobre este payload. */
export interface EventoRegistrado {
  /** Linha em `eventos_webhook`, ou `null` se não foi possível gravar. */
  id: number | null;
  /** Reentrega de algo que já foi processado com sucesso: não processar de novo. */
  duplicado: boolean;
}

@Injectable()
export class EvolutionService {
  private readonly logger = new Logger(EvolutionService.name);

  /** Último alerta externo, para não inundar o webhook de alerta numa pane. */
  private alertadoEm = 0;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly contatos: ContatosService,
    private readonly observabilidade: ObservabilidadeService,
  ) {}

  /**
   * Guarda o payload bruto antes de interpretar — auditoria e depuração — e
   * decide se este evento já foi processado antes.
   *
   * A deduplicação é o próprio índice único: conferir antes com um SELECT
   * deixaria a janela entre a consulta e o insert aberta, e duas réplicas
   * recebendo a mesma reentrega ao mesmo tempo é exatamente o caso que precisa
   * ser coberto.
   */
  async registrarEvento(payload: PayloadEvolution): Promise<EventoRegistrado> {
    const chave = chaveDoEvento(payload);

    const { data, error } = await this.supabase
      .tabela("eventos_webhook")
      .insert({
        instancia: payload.instance ?? null,
        evento: payload.event ?? "desconhecido",
        payload: payload as unknown as Record<string, unknown>,
        chave_evento: chave,
      })
      .select("id")
      .single();

    // 23505: o índice único de `chave_evento` barrou — este evento já chegou.
    if (error?.code === "23505" && chave) return this.reentrega(chave);

    if (error) {
      this.logger.error(`Falha ao gravar evento de webhook: ${error.message}`);
      return { id: null, duplicado: false };
    }
    return { id: (data as { id: number }).id, duplicado: false };
  }

  /**
   * O evento já existe. Processar de novo ou não depende de como o primeiro
   * terminou.
   *
   * Processado com sucesso: é reentrega pura, e repetir contaria a mesma
   * resposta do contato duas vezes. Ainda não processado: o processamento
   * anterior morreu no meio (réplica reiniciada no deploy, exceção), e esta
   * reentrega é a segunda chance dele — descartá-la perderia o evento em
   * silêncio, que é o defeito pior dos dois.
   */
  private async reentrega(chave: string): Promise<EventoRegistrado> {
    const { data } = await this.supabase
      .tabela("eventos_webhook")
      .select("id, processado")
      .eq("chave_evento", chave)
      .maybeSingle();

    const linha = data as { id: number; processado: boolean } | null;
    return { id: linha?.id ?? null, duplicado: linha?.processado === true };
  }

  async processar(payload: PayloadEvolution, eventoId: number | null): Promise<void> {
    try {
      switch (payload.event) {
        case "CONNECTION_UPDATE":
          await this.atualizarConexao(payload);
          break;
        case "SEND_MESSAGE":
        case "MESSAGES_UPDATE":
          await this.atualizarStatusMensagem(payload);
          break;
        case "MESSAGES_UPSERT":
          await this.tratarMensagemRecebida(payload);
          break;
        default:
          // QRCODE_UPDATED e outros são guardados, mas não mudam estado aqui:
          // o QR é buscado sob demanda pela tela de conexão.
          break;
      }
      await this.marcarProcessado(eventoId, null);
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      this.logger.error(`Falha ao processar ${payload.event}: ${motivo}`);
      await this.marcarProcessado(eventoId, motivo);
      this.alertar(payload, e);
    }
  }

  /**
   * Falha de webhook precisa sair do processo.
   *
   * O controller responde 200 antes de processar, então o erro não volta para
   * a Evolution nem para tela nenhuma: ele ficava no `eventos_webhook.erro` e
   * no stdout do Render, que é o mesmo que dizer "ninguém fica sabendo". E o
   * que se perde aqui é caro — status de entrega sumindo do relatório e, no
   * `MESSAGES_UPSERT`, o pedido de saída de alguém que a próxima campanha vai
   * alcançar de novo.
   *
   * Um alerta por minuto no máximo: quando o banco cai, TODO evento falha, e
   * mandar um POST por evento transformaria a pane numa segunda pane no destino
   * do alerta. O primeiro já diz o que precisa ser dito.
   */
  private alertar(payload: PayloadEvolution, erro: unknown): void {
    const agora = Date.now();
    if (agora - this.alertadoEm < 60_000) return;
    this.alertadoEm = agora;

    this.observabilidade.relatarErro("Webhook da Evolution — evento não processado", erro, {
      evento: payload.event ?? "desconhecido",
      instancia: payload.instance ?? "?",
    });
  }

  // ------------------------------------------------------------------------

  private async marcarProcessado(id: number | null, erro: string | null): Promise<void> {
    if (id === null) return;
    await this.supabase
      .tabela("eventos_webhook")
      .update({ processado: erro === null, erro })
      .eq("id", id);
  }

  private async canalDaInstancia(
    instancia?: string,
  ): Promise<{ id: string; numero: string | null; empresa_id: string | null } | null> {
    if (!instancia) return null;
    const { data } = await this.supabase
      .tabela("canais")
      // `empresa_id` entra aqui porque a instância é a ÚNICA pista de dono que
      // um evento de webhook carrega: o payload da Evolution não sabe o que é
      // uma empresa. Quem precisa dele é `contarResposta`.
      .select("id, numero, empresa_id")
      .eq("instancia_evolution", instancia)
      .maybeSingle();
    return (data as { id: string; numero: string | null; empresa_id: string | null } | null) ?? null;
  }

  private async atualizarConexao(payload: PayloadEvolution): Promise<void> {
    const instancia = payload.instance;
    const canal = instancia ? await this.canalDaInstancia(instancia) : null;
    if (!canal || !instancia) return;

    const estado = String(payload.data?.state ?? "").toLowerCase();
    const status =
      estado === "open" ? "conectado" : estado === "close" ? "desconectado" : "aguardando_qr";

    const atualizacao: Record<string, unknown> = {
      status,
      conectado_em: status === "conectado" ? new Date().toISOString() : undefined,
    };

    // O canal nasce sem número: ninguém o digita, porque quem o define é o
    // aparelho que escaneia o QR. Este é o momento em que ele passa a existir.
    if (status === "conectado" && !canal.numero) {
      const numero = await numeroDaInstancia(instancia);
      if (numero) atualizacao.numero = numero;
      else this.logger.warn(`Canal ${instancia} conectou, mas a Evolution não deu o número.`);
    }

    const { error } = await this.supabase.tabela("canais").update(atualizacao).eq("id", canal.id);

    // 23505: outro canal já usa esse número. O pareamento é real, então o
    // status vale; só o número não pode ser gravado em dois canais.
    if (error?.code === "23505") {
      delete atualizacao.numero;
      await this.supabase.tabela("canais").update(atualizacao).eq("id", canal.id);
      this.logger.warn(
        `Canal ${instancia} pareou com um número já usado por outro canal.`,
      );
    } else if (error) {
      throw new Error(`Falha ao atualizar o canal: ${error.message}`);
    }

    this.logger.log(
      `Canal ${instancia}: ${status}${atualizacao.numero ? ` (${String(atualizacao.numero)})` : ""}`,
    );

    await this.reagirAConexao(canal.id, instancia, status);
  }

  /**
   * Reação imediata à mudança de conexão.
   *
   * O watchdog do worker já detectaria isso em até um minuto, mas um minuto é
   * tempo demais quando o disparo tem janela de dez: a campanha continuaria
   * tentando enviar por um número que acabou de cair. Aqui a reação é na hora,
   * e o watchdog vira a rede de segurança para quando o webhook não chegar.
   *
   * Nunca lança: isto roda no caminho do webhook, que precisa responder rápido
   * e cujo payload já foi gravado. Falhar aqui não pode custar o evento.
   */
  private async reagirAConexao(
    canalId: string,
    instancia: string,
    status: string,
  ): Promise<void> {
    try {
      if (status === "conectado") {
        await this.supabase.db.rpc("resolver_incidentes_do_canal", { p_canal_id: canalId });
        // A retomada em si fica com o watchdog do worker: só ele tem a fila em
        // mãos para reenfileirar o planejamento, e a API não deve depender dela.
        return;
      }

      if (status !== "desconectado") return;

      await this.supabase.db.rpc("abrir_incidente", {
        p_categoria: "canal",
        p_codigo: "canal_desconectado",
        p_titulo: explicar("canal_desconectado", { canal: instancia }),
        p_canal_id: canalId,
        p_campanha_id: null,
        p_detalhe: "CONNECTION_UPDATE reportou sessão fechada",
      });

      // Pausa toda campanha ativa que usa este canal. Sem isto, os jobs já
      // enfileirados continuariam acordando e queimando contatos até alguém
      // perceber.
      const { data } = await this.supabase
        .tabela("campanha_canais")
        .select("campanha_id, campanhas(status)")
        .eq("canal_id", canalId);

      const alvos = ((data ?? []) as unknown as {
        campanha_id: string;
        campanhas: { status: string } | null;
      }[]).filter((l) => l.campanhas?.status === "em_andamento");

      for (const alvo of alvos) {
        await this.supabase.db.rpc("pausar_campanha_por_canal", {
          p_campanha_id: alvo.campanha_id,
          p_canal_id: canalId,
          p_motivo: explicar("canal_desconectado", { canal: instancia }),
        });
      }

      if (alvos.length > 0) {
        this.logger.warn(
          `Canal ${instancia} caiu; ${alvos.length} campanha(s) pausadas imediatamente.`,
        );
      }
    } catch (e) {
      this.logger.error(`Falha ao reagir à conexão de ${instancia}: ${String(e)}`);
    }
  }

  /**
   * Atualiza entregue/lida a partir do id externo da mensagem.
   *
   * Nunca regride o status: a Evolution pode reenviar um `DELIVERY_ACK` depois
   * de um `READ` (ordem de webhook não é garantida), e isso faria uma mensagem
   * lida voltar a "entregue" no relatório.
   */
  private async atualizarStatusMensagem(payload: PayloadEvolution): Promise<void> {
    const idExterno = payload.data?.key?.id;
    const bruto = String(payload.data?.status ?? "").toUpperCase();
    const novo = MAPA_STATUS[bruto];
    if (!idExterno || !novo) return;

    const { data } = await this.supabase
      .tabela("mensagens_enviadas")
      .select("id, campanha_id, campanha_contato_id, status")
      .eq("id_externo", idExterno)
      .maybeSingle();

    const linha = data as {
      id: number;
      campanha_id: string;
      campanha_contato_id: number;
      status: string;
    } | null;
    if (!linha) return;

    if (!avancaStatus(linha.status, novo)) return;

    const agora = new Date().toISOString();
    await this.supabase
      .tabela("mensagens_enviadas")
      .update({
        status: novo,
        entregue_em: novo === "entregue" || novo === "lida" ? agora : undefined,
        lida_em: novo === "lida" ? agora : undefined,
      })
      .eq("id", linha.id);

    if (novo === "lida") await this.marcarContatoLido(linha.campanha_contato_id, agora);

    /**
     * Os contadores da campanha NÃO são recalculados aqui.
     *
     * Recalcular por evento significava um `count(*)` sobre todas as mensagens
     * da campanha a cada ACK — três ou quatro por mensagem enviada. Numa
     * campanha de 5 mil contatos são ~20 mil varreduras completas e ~20 mil
     * UPDATEs na mesma linha de `campanhas`, todos disputando o mesmo lock, e
     * tudo isso dentro do caminho de um webhook que precisa responder rápido.
     *
     * Quem agrega agora é a manutenção do worker, uma vez por minuto e para
     * todas as campanhas ativas de uma vez. O painel atrasa até 60 s; o banco
     * deixa de ser o gargalo do disparo.
     */
  }

  /**
   * Carimba no CONTATO a primeira leitura confirmada.
   *
   * A informação já está em `mensagens_enviadas`, mas ali ela custa um
   * agrupamento por contato toda vez que a tela abre. Aqui ela fica ao lado da
   * linha que a tela lê, e é o que faz a coluna gerada `situacao` sair de
   * "enviado" para "lido".
   *
   * `is null` na condição: guarda a PRIMEIRA leitura. Sem isso, cada passo
   * lido da sequência empurraria a data para frente, e o contato que leu a
   * mensagem 1 às 9h apareceria como lido às 9h05 porque leu a 3 também.
   */
  private async marcarContatoLido(contatoId: number, quando: string): Promise<void> {
    const { error } = await this.supabase
      .tabela("campanha_contatos")
      .update({ lida_em: quando })
      .eq("id", contatoId)
      .is("lida_em", null);

    if (error) this.logger.warn(`Não foi possível marcar leitura do contato: ${error.message}`);
  }

  /**
   * Mensagem recebida do contato.
   *
   * Serve a três propósitos: guardar a resposta para o relatório, contar
   * respostas e — o que importa juridicamente — detectar pedido de saída.
   * Marcar o opt-out aqui é o que garante que a próxima campanha não alcance
   * quem pediu para sair.
   *
   * O que este método NÃO faz é confirmar leitura. Receber o evento é passivo:
   * o read receipt só sai da Evolution por `chat/markMessageAsRead` ou pelo
   * `readMessages` das settings da instância, e nenhum dos dois é acionado em
   * lugar nenhum do sistema. É o que mantém a notificação viva no celular do
   * cliente enquanto o operador lê a mesma resposta pelo painel — se um dia
   * alguém ligar qualquer um dos dois, some.
   */
  private async tratarMensagemRecebida(payload: PayloadEvolution): Promise<void> {
    const chave = payload.data?.key;
    // `fromMe` é o eco da nossa própria mensagem — não é resposta de ninguém.
    if (!chave?.remoteJid || chave.fromMe) return;

    const telefone = jidParaTelefone(chave.remoteJid);
    if (!telefone) return;

    const conteudo = conteudoDaMensagem(payload.data?.message);
    // Evento de protocolo (mensagem apagada, chave de sessão): chega pelo
    // MESSAGES_UPSERT como qualquer outra, e não é resposta de ninguém.
    // Contá-la inflava a taxa de resposta da campanha com o WhatsApp
    // conversando consigo mesmo.
    if (!conteudo) return;
    const { texto, tipo } = conteudo;

    // A empresa vem da instância que RECEBEU a mensagem. Sem ela, a resposta
    // era creditada à campanha mais recente que falou com aquele número em
    // qualquer empresa — ver a migration `20260818000100`.
    const canal = await this.canalDaInstancia(payload.instance);
    await this.contarResposta(telefone, canal?.empresa_id ?? null, {
      texto,
      tipo,
      idExterno: chave.id ?? null,
      recebidaEm: horaDoEvento(payload.data?.messageTimestamp),
    });

    if (ehPedidoDeSaida(texto)) {
      const registrado = await this.contatos.registrarOptOut(
        null,
        telefone,
        `Pedido recebido por WhatsApp: "${texto.slice(0, 120)}"`,
      );
      if (registrado) this.logger.log(`Opt-out registrado para ${telefone}.`);
    }
  }

  /**
   * Credita a resposta à campanha mais recente que falou com este número
   * DENTRO da empresa dona do canal que recebeu a mensagem.
   *
   * A empresa passou a viajar até a RPC porque o mesmo telefone pode estar em
   * campanha de mais de uma — lista comprada, revenda, cliente em comum. Sem
   * ela, a resposta que chegou pelo canal de um cliente subia a taxa de
   * resposta exibida no painel de outro.
   *
   * Uma RPC e não SELECT + UPDATE: ler o total e gravar `lido + 1` perde
   * contagem quando duas pessoas respondem ao mesmo tempo — as duas leem o
   * mesmo valor, as duas gravam o mesmo número, e uma resposta some do
   * relatório. Numa campanha de disparo, respostas simultâneas é o caso comum,
   * não o raro. Dentro da função o incremento é relativo à coluna, então o
   * Postgres serializa e nada se perde.
   */
  private async contarResposta(
    telefone: string,
    empresaId: string | null,
    conteudo: { texto: string; tipo: TipoResposta; idExterno: string | null; recebidaEm: string },
  ): Promise<void> {
    const { error } = await this.supabase.db.rpc("registrar_resposta", {
      p_telefone: telefone,
      p_empresa_id: empresaId,
      p_texto: conteudo.texto,
      p_tipo: conteudo.tipo,
      p_id_externo: conteudo.idExterno,
      p_recebida_em: conteudo.recebidaEm,
    });
    if (error) this.logger.warn(`Não foi possível registrar a resposta: ${error.message}`);
  }
}

/**
 * O que o contato respondeu, na forma que o relatório precisa.
 *
 * Antes só `conversation` e `extendedTextMessage` eram lidos, e tudo o mais
 * virava string vazia — áudio e figurinha, que são metade das respostas de uma
 * campanha em massa, apareciam como se ninguém tivesse respondido. Agora a
 * mídia vira `tipo`, e o relatório mostra "[áudio]" em vez de célula em branco.
 *
 * A legenda da mídia entra como texto porque é texto que a pessoa escreveu:
 * quem manda foto com "pode me ligar" embaixo respondeu "pode me ligar".
 */
export function conteudoDaMensagem(
  mensagem: MensagemEvolution | undefined,
): { texto: string; tipo: TipoResposta } | null {
  const m = (mensagem ?? {}) as Record<string, { caption?: string; text?: string } | undefined>;

  const texto = (mensagem?.conversation ?? mensagem?.extendedTextMessage?.text ?? "").trim();
  if (texto) return { texto, tipo: "texto" };

  // Reação: o emoji É a resposta, e é o que a planilha deve mostrar. Cair no
  // "[mensagem]" genérico apagaria a única informação que ela carrega — e num
  // disparo o 🙏 de volta é resposta tanto quanto "obrigado".
  const reacao = m.reactionMessage?.text?.trim();
  if (reacao) return { texto: reacao, tipo: "texto" };

  const midias: [string, TipoResposta][] = [
    ["imageMessage", "imagem"],
    ["audioMessage", "audio"],
    ["pttMessage", "audio"],
    ["videoMessage", "video"],
    ["documentMessage", "documento"],
    ["stickerMessage", "figurinha"],
  ];

  for (const [campo, tipo] of midias) {
    const conteudo = m[campo];
    if (conteudo) return { texto: (conteudo.caption ?? "").trim(), tipo };
  }

  // O que o WhatsApp manda sozinho, sem ninguém ter digitado nada: apagar uma
  // mensagem, rodar chave de sessão, anexar contexto. Chega como MESSAGES_UPSERT
  // igual a uma resposta de verdade, e é isso que faz `null` importar aqui.
  const PROTOCOLO = [
    "protocolMessage",
    "senderKeyDistributionMessage",
    "messageContextInfo",
    "reactionMessage",
  ];
  const proprias = Object.keys(m).filter((k) => !PROTOCOLO.includes(k));
  if (proprias.length === 0) return null;

  // Localização, contato, enquete: existe resposta, e o relatório precisa
  // dizer isso. "" com tipo "texto" seria indistinguível de silêncio.
  return { texto: "", tipo: "outro" };
}

/**
 * Quando a mensagem chegou, segundo o WhatsApp — não segundo o nosso relógio.
 *
 * `messageTimestamp` vem em segundos. Importa quando o webhook atrasa (fila da
 * Evolution acumulada, réplica reiniciando): usar `now()` nesse caso embaralha
 * a ORDEM das respostas, e a ordem é o que decide qual vai em `resposta_1`.
 * Sem o campo, `now()` é a única resposta possível e é melhor que nada.
 */
export function horaDoEvento(bruto: unknown): string {
  const segundos = typeof bruto === "string" ? Number(bruto) : bruto;
  if (typeof segundos !== "number" || !Number.isFinite(segundos) || segundos <= 0) {
    return new Date().toISOString();
  }
  return new Date(segundos * 1000).toISOString();
}

/**
 * Identidade do evento, para reconhecer a reentrega do mesmo fato.
 *
 * O status entra na chave porque a Evolution manda `MESSAGES_UPDATE` várias
 * vezes para a MESMA mensagem, uma por degrau (`SERVER_ACK`, `DELIVERY_ACK`,
 * `READ`). Sem ele, a chave seria a mesma nos três e o sistema descartaria a
 * confirmação de leitura achando que era repetição — trocaria um contador
 * inflado por um relatório que nunca sai de "entregue".
 *
 * `null` quando não há id de mensagem (`CONNECTION_UPDATE`, `QRCODE_UPDATED`):
 * sem identidade estável não há como distinguir reentrega de fato novo, e
 * inventar uma chave a partir do payload inteiro descartaria duas desconexões
 * reais seguidas.
 */
function chaveDoEvento(payload: PayloadEvolution): string | null {
  const idMensagem = payload.data?.key?.id;
  if (!idMensagem) return null;

  const status = String(payload.data?.status ?? "");
  return `${payload.instance ?? ""}|${payload.event ?? ""}|${idMensagem}|${status}`;
}

/** "5511987654321@s.whatsapp.net" -> "+5511987654321". Grupos são ignorados. */
function jidParaTelefone(jid: string): string | null {
  if (jid.includes("@g.us")) return null;
  const digitos = jid.split("@")[0]?.replace(/\D/g, "");
  if (!digitos) return null;
  const r = normalizarTelefone(`+${digitos}`);
  return r.valido ? r.e164 : null;
}
