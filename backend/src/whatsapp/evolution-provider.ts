import type { Canal, TipoMidia } from "@disparoy/dominio";
import { ambiente } from "../config/ambiente";
import {
  CAPACIDADES,
  classificarEvolution,
  type CodigoFalha,
  type EnvioSolicitado,
  type EstadoGateway,
  type MetodoPareamento,
  type ProvedorComQrCode,
  type ResultadoEnvio,
  type ResultadoValidacaoNumero,
  type SessaoPareamento,
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
  /**
   * Com `number`, a Evolution devolve `pairingCode` em vez de QR — é o mesmo
   * endpoint, e o parâmetro é o que decide a forma do pareamento.
   */
  conectar: (i: string, numero?: string) =>
    numero
      ? `instance/connect/${i}?number=${encodeURIComponent(numero)}`
      : `instance/connect/${i}`,
  estado: (i: string) => `instance/connectionState/${i}`,
  reiniciar: (i: string) => `instance/restart/${i}`,
  desconectar: (i: string) => `instance/logout/${i}`,
  excluir: (i: string) => `instance/delete/${i}`,
  definirWebhook: (i: string) => `webhook/set/${i}`,
  enviarTexto: (i: string) => `message/sendText/${i}`,
  enviarMidia: (i: string) => `message/sendMedia/${i}`,
  verificarNumeros: (i: string) => `chat/whatsappNumbers/${i}`,
  buscarContatos: (i: string) => `chat/findContacts/${i}`,
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

/**
 * Quanto tempo o pareamento espera o gateway trocar o código, no máximo.
 *
 * Esta espera roda dentro da requisição HTTP, então ela é orçamento de latência
 * da rota, não paciência: o operador está olhando para um botão girando e há um
 * proxy contando os segundos no meio do caminho. Seis segundos dão o dobro dos
 * ~3 s medidos para o código novo aparecer, e mantêm a resposta inteira abaixo
 * dos 10 s que derrubariam a conexão.
 */
const ESPERA_CODIGO_NOVO_MS = 6_000;

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

/**
 * Reexportado do domínio compartilhado, não redefinido aqui.
 *
 * O painel renderiza este mesmo estado, e duas definições da mesma união
 * divergiriam no dia em que alguém acrescentasse um valor de um lado só.
 */
export type { EstadoGateway };

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
  async iniciarSessao(
    canal: Canal,
    opcoes: { metodo?: MetodoPareamento; numero?: string; renovar?: boolean } = {},
  ): Promise<SessaoPareamento> {
    if (!evolutionConfigurada()) throw new ErroEvolution(SEM_CONFIG, "provedor_nao_configurado");

    const metodo: MetodoPareamento = opcoes.metodo ?? "qrcode";
    if (metodo === "codigo" && !opcoes.numero) {
      throw new ErroEvolution(
        "Pareamento por código exige o número do WhatsApp.",
        "canal_mal_configurado",
      );
    }

    const instancia = canal.instanciaEvolution;

    /*
     * Nenhuma agenda em cache sobrevive a um pareamento.
     *
     * O cache é indexado pela INSTÂNCIA, e a instância é a mesma quando se
     * repareia com outro número — `excluir` já cuidava do canal apagado, mas
     * reconectar é a mesma herança pela porta ao lado: dentro dos cinco minutos
     * de cache, a extração devolveria a agenda do número anterior.
     *
     * Aqui e não no desconectar porque a sessão também cai sozinha, pelo
     * webhook ou pelo worker, sem ninguém chamar `encerrarSessao`. Todo
     * religamento passa por este ponto; nem toda queda passa por aquele.
     */
    esquecerAgenda(instancia);

    // A Evolution quer o número só com dígitos: o `+` do E.164 volta como
    // "number is not valid" e derruba o pareamento inteiro.
    const numero = opcoes.numero?.replace(/\D/g, "");

    await chamar(CAMINHOS.criarInstancia(), {
      method: "POST",
      body: JSON.stringify({
        instanceName: instancia,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
        // Informado já na criação: a Evolution associa a instância ao número e
        // é isso que permite ao `connect` devolver o código de pareamento.
        ...(numero ? { number: numero } : {}),
      }),
      // A instância pode já existir de uma tentativa anterior; nesse caso a
      // Evolution devolve erro e seguimos direto para o connect.
    }).catch(() => undefined);

    /*
     * Reiniciar a instância é o que produz um pareamento NOVO.
     *
     * `instance/connect` devolve o MESMO `pairingCode` enquanto o socket
     * daquela sessão continua de pé. Depois que o código expirava, "gerar
     * outro" trazia de volta exatamente o código morto — a tela mostrava algo
     * que não funcionava mais e não havia saída pelo produto.
     *
     * Medido: dois `connect` seguidos devolveram `245574YY` nas duas vezes;
     * com o restart no meio, o código mudou.
     *
     * Só na renovação: na criação a instância acabou de nascer, e reiniciá-la
     * seria derrubar a sessão antes de ela existir.
     */
    const avisos: string[] = [];
    let codigoAntigo: string | null = null;

    if (opcoes.renovar) {
      try {
        // A resposta do restart ainda traz o código VELHO — e é justamente por
        // isso que ela serve: vira a referência para saber quando o novo chegou.
        const reinicio = await chamar<{ pairingCode?: string }>(CAMINHOS.reiniciar(instancia), {
          method: "POST",
        });
        codigoAntigo = reinicio?.pairingCode ?? null;
      } catch (e) {
        /*
         * Reinício falhou: sem ele, o `connect` devolve o código ANTERIOR.
         *
         * O `.catch(() => null)` que estava aqui produzia o pior desfecho
         * possível — `codigoAntigo` ficava nulo, a espera lá embaixo desistia
         * na primeira volta por não ter com o que comparar, e a rota entregava
         * o código morto com cara de novo. O operador digitava algo que não
         * tinha como funcionar e a tela não dava nenhuma pista do motivo.
         */
        avisos.push(
          `Não foi possível reiniciar a sessão no gateway (${
            e instanceof Error ? e.message : String(e)
          }). O código abaixo pode ser o da tentativa anterior.`,
        );
      }
    }

    const avisoWebhook = await registrarWebhook(instancia);
    if (avisoWebhook) avisos.push(avisoWebhook);

    const conectar = () =>
      chamar<{
        base64?: string;
        code?: string;
        pairingCode?: string;
        qrcode?: { base64?: string; pairingCode?: string };
      }>(CAMINHOS.conectar(instancia, numero));

    let r = await conectar();

    /*
     * Espera o socket novo subir, medindo em vez de cronometrar.
     *
     * Medido neste gateway: 1,5 s depois do restart o `connect` ainda devolvia
     * o código velho; a partir de ~3 s vinha um novo. Um `sleep` fixo escolhe
     * um número que vai errar no dia em que a VPS estiver mais lenta — então a
     * espera termina quando o CÓDIGO MUDA, que é a condição real.
     *
     * O teto é de TEMPO, e não de tentativas, porque tudo isto acontece DENTRO
     * da requisição HTTP do operador. Seis tentativas de 1,2 s mais seis
     * `connect` chegavam a 12-15 s de resposta síncrona — acima do timeout
     * padrão de proxy (10 s), o que troca "código velho" por "502 sem
     * explicação". Com 6 s, o pior caso da rota inteira fica em torno de 8 s e
     * ainda sobra o dobro da latência medida.
     */
    const limite = Date.now() + ESPERA_CODIGO_NOVO_MS;
    while (codigoAntigo && Date.now() < limite) {
      const atual = r.pairingCode ?? r.qrcode?.pairingCode ?? null;
      if (atual && atual !== codigoAntigo) break;
      await new Promise((espera) => setTimeout(espera, 1200));
      r = await conectar();
    }

    /*
     * Desistir calado devolveria o código morto como se fosse novo — o mesmo
     * desfecho do restart engolido, por outro caminho. Se o gateway ainda não
     * trocou, quem vai digitar precisa saber disso ANTES de tentar.
     */
    if (codigoAntigo && (r.pairingCode ?? r.qrcode?.pairingCode ?? null) === codigoAntigo) {
      avisos.push(
        "O gateway ainda está devolvendo o código da tentativa anterior. " +
          "Se ele não funcionar, peça outro em alguns segundos.",
      );
    }

    const aviso = avisos.length > 0 ? avisos.join(" ") : null;

    if (metodo === "codigo") {
      const codigo = r.pairingCode ?? r.qrcode?.pairingCode ?? null;
      // Sem código não há o que digitar. Falhar aqui é melhor que devolver uma
      // tela vazia com o operador esperando um número que nunca vem.
      if (!codigo) {
        throw new ErroEvolution(
          "A Evolution não retornou o código de pareamento. Confira se o número está correto.",
          "canal_sem_sessao",
        );
      }
      return {
        canalId: canal.id,
        metodo,
        qr: null,
        codigo,
        // O código dura bem mais que o QR — a própria Evolution dá alguns
        // minutos, e um teto curto demais faria a tela expirar antes da hora.
        expiraEm: new Date(Date.now() + 180_000).toISOString(),
        ...(aviso ? { aviso } : {}),
      };
    }

    const qr = r.base64 ?? r.qrcode?.base64 ?? r.code;
    // Sem QR não há o que escanear; devolver vazio renderizaria uma imagem
    // quebrada e o operador ficaria esperando por nada.
    if (!qr) throw new ErroEvolution("A Evolution não retornou o QR Code.", "canal_sem_sessao");

    return {
      canalId: canal.id,
      metodo,
      qr,
      codigo: null,
      expiraEm: new Date(Date.now() + 60_000).toISOString(),
      ...(aviso ? { aviso } : {}),
    };
  },

  async encerrarSessao(canal: Canal): Promise<void> {
    if (!evolutionConfigurada()) throw new ErroEvolution(SEM_CONFIG, "provedor_nao_configurado");
    // Antes da chamada: quem desconecta já decidiu que aquele número saiu, e
    // `ajustar` engole a falha do gateway e marca o canal como desconectado do
    // mesmo jeito. Limpar depois deixaria o cache de pé justo nesse caso.
    esquecerAgenda(canal.instanciaEvolution);
    await chamar(CAMINHOS.desconectar(canal.instanciaEvolution), { method: "DELETE" });
  },
};

/** Um contato da agenda do WhatsApp, reduzido ao que vai para a planilha. */
export interface ContatoDaAgenda {
  nome: string;
  /** E.164, com o `+`. */
  telefone: string;
}

/**
 * A agenda do número pareado.
 *
 * Serve para extrair, não para armazenar: a planilha sai daqui e o operador
 * decide o que fazer com ela. Nada é gravado no banco.
 *
 * A Evolution mudou o formato desta resposta entre versões — às vezes um array
 * cru, às vezes embrulhado em objeto — e o nome do contato aparece ora em
 * `pushName`, ora em `name`. Ler as três formas custa pouco e evita que uma
 * atualização do gateway devolva uma planilha vazia sem nenhum erro visível.
 */
/**
 * Deduplicação de requisições EM VOO, por instância — não um cache.
 *
 * Nada aqui sobrevive além da própria promessa. A versão anterior guardava a
 * agenda por cinco minutos, e por causa disso o backend só podia rodar numa
 * réplica: repare um canal com outro número na réplica A e a réplica B
 * seguiria entregando a agenda do número anterior — dado pessoal de terceiro
 * que já não tem nenhuma relação com aquele canal. O comentário desta função
 * dizia "para escalar, o caminho é derrubar o cache, não movê-lo para o
 * banco" — persistir no Postgres criaria o cadastro paralelo de contatos que
 * o sistema inteiro recusa ter (ver `extrairContatos`). A única saída
 * consistente com essa regra era o cache deixar de existir.
 *
 * O que sobra: como a tela consulta a contagem e depois baixa em sequência
 * rápida, duas chamadas que colidem no MESMO processo, no mesmo instante,
 * dividem a mesma promessa em vez de abrir duas conexões à Evolution. Não
 * ajuda o caso de "consultei há 2 segundos" — esse agora paga a busca de novo,
 * de propósito, porque pagar ~860 ms por vez é o preço de não guardar agenda
 * de terceiro na memória entre requisições.
 */
const emVoo = new Map<string, Promise<ContatoDaAgenda[]>>();

export async function contatosDaInstancia(
  instancia: string,
  /** Mantido por compatibilidade — não há mais cache para ignorar. */
  _forcar = false,
): Promise<ContatoDaAgenda[]> {
  if (!evolutionConfigurada()) {
    throw new ErroEvolution(SEM_CONFIG, "provedor_nao_configurado");
  }

  const emAndamento = emVoo.get(instancia);
  if (emAndamento) return emAndamento;

  const promessa = buscarAgendaAgora(instancia).finally(() => emVoo.delete(instancia));
  emVoo.set(instancia, promessa);
  return promessa;
}

async function buscarAgendaAgora(instancia: string): Promise<ContatoDaAgenda[]> {
  const bruto = await chamar<unknown>(CAMINHOS.buscarContatos(instancia), {
    method: "POST",
    body: JSON.stringify({ where: {} }),
  });

  return mapearAgenda(bruto);
}

/**
 * A foto de perfil do número pareado, já baixada.
 *
 * Devolve os BYTES, não a URL. A que a Evolution informa aponta para
 * `pps.whatsapp.net` e é temporária — guardá-la significaria a foto sumir
 * sozinha da tela um dia, sem nada ter acontecido.
 *
 * `null` em qualquer tropeço: número sem foto, URL já expirada, gateway mudo.
 * Foto é enfeite; falhar aqui não pode atrapalhar o pareamento, que é o que
 * realmente importa naquele momento.
 */
export async function fotoDaInstancia(
  instancia: string,
): Promise<{ bytes: Uint8Array; tipo: string } | null> {
  if (!evolutionConfigurada()) return null;

  try {
    const instancias = await chamar<{ name?: string; profilePicUrl?: string }[]>(
      CAMINHOS.buscarInstancia(instancia),
    );
    const bruta = (Array.isArray(instancias) ? instancias : []).find(
      (i) => i.name === instancia,
    )?.profilePicUrl;
    if (!bruta) return null;

    const url = urlDeFotoPermitida(bruta);
    if (!url) return null;

    // Sem apikey: a URL do WhatsApp é pública enquanto vale.
    //
    // `redirect: "error"` porque seguir redirecionamento anularia a checagem de
    // host: bastaria o destino permitido responder 302 para onde quisesse.
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!r.ok) return null;

    const tipo = r.headers.get("content-type") ?? "image/jpeg";
    if (!tipo.startsWith("image/")) return null;

    const bytes = await lerAteOLimite(r, FOTO_MAX_BYTES);
    return bytes ? { bytes, tipo } : null;
  } catch {
    return null;
  }
}

/**
 * Teto da foto de perfil. Foto de WhatsApp real não passa de algumas dezenas de
 * KB; 2 MB é folga larga para um dado que existe só para enfeitar a listagem.
 */
const FOTO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Só o domínio de mídia do WhatsApp entra.
 *
 * Esta URL vem do GATEWAY, que é software de terceiro rodando numa VPS que não
 * é nossa — e o que a API fizer com ela sai da rede do Render, de dentro. Sem a
 * checagem, quem controlar a resposta da Evolution escolhe o endereço que a
 * nossa API vai buscar: `http://169.254.169.254/`, um serviço interno que não
 * está publicado na internet, qualquer coisa alcançável daqui. O resultado do
 * GET ainda por cima vai parar no Storage, de onde dá para ler depois.
 *
 * Casar sufixo `.whatsapp.net` com o ponto na frente é o que impede
 * `whatsapp.net.invasor.com` de passar.
 */
function urlDeFotoPermitida(bruta: string): URL | null {
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  if (host !== "whatsapp.net" && !host.endsWith(".whatsapp.net")) return null;

  return url;
}

/**
 * Lê o corpo cortando no limite, em vez de depois dele.
 *
 * `arrayBuffer()` só permitiria conferir o tamanho com tudo já na memória — e
 * "tudo" é o que a outra ponta decidir mandar. `content-length` não substitui a
 * contagem: é informado por quem responde, e pode faltar ou mentir.
 */
async function lerAteOLimite(r: Response, limite: number): Promise<Uint8Array | null> {
  const leitor = r.body?.getReader();
  if (!leitor) return null;

  const pedacos: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel();
      return null;
    }
    pedacos.push(value);
  }

  const bytes = new Uint8Array(total);
  let posicao = 0;
  for (const pedaco of pedacos) {
    bytes.set(pedaco, posicao);
    posicao += pedaco.byteLength;
  }
  return bytes;
}

/**
 * Não faz mais nada — mantida para não obrigar os três call sites a mudar.
 *
 * Existia para descartar a agenda de cinco minutos guardada do número
 * anterior. Sem armazenamento nenhum além da requisição em voo (ver
 * `contatosDaInstancia`), não há mais o que esquecer: a chamada seguinte já
 * busca de novo por conta própria, sempre.
 */
export function esquecerAgenda(_instancia: string): void {}

/**
 * Transforma a resposta crua da Evolution em contatos exportáveis.
 *
 * Separada de `contatosDaInstancia` para poder ser testada sem rede — a regra
 * de quais JIDs entram já causou um bug real, com 11 linhas impossíveis de
 * enviar dentro de uma planilha de 1815.
 */
export function mapearAgenda(bruto: unknown): ContatoDaAgenda[] {
  const lista = Array.isArray(bruto)
    ? bruto
    : Array.isArray((bruto as { contacts?: unknown })?.contacts)
      ? (bruto as { contacts: unknown[] }).contacts
      : [];

  const vistos = new Set<string>();
  const contatos: ContatoDaAgenda[] = [];

  for (const item of lista as Record<string, unknown>[]) {
    const jid = String(item?.remoteJid ?? item?.id ?? "");

    /*
     * Lista de PERMISSÃO, não de bloqueio.
     *
     * A agenda real devolveu quatro tipos de JID: `s.whatsapp.net` (pessoas),
     * `g.us` (grupos), `newsletter` (canais e packs de figurinhas) e `lid` — um
     * identificador interno do WhatsApp que PARECE telefone e não é.
     *
     * Bloquear os conhecidos deixava `lid` e `newsletter` passarem, e eles
     * viravam linhas com um "+número" que nenhuma campanha alcança. Como o
     * WhatsApp segue inventando tipos novos, só o sufixo de pessoa entra.
     */
    if (!jid.endsWith("@s.whatsapp.net")) continue;

    const digitos = jid.split("@")[0]?.replace(/\D/g, "") ?? "";
    // `0@s.whatsapp.net` é a conta oficial do WhatsApp, que vem em toda agenda.
    if (digitos.length < 10) continue;

    const telefone = `+${digitos}`;
    // A agenda repete o mesmo número em contatos diferentes com frequência.
    if (vistos.has(telefone)) continue;
    vistos.add(telefone);

    const nome = String(item.pushName ?? item.name ?? item.verifiedName ?? "").trim();
    contatos.push({ nome, telefone });
  }

  return contatos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

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
