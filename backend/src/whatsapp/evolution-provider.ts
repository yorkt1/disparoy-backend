import type { Canal, TipoMidia } from "@disparoy/dominio";
import { ambiente } from "../config/ambiente";
import {
  CAPACIDADES,
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
    readonly codigo: string,
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
  if (!cfg) throw new ErroEvolution(SEM_CONFIG, "evolution_nao_configurada");

  const resposta = await fetch(`${cfg.baseUrl}/${caminho}`, {
    ...init,
    headers: { apikey: cfg.apiKey, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
  });

  const corpo = (await resposta.json().catch(() => ({}))) as RespostaEvolution;
  if (!resposta.ok) {
    throw new ErroEvolution(motivoDaFalha(corpo, resposta.status), String(resposta.status));
  }
  return corpo as T;
}

export const provedorEvolution: ProvedorComQrCode = {
  tipo: "qrcode",
  capacidades: CAPACIDADES.qrcode,

  async enviar(envio: EnvioSolicitado): Promise<ResultadoEnvio> {
    if (!evolutionConfigurada()) {
      return { ok: false, erro: SEM_CONFIG, codigo: "evolution_nao_configurada" };
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
      if (!r.key?.id) return { ok: false, erro: "A Evolution não retornou id da mensagem." };
      return { ok: true, idExterno: r.key.id };
    } catch (e) {
      const erro = e instanceof ErroEvolution ? e : null;
      return {
        ok: false,
        erro: erro?.message ?? "Falha ao falar com a Evolution API.",
        codigo: erro?.codigo,
      };
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
    if (!evolutionConfigurada()) throw new ErroEvolution(SEM_CONFIG, "evolution_nao_configurada");

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

    if (env.APP_URL_PUBLICA && env.EVOLUTION_WEBHOOK_SECRET) {
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
      }).catch(() => undefined);
    }

    const r = await chamar<{ base64?: string; code?: string; qrcode?: { base64?: string } }>(
      CAMINHOS.conectar(instancia),
    );
    const qr = r.base64 ?? r.qrcode?.base64 ?? r.code;
    // Sem QR não há o que escanear; devolver vazio renderizaria uma imagem
    // quebrada e o operador ficaria esperando por nada.
    if (!qr) throw new ErroEvolution("A Evolution não retornou o QR Code.", "sem_qr");

    return { canalId: canal.id, qr, expiraEm: new Date(Date.now() + 60_000).toISOString() };
  },

  async encerrarSessao(canal: Canal): Promise<void> {
    if (!evolutionConfigurada()) throw new ErroEvolution(SEM_CONFIG, "evolution_nao_configurada");
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
