import type { Canal, EstadoGateway, MensagemSequencia, StatusCanal, Template } from "../tipos.js";
import type { CodigoFalha } from "./falhas.js";

/**
 * O que o estado do gateway significa para o `status` do canal.
 *
 * Devolve `null` quando o gateway não respondeu — e `null` aqui quer dizer
 * "não mexa em nada", nunca "desconectado". É a regra mais importante desta
 * camada: rebaixar um canal porque a NOSSA infraestrutura não respondeu é
 * acusar o cliente de um problema nosso, e manda o operador correr atrás de um
 * QR Code que está funcionando.
 *
 * Existe como função no domínio porque tanto a vigilância do worker quanto a
 * verificação sob demanda da API decidem isso — e duas cópias divergiriam.
 */
export function statusDoGateway(estado: EstadoGateway): StatusCanal | null {
  if (estado === "indisponivel") return null;
  return estado === "open" ? "conectado" : "desconectado";
}

/**
 * Quanto tempo uma confirmação continua valendo.
 *
 * A vigilância roda de minuto em minuto; 5 minutos aceitam alguns ciclos
 * perdidos sem transformar o selo em alarme. Passado isso, o painel deixa de
 * afirmar e passa a dizer há quanto tempo não confere.
 */
export const VALIDADE_VERIFICACAO_MS = 5 * 60_000;

export type ConfiancaCanal = "confirmado" | "nao_confirmado" | "contraditorio";

export interface ApresentacaoCanal {
  /** O status que a tela deve mostrar — nem sempre o que está gravado. */
  status: StatusCanal;
  confianca: ConfiancaCanal;
  /** Frase curta explicando a confiança. Vazia quando está confirmado. */
  detalhe: string;
}

/**
 * O que a tela pode HONESTAMENTE afirmar sobre um canal.
 *
 * `canais.status` é cache do webhook, e o webhook é a primeira coisa que morre
 * quando algo dá errado. Mostrá-lo como fato foi o que produziu um canal
 * "Conectado" que nunca pareou — a tela afirmando o que o próprio dado negava.
 *
 * Duas correções, nesta ordem:
 *
 *  - **Contradição vence o cache.** `conectado` sem número é impossível: o
 *    número vem do `ownerJid` no pareamento. Se não há número, não houve
 *    pareamento, e o que a tela deve dizer é isso.
 *  - **Afirmar exige ter conferido.** Sem verificação recente contra o gateway,
 *    o selo mostra a idade da última conferência em vez de um verde que não se
 *    sustenta.
 */
export function apresentarCanal(canal: Canal, agora: number = Date.now()): ApresentacaoCanal {
  if (canal.status === "conectado" && canal.numero === null) {
    return {
      status: "aguardando_qr",
      confianca: "contraditorio",
      detalhe: "marcado como conectado, mas o pareamento nunca foi concluído",
    };
  }

  if (canal.estadoVerificadoEm === null) {
    return { status: canal.status, confianca: "nao_confirmado", detalhe: "nunca verificado" };
  }

  const idade = agora - new Date(canal.estadoVerificadoEm).getTime();
  if (idade > VALIDADE_VERIFICACAO_MS) {
    return {
      status: canal.status,
      confianca: "nao_confirmado",
      detalhe: `verificado ${descreverIdade(idade)}`,
    };
  }

  return { status: canal.status, confianca: "confirmado", detalhe: "" };
}

/** "há 3 min", "há 2 h", "há 4 dias" — sempre a maior unidade que couber. */
function descreverIdade(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `há ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  return `há ${dias} ${dias === 1 ? "dia" : "dias"}`;
}

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

/**
 * Como o número vai parear com a instância.
 *
 * `codigo` existe porque nem sempre há duas telas à mão: parear por QR exige um
 * segundo aparelho mostrando o código para o celular ler. Com o código de oito
 * dígitos a pessoa digita direto no próprio WhatsApp, o que resolve o caso de
 * quem está com o celular na mão e o painel no mesmo aparelho — e o de quem
 * opera o número remotamente e só consegue receber um texto.
 */
export type MetodoPareamento = "qrcode" | "codigo";

export interface SessaoPareamento {
  canalId: string;
  metodo: MetodoPareamento;
  /** Data URL do QR ou o payload cru. Nulo quando o pareamento é por código. */
  qr: string | null;
  /**
   * Código de 8 dígitos que a pessoa digita no WhatsApp.
   *
   * Nulo quando o pareamento é por QR. Nunca os dois preenchidos: a Evolution
   * abre UMA sessão de pareamento por vez, e mostrar as duas formas faria a
   * segunda invalidar a primeira em silêncio.
   */
  codigo: string | null;
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
  /**
   * `numero` só é usado no método `codigo`, e é o número QUE VAI PAREAR — o
   * celular onde o WhatsApp está logado, não o destino de nenhuma mensagem.
   */
  iniciarSessao(
    canal: Canal,
    opcoes?: {
      metodo?: MetodoPareamento;
      numero?: string;
      /**
       * Reinicia a sessão antes de pedir o pareamento.
       *
       * Necessário para obter um código NOVO: o gateway devolve o mesmo
       * `pairingCode` enquanto o socket anterior está de pé, então sem isto
       * "gerar outro" trazia de volta o código que acabou de expirar.
       */
      renovar?: boolean;
    },
  ): Promise<SessaoPareamento>;
  encerrarSessao(canal: Canal): Promise<void>;
}

export const CAPACIDADES: Record<Canal["tipoConexao"], CapacidadesProvedor> = {
  api_oficial: { textoLivre: false, tarifada: true, validaNumeros: false, relatorioEntrega: true },
  qrcode: { textoLivre: true, tarifada: false, validaNumeros: true, relatorioEntrega: true },
};
