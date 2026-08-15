import type { Canal, TipoMidia } from "@disparoy/dominio";
import { ambiente } from "../config/ambiente";
import {
  CAPACIDADES,
  classificarEvolution,
  type CodigoFalha,
  type EnvioSolicitado,
  type ProvedorComQrCode,
  type ResultadoEnvio,
  type ResultadoValidacaoNumero,
  type SessaoQrCode,
} from "@disparoy/dominio";

/**
 * Cliente da Evolution API (self-hosted, Baileys ou Cloud API).
 *
 * Sem gateway configurado nada é inventado: o envio falha e o pareamento
 * lança, ambos com mensagem explícita. Uma campanha marcada como entregue sem
 * nada ter saído seria muito pior do que uma que falha na primeira mensagem.
 */

const CAMINHOS = {
  criarInstancia: () => `instance/create`,
  buscarInstancia: (i: string) => `instance/fetchInstances?instanceName=${encodeURIComponent(i)}`,
  conectar: (i: string) => `instance/connect/${i}`,
  estado: (i: string) => `instance/connectionState/${i}`,
  desconectar: (i: string) => `instance/logout/${i}`,
  excluir: (i: string) => `instance/delete/${i}`,
  definirWebhook: (i: string) => `webhook/set/${i}`,
  enviarTexto: (i: string) => `message/sendText/${i}`,
  enviarMidia: (i: string) => `message/sendMedia/${i}`,
  verificarNumeros: (i: string) => `chat/whatsappNumbers/${i}`,
};

/**
 * `mediatype` da Evolution: o enum dela é em inglês, o domínio fala português.
 *
 * Sem a tradução, `imagem` e `documento` viram 400 ("mediatype is not one of
 * enum values") — e só na hora do disparo, com a campanha já andando. `video` e
 * `audio` coincidem nas duas línguas, o que fazia a falha parecer aleatória:
 * metade dos tipos funcionava.
 */
const MEDIATYPE: Record<TipoMidia, string> = {
  imagem: "image",
  video: "video",
  documento: "document",
  audio: "audio",
};

/** Eventos assinados na criação da instância. */
const EVENTOS = [
  "QRCODE_UPDATED",
  "CONNECTION_UPDATE",
  "SEND_MESSAGE",
  "MESSAGES_UPDATE",
  "MESSAGES_UPSERT",
];

const SEM_CONFIG =
  "Evolution API não configurada: preencha EVOLUTION_API_URL e EVOLUTION_API_KEY " +
  "em backend/.env.";

interface ConfigEvolution {
  baseUrl: string;
  apiKey: string;
}

function lerConfig(): ConfigEvolution | null {
  const env = ambiente();
  if (!env.EVOLUTION_API_URL || !env.EVOLUTION_API_KEY) return null;
  return { baseUrl: env.EVOLUTION_API_URL.replace(/\/+$/, ""), apiKey: env.EVOLUTION_API_KEY };
}

export function evolutionConfigurada(): boolean {
  return lerConfig() !== null;
}

export class ErroEvolution extends Error {
  constructor(
    message: string,
    /**
     * Código do domínio, não o status HTTP.
     *
     * Antes isto guardava `String(resposta.status)`, e um `400` da Evolution
     * podia ser número inválido, mediatype errado ou instância não pareada —
     * três causas sem nada em comum recebendo o mesmo código.
     */
    readonly codigo: CodigoFalha,
  ) {
    super(message);
    this.name = "ErroEvolution";
  }
}

/** Texto de qualquer forma que a Evolution use para relatar o motivo. */
function achatarMotivo(valor: unknown): string[] {
  if (typeof valor === "string") return valor.trim() ? [valor.trim()] : [];
  if (Array.isArray(valor)) return valor.flatMap(achatarMotivo);
  return [];
}

/**
 * Motivo legível da falha.
 *
 * O detalhe útil vem em `response.message` — às vezes string, às vezes array
 * aninhado —, enquanto o topo traz só `"Bad Request"`. Ler só o topo fazia toda
 * falha de envio virar "Bad Request" no log e na tela de campanha, escondendo
 * exatamente o que o operador precisa para corrigir.
 */
function motivoDaFalha(corpo: RespostaEvolution, status: number): string {
  const detalhe = achatarMotivo(corpo.response?.message);
  if (detalhe.length > 0) return detalhe.join("; ");

  const topo = achatarMotivo(corpo.message ?? corpo.error);
  return topo.length > 0 ? topo.join("; ") : `HTTP ${status}`;
}

interface RespostaEvolution {
  message?: unknown;
  error?: unknown;
  response?: { message?: unknown };
}

async function chamar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  const cfg = lerConfig();
  if (!cfg) throw new ErroEvolution(SEM_CONFIG, "provedor_nao_configurado");

  let resposta: Response;
  try {
    resposta = await fetch(`${cfg.baseUrl}/${caminho}`, {
      ...init,
      headers: { apikey: cfg.apiKey, "Content-Type": "application/json", ...init.headers },
      cache: "no-store",
      // Sem teto de tempo, um envio pendurado segura o job até o
      // `expireInSeconds` de 23 h da fila: a campanha para e nada indica por quê.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    /**
     * O fetch REJEITOU — não houve resposta nenhuma.
     *
     * Este ramo é o mais importante do arquivo: é ele que distingue "a VPS da
     * Evolution caiu" (culpa nossa) de "o WhatsApp do cliente caiu". Antes a
     * exceção não era `ErroEvolution`, escorregava para o catch genérico do
     * `enviar` e virava a string "Falha ao falar com a Evolution API." sem
     * código — o sinal mais valioso do sistema era o que menos carregava
     * informação.
     */
    const detalhe = e instanceof Error ? e.message : String(e);
    throw new ErroEvolution(detalhe, classificarEvolution(0, detalhe));
  }

  const corpo = (await resposta.json().catch(() => ({}))) as RespostaEvolution;
  if (!resposta.ok) {
    const motivo = motivoDaFalha(corpo, resposta.status);
    throw new ErroEvolution(motivo, classificarEvolution(resposta.status, motivo));
  }
  return corpo as T;
}

/**
 * Registra o webhook da instância. Devolve o motivo quando NÃO conseguiu.
 *
 * Antes isto era um `if` silencioso seguido de `.catch(() => undefined)`: duas
 * falhas engolidas em sequência. Se as variáveis faltassem, o bloco inteiro era
 * pulado sem aviso; se a chamada falhasse, o catch apagava. Nos dois casos o
 * canal conectava, enviava mensagens normalmente e nunca reportava status
 * nenhum — nem entrega, nem desconexão. O comentário logo acima afirmava que
 * isso não podia acontecer, e o código permitia que acontecesse.
 */
async function registrarWebhook(instancia: string): Promise<string | null> {
  const env = ambiente();

  if (!env.APP_URL_PUBLICA || !env.EVOLUTION_WEBHOOK_SECRET) {
    return (
      "APP_URL_PUBLICA ou EVOLUTION_WEBHOOK_SECRET não estão definidas: este canal " +
      "vai enviar mensagens, mas nunca vai reportar entrega nem desconexão."
    );
  }

  try {
    await chamar(CAMINHOS.definirWebhook(instancia), {
      method: "POST",
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: `${env.APP_URL_PUBLICA.replace(/\/+$/, "")}/api/webhooks/evolution`,
          headers: { "x-webhook-secret": env.EVOLUTION_WEBHOOK_SECRET },
          events: EVENTOS,
        },
      }),
    });
    return null;
  } catch (e) {
    const detalhe = e instanceof Error ? e.message : String(e);
    return `Não foi possível registrar o webhook (${detalhe}). O canal não vai reportar status.`;
  }
}

/** O que o gateway respondeu sobre a sessão. */
export type EstadoGateway = "open" | "close" | "connecting" | "indisponivel";

/**
 * Estado REAL da sessão, perguntado ao gateway.
 *
 * É a única fonte confiável sobre um canal. O `canais.status` no banco é cache
 * do webhook, e o webhook é justamente a primeira coisa que morre quando a VPS
 * cai — então o banco pode dizer "conectado" por horas enquanto o número está
 * offline, e todo erro resultante parece defeito do sistema.
 *
 * `indisponivel` NÃO é sinônimo de `close`. Um diz "não consegui perguntar"
 * (problema nosso), o outro diz "perguntei, e a sessão caiu" (WhatsApp do
 * cliente). Colapsar os dois é exatamente o erro que esta função existe para
 * corrigir: seria acusar o cliente de um problema nosso.
 */
export async function estadoDaInstancia(instancia: string): Promise<EstadoGateway> {
  if (!evolutionConfigurada()) return "indisponivel";

  try {
    const r = await chamar<{ instance?: { state?: string }; state?: string }>(
      CAMINHOS.estado(instancia),
    );
    const s = String(r.instance?.state ?? r.state ?? "").toLowerCase();
    if (s === "open") return "open";
    if (s === "connecting") return "connecting";
    if (s === "close") return "close";
    return "indisponivel";
  } catch (e) {
    // 404 é resposta, não silêncio: a instância não existe no gateway. Isso é
    // um fato sobre o canal, e vale como sessão caída.
    if (e instanceof ErroEvolution && e.codigo === "canal_sem_sessao") return "close";
    return "indisponivel";
  }
}

export const provedorEvolution: ProvedorComQrCode = {
  tipo: "qrcode",
  capacidades: CAPACIDADES.qrcode,

  async enviar(envio: EnvioSolicitado): Promise<ResultadoEnvio> {
    if (!evolutionConfigurada()) {
      return { ok: false, erro: SEM_CONFIG, codigo: "provedor_nao_configurado" };
    }

    const instancia = envio.canal.instanciaEvolution;
    const numero = envio.para.replace("+", "");

    try {
      const midia = envio.mensagem.tipo === "midia" ? envio.mensagem.midia : undefined;

      const r = midia
        ? await chamar<{ key?: { id: string } }>(CAMINHOS.enviarMidia(instancia), {
            method: "POST",
            body: JSON.stringify({
              number: numero,
              mediatype: MEDIATYPE[midia.tipo],
              media: midia.url,
              fileName: midia.nomeArquivo,
              caption: envio.corpoRenderizado,
            }),
          })
        : await chamar<{ key?: { id: string } }>(CAMINHOS.enviarTexto(instancia), {
            method: "POST",
            body: JSON.stringify({ number: numero, text: envio.corpoRenderizado }),
          });

      // Sem id externo o webhook nunca acha esta mensagem para marcar entregue.
      if (!r.key?.id) {
        return {
          ok: false,
          erro: "A Evolution não retornou id da mensagem.",
          codigo: "resposta_sem_id",
        };
      }
      return { ok: true, idExterno: r.key.id };
    } catch (e) {
      // `chamar` já classificou tudo que sabe classificar, inclusive falha de
      // rede. Só chega em `desconhecido` o que nem exceção nossa é.
      if (e instanceof ErroEvolution) return { ok: false, erro: e.message, codigo: e.codigo };
      const detalhe = e instanceof Error ? e.message : String(e);
      return { ok: false, erro: detalhe, codigo: "desconhecido" };
    }
  },

  /**
   * `verificado: false` significa "não deu para checar", diferente de "não
   * existe" — quem chama decide se envia mesmo assim. Nunca afirmamos que um
   * número existe sem a Evolution ter respondido.
   */
  async validarNumeros(canal, numeros): Promise<ResultadoValidacaoNumero[]> {
    const desconhecidos = numeros.map((numero) => ({
      numero,
      existeNoWhatsApp: false,
      verificado: false,
    }));
    if (!evolutionConfigurada()) return desconhecidos;

    try {
      const r = await chamar<{ exists: boolean; number: string }[]>(
        CAMINHOS.verificarNumeros(canal.instanciaEvolution),
        {
          method: "POST",
          body: JSON.stringify({ numbers: numeros.map((n) => n.replace("+", "")) }),
        },
      );
      const indice = new Map(r.map((item) => [item.number, item.exists]));
      return numeros.map((numero) => {
        const chave = numero.replace("+", "");
        return {
          numero,
          existeNoWhatsApp: indice.get(chave) ?? false,
          verificado: indice.has(chave),
        };
      });
    } catch {
      return desconhecidos;
    }
  },

  /**
   * Cria a instância (se ainda não existe), registra o webhook e devolve o QR.
   *
   * O webhook é registrado AQUI, no mesmo passo: instância conectada sem
   * webhook envia mensagens e nunca reporta status — a campanha ficaria presa
   * em "enviada" para sempre.
   */
  async iniciarSessao(canal: Canal): Promise<SessaoQrCode> {
    if (!evolutionConfigurada()) throw new ErroEvolution(SEM_CONFIG, "provedor_nao_configurado");

    const instancia = canal.instanciaEvolution;
    const env = ambiente();

    await chamar(CAMINHOS.criarInstancia(), {
      method: "POST",
      body: JSON.stringify({
        instanceName: instancia,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      }),
      // A instância pode já existir de uma tentativa anterior; nesse caso a
      // Evolution devolve erro e seguimos direto para o connect.
    }).catch(() => undefined);

    const aviso = await registrarWebhook(instancia);

    const r = await chamar<{ base64?: string; code?: string; qrcode?: { base64?: string } }>(
      CAMINHOS.conectar(instancia),
    );
    const qr = r.base64 ?? r.qrcode?.base64 ?? r.code;
    // Sem QR não há o que escanear; devolver vazio renderizaria uma imagem
    // quebrada e o operador ficaria esperando por nada.
    if (!qr) throw new ErroEvolution("A Evolution não retornou o QR Code.", "canal_sem_sessao");

    return {
      canalId: canal.id,
      qr,
      expiraEm: new Date(Date.now() + 60_000).toISOString(),
      ...(aviso ? { aviso } : {}),
    };
  },

  async encerrarSessao(canal: Canal): Promise<void> {
    if (!evolutionConfigurada()) throw new ErroEvolution(SEM_CONFIG, "provedor_nao_configurado");
    await chamar(CAMINHOS.desconectar(canal.instanciaEvolution), { method: "DELETE" });
  },
};

/** Remove a instância na Evolution — usado ao excluir o canal. */
export async function excluirInstancia(instancia: string): Promise<void> {
  if (!evolutionConfigurada()) return;
  await chamar(CAMINHOS.excluir(instancia), { method: "DELETE" }).catch(() => undefined);
}

/**
 * Número que de fato pareou com a instância, em E.164.
 *
 * A Evolution devolve o `ownerJid` (`5548988247011@s.whatsapp.net`) — o campo
 * `number` fica nulo quando a instância nasce só com QR Code, então é o
 * `ownerJid` que serve.
 *
 * Devolve `null` quando não dá para saber: sem provedor configurado, instância
 * ainda não pareada, ou resposta em formato inesperado. Nunca chuta um número —
 * gravar um número errado no canal seria pior que deixar em branco.
 */
export async function numeroDaInstancia(instancia: string): Promise<string | null> {
  if (!evolutionConfigurada()) return null;

  try {
    const r = await chamar<unknown>(CAMINHOS.buscarInstancia(instancia));
    const itens = Array.isArray(r) ? r : [r];
    const alvo = itens.find(
      (i): i is { ownerJid?: string } =>
        typeof i === "object" && i !== null && "ownerJid" in i,
    );

    const jid = alvo?.ownerJid;
    if (typeof jid !== "string") return null;

    const digitos = jid.split("@")[0]?.replace(/\D/g, "") ?? "";
    // Um JID de grupo ou um `status@broadcast` não viram número de canal.
    if (digitos.length < 8 || digitos.length > 15) return null;

    return `+${digitos}`;
  } catch {
    return null;
  }
}
