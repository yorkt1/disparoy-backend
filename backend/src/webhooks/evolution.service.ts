import { Injectable, Logger } from "@nestjs/common";
import { ehPedidoDeSaida, normalizarTelefone } from "@disparoy/dominio";
import { SupabaseService } from "../supabase/supabase.service";
import { numeroDaInstancia } from "../whatsapp/evolution-provider";
import { ContatosService } from "../contatos/contatos.service";

/**
 * Processamento dos eventos da Evolution API.
 *
 * O controller responde 200 imediatamente e chama isto em segundo plano: se a
 * Evolution não receber resposta rápida ela reenvia o evento, e um webhook
 * lento vira uma tempestade de duplicatas.
 */

/** Formato dos eventos que consumimos. Campos extras são ignorados. */
interface PayloadEvolution {
  event?: string;
  instance?: string;
  data?: {
    key?: { id?: string; remoteJid?: string; fromMe?: boolean };
    status?: string;
    message?: { conversation?: string; extendedTextMessage?: { text?: string } };
    state?: string;
    qrcode?: { base64?: string };
    base64?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Status da Evolution/Baileys → status do domínio. */
const MAPA_STATUS: Record<string, "enviada" | "entregue" | "lida" | "falhou"> = {
  PENDING: "enviada",
  SERVER_ACK: "enviada",
  DELIVERY_ACK: "entregue",
  READ: "lida",
  PLAYED: "lida",
  ERROR: "falhou",
};

@Injectable()
export class EvolutionService {
  private readonly logger = new Logger(EvolutionService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly contatos: ContatosService,
  ) {}

  /** Guarda o payload bruto antes de interpretar — auditoria e depuração. */
  async registrarEvento(payload: PayloadEvolution): Promise<number | null> {
    const { data, error } = await this.supabase
      .tabela("eventos_webhook")
      .insert({
        instancia: payload.instance ?? null,
        evento: payload.event ?? "desconhecido",
        payload: payload as unknown as Record<string, unknown>,
      })
      .select("id")
      .single();

    if (error) {
      this.logger.error(`Falha ao gravar evento de webhook: ${error.message}`);
      return null;
    }
    return (data as { id: number }).id;
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
    }
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
  ): Promise<{ id: string; numero: string | null } | null> {
    if (!instancia) return null;
    const { data } = await this.supabase
      .tabela("canais")
      .select("id, numero")
      .eq("instancia_evolution", instancia)
      .maybeSingle();
    return (data as { id: string; numero: string | null } | null) ?? null;
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
      .select("id, campanha_id, status")
      .eq("id_externo", idExterno)
      .maybeSingle();

    const linha = data as { id: number; campanha_id: string; status: string } | null;
    if (!linha) return;

    const ordem = ["enfileirada", "enviada", "entregue", "lida"];
    const atual = ordem.indexOf(linha.status);
    const proposto = ordem.indexOf(novo);
    if (novo !== "falhou" && proposto <= atual) return;

    const agora = new Date().toISOString();
    await this.supabase
      .tabela("mensagens_enviadas")
      .update({
        status: novo,
        entregue_em: novo === "entregue" || novo === "lida" ? agora : undefined,
        lida_em: novo === "lida" ? agora : undefined,
      })
      .eq("id", linha.id);

    await this.supabase.db.rpc("recalcular_metricas_campanha", {
      p_campanha_id: linha.campanha_id,
    });
  }

  /**
   * Mensagem recebida do contato.
   *
   * Serve a dois propósitos: contar respostas e — o que importa juridicamente —
   * detectar pedido de saída. Marcar o opt-out aqui é o que garante que a
   * próxima campanha não alcance quem pediu para sair.
   */
  private async tratarMensagemRecebida(payload: PayloadEvolution): Promise<void> {
    const chave = payload.data?.key;
    // `fromMe` é o eco da nossa própria mensagem — não é resposta de ninguém.
    if (!chave?.remoteJid || chave.fromMe) return;

    const telefone = jidParaTelefone(chave.remoteJid);
    if (!telefone) return;

    const texto =
      payload.data?.message?.conversation ??
      payload.data?.message?.extendedTextMessage?.text ??
      "";

    await this.contarResposta(telefone);

    if (ehPedidoDeSaida(texto)) {
      const registrado = await this.contatos.registrarOptOut(
        null,
        telefone,
        `Pedido recebido por WhatsApp: "${texto.slice(0, 120)}"`,
      );
      if (registrado) this.logger.log(`Opt-out registrado para ${telefone}.`);
    }
  }

  /** Credita a resposta à campanha mais recente que falou com este número. */
  private async contarResposta(telefone: string): Promise<void> {
    const { data } = await this.supabase
      .tabela("campanha_contatos")
      .select("campanha_id")
      .eq("telefone", telefone)
      .not("processado_em", "is", null)
      .order("processado_em", { ascending: false })
      .limit(1)
      .maybeSingle();

    const linha = data as { campanha_id: string } | null;
    if (!linha) return;

    const { data: atual } = await this.supabase
      .tabela("campanhas")
      .select("total_respostas")
      .eq("id", linha.campanha_id)
      .maybeSingle();

    await this.supabase
      .tabela("campanhas")
      .update({ total_respostas: ((atual as { total_respostas: number })?.total_respostas ?? 0) + 1 })
      .eq("id", linha.campanha_id);
  }
}

/** "5511987654321@s.whatsapp.net" -> "+5511987654321". Grupos são ignorados. */
function jidParaTelefone(jid: string): string | null {
  if (jid.includes("@g.us")) return null;
  const digitos = jid.split("@")[0]?.replace(/\D/g, "");
  if (!digitos) return null;
  const r = normalizarTelefone(`+${digitos}`);
  return r.valido ? r.e164 : null;
}
