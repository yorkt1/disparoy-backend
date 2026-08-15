import type { Canal, MensagemSequencia, Template } from "../tipos.js";
import type { CodigoFalha } from "./falhas.js";

/**
 * Contrato único para os dois modos de envio.
 *
 * Os dois provedores têm capacidades diferentes e o resto do sistema precisa
 * saber disso ANTES de disparar — daí `capacidades` fazer parte da interface:
 *
 *  - api_oficial (Meta Cloud API): só templates aprovados fora da janela de
 *    24h, tarifa por conversa, entrega/leitura via webhook.
 *  - qrcode (gateway não oficial): texto livre, sem tarifa por mensagem,
 *    porém sujeito a bloqueio da conta pela Meta.
 */

export interface CapacidadesProvedor {
  /** Aceita texto livre ou exige template aprovado? */
  textoLivre: boolean;
  /** Há tarifa por conversa/mensagem cobrada pela Meta? */
  tarifada: boolean;
  /** Consegue checar se um número existe no WhatsApp antes do envio? */
  validaNumeros: boolean;
  /** Reporta entregue/lido via webhook? */
  relatorioEntrega: boolean;
}

export interface EnvioSolicitado {
  canal: Canal;
  para: string; // E.164
  mensagem: MensagemSequencia;
  /** Texto já com variações e variáveis resolvidas. */
  corpoRenderizado: string;
  /** Valores posicionais do template, na ordem de {{1}}, {{2}}... */
  parametrosTemplate?: string[];
}

/**
 * `idExterno` é sempre o id devolvido pelo provedor — é por ele que o webhook
 * de status encontra a mensagem depois. Não existe envio sem id real.
 */
export type ResultadoEnvio =
  | { ok: true; idExterno: string }
  /**
   * `codigo` é OBRIGATÓRIO de propósito.
   *
   * Enquanto era opcional, ele era calculado no provedor e descartado antes do
   * insert em `mensagens_enviadas` — o dado que dizia de quem era a culpa
   * existia por uma função e sumia na seguinte. Exigindo-o, o compilador aponta
   * qualquer caminho de falha que esqueça de classificar.
   */
  | { ok: false; erro: string; codigo: CodigoFalha };

export interface ResultadoValidacaoNumero {
  numero: string;
  existeNoWhatsApp: boolean;
  /** `false` quando o provedor não sabe responder (não é o mesmo que "não existe"). */
  verificado: boolean;
}

export interface SessaoQrCode {
  canalId: string;
  /** Data URL do QR ou o payload cru, conforme o gateway. */
  qr: string;
  expiraEm: string;
  /**
   * Problema que não impediu o pareamento, mas que o operador precisa saber.
   *
   * Hoje só um caso o preenche: o webhook não pôde ser registrado. É grave e
   * silencioso — a instância conecta, envia normalmente e nunca reporta nada,
   * nem entrega nem desconexão. O painel passa a mentir sobre o estado do canal
   * sem que nenhum erro apareça em lugar nenhum.
   */
  aviso?: string;
}

export interface ProvedorWhatsApp {
  readonly tipo: Canal["tipoConexao"];
  readonly capacidades: CapacidadesProvedor;
  enviar(envio: EnvioSolicitado): Promise<ResultadoEnvio>;
  validarNumeros(canal: Canal, numeros: string[]): Promise<ResultadoValidacaoNumero[]>;
}

export interface ProvedorComTemplates extends ProvedorWhatsApp {
  listarTemplates(): Promise<Template[]>;
}

export interface ProvedorComQrCode extends ProvedorWhatsApp {
  iniciarSessao(canal: Canal): Promise<SessaoQrCode>;
  encerrarSessao(canal: Canal): Promise<void>;
}

export const CAPACIDADES: Record<Canal["tipoConexao"], CapacidadesProvedor> = {
  api_oficial: { textoLivre: false, tarifada: true, validaNumeros: false, relatorioEntrega: true },
  qrcode: { textoLivre: true, tarifada: false, validaNumeros: true, relatorioEntrega: true },
};
