
import type { CategoriaTemplate, StatusTemplate, Template } from "@disparoy/dominio";
import { ambiente } from "../config/ambiente";
import {
  CAPACIDADES,
  classificarMeta,
  type CodigoFalha,
  type EnvioSolicitado,
  type ProvedorComTemplates,
  type ResultadoEnvio,
  type ResultadoValidacaoNumero,
} from "@disparoy/dominio";

/**
 * Cliente da WhatsApp Business Cloud API (Meta).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Sem credenciais o provedor FALHA com mensagem explícita, em vez de fingir
 * que enviou: uma campanha marcada como entregue sem nada ter saído é pior do
 * que uma que falha na primeira mensagem.
 */

interface ConfigMeta {
  token: string;
  contaId: string;
  versao: string;
}

function lerConfig(): ConfigMeta | null {
  const env = ambiente();
  if (!env.META_WHATSAPP_TOKEN || !env.META_WHATSAPP_BUSINESS_ACCOUNT_ID) return null;
  return {
    token: env.META_WHATSAPP_TOKEN,
    contaId: env.META_WHATSAPP_BUSINESS_ACCOUNT_ID,
    versao: env.META_GRAPH_API_VERSION,
  };
}

export function metaConfigurada(): boolean {
  return lerConfig() !== null;
}

async function chamarGraph<T>(
  cfg: ConfigMeta,
  caminho: string,
  init: RequestInit = {},
): Promise<T> {
  let resposta: Response;
  try {
    resposta = await fetch(`https://graph.facebook.com/${cfg.versao}/${caminho}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      cache: "no-store",
      // Sem teto, um envio pendurado seguraria o job até o `expireInSeconds` de
      // 23 h — a campanha inteira para sem ninguém saber por quê.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // Status 0: não houve resposta nenhuma. É o que distingue "a Graph API está
    // fora do ar" de "a Meta recusou a mensagem", e antes as duas coisas
    // viravam a mesma string sem código.
    const detalhe = e instanceof Error ? e.message : String(e);
    throw new ErroMeta(detalhe, classificarMeta(0, detalhe));
  }

  const corpo = (await resposta.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
  };

  if (!resposta.ok) {
    const detalhe = corpo.error?.message ?? `HTTP ${resposta.status}`;
    throw new ErroMeta(detalhe, classificarMeta(resposta.status, detalhe));
  }
  return corpo as T;
}

export class ErroMeta extends Error {
  constructor(
    message: string,
    /** Código do domínio, não o da Meta: é ele que a tela e o worker leem. */
    readonly codigo: CodigoFalha,
  ) {
    super(message);
    this.name = "ErroMeta";
  }
}

/** Mapeia a categoria da Meta (MARKETING, UTILITY...) para o domínio local. */
function mapearCategoria(bruta: string): CategoriaTemplate {
  switch (bruta?.toUpperCase()) {
    case "UTILITY":
      return "utilidade";
    case "AUTHENTICATION":
      return "autenticacao";
    default:
      return "marketing";
  }
}

function mapearStatus(bruto: string): StatusTemplate {
  switch (bruto?.toUpperCase()) {
    case "APPROVED":
      return "aprovado";
    case "REJECTED":
      return "rejeitado";
    case "PAUSED":
    case "DISABLED":
      return "pausado";
    default:
      return "pendente";
  }
}

interface TemplateMeta {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components?: { type: string; text?: string }[];
}

export const provedorMetaCloud: ProvedorComTemplates = {
  tipo: "api_oficial",
  capacidades: CAPACIDADES.api_oficial,

  async enviar(envio: EnvioSolicitado): Promise<ResultadoEnvio> {
    const cfg = lerConfig();
    if (!cfg) {
      return {
        ok: false,
        erro:
          "Credenciais da Meta ausentes: preencha META_WHATSAPP_TOKEN e " +
          "META_WHATSAPP_BUSINESS_ACCOUNT_ID em backend/.env.",
        codigo: "provedor_nao_configurado",
      };
    }
    if (!envio.canal.metaPhoneNumberId) {
      return {
        ok: false,
        erro: "Canal sem phone_number_id da Meta.",
        codigo: "canal_mal_configurado",
      };
    }
    // A API oficial não aceita texto livre para iniciar conversa: o passo
    // precisa apontar para um template aprovado.
    if (!envio.mensagem.templateId) {
      return {
        ok: false,
        erro: "A API oficial exige um template aprovado neste passo da sequência.",
        codigo: "template_obrigatorio",
      };
    }

    const parametros = (envio.parametrosTemplate ?? []).map((texto) => ({
      type: "text" as const,
      text: texto,
    }));

    try {
      const r = await chamarGraph<{ messages?: { id: string }[] }>(
        cfg,
        `${envio.canal.metaPhoneNumberId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: envio.para.replace("+", ""),
            type: "template",
            template: {
              name: envio.mensagem.templateId,
              language: { code: "pt_BR" },
              components: parametros.length
                ? [{ type: "body", parameters: parametros }]
                : undefined,
            },
          }),
        },
      );
      const id = r.messages?.[0]?.id;
      return id
        ? { ok: true, idExterno: id }
        : { ok: false, erro: "A Meta não retornou id da mensagem.", codigo: "resposta_sem_id" };
    } catch (e) {
      if (e instanceof ErroMeta) return { ok: false, erro: e.message, codigo: e.codigo };
      const detalhe = e instanceof Error ? e.message : String(e);
      return { ok: false, erro: detalhe, codigo: "desconhecido" };
    }
  },

  /**
   * A Cloud API não expõe checagem de existência de número. Devolvemos
   * `verificado: false` em vez de mentir um `true` — quem chama decide.
   */
  async validarNumeros(_canal, numeros): Promise<ResultadoValidacaoNumero[]> {
    return numeros.map((numero) => ({ numero, existeNoWhatsApp: true, verificado: false }));
  },

  async listarTemplates(): Promise<Template[]> {
    const cfg = lerConfig();
    if (!cfg) {
      throw new ErroMeta(
        "Credenciais da Meta ausentes: preencha META_WHATSAPP_TOKEN e " +
          "META_WHATSAPP_BUSINESS_ACCOUNT_ID em backend/.env para sincronizar.",
        "provedor_nao_configurado",
      );
    }

    const r = await chamarGraph<{ data?: TemplateMeta[] }>(
      cfg,
      `${cfg.contaId}/message_templates?limit=200&fields=id,name,language,category,status,components`,
    );

    return (r.data ?? []).map((t) => {
      const corpo = t.components?.find((c) => c.type?.toUpperCase() === "BODY")?.text ?? "";
      return {
        id: "",
        nome: t.name,
        categoria: mapearCategoria(t.category),
        status: mapearStatus(t.status),
        idioma: t.language,
        corpo,
        variaveis: new Set([...corpo.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size,
        atualizadoEm: new Date().toISOString(),
        metaTemplateId: t.id,
      } satisfies Template;
    });
  },
};
