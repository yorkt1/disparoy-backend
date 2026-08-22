import { Injectable, Logger } from "@nestjs/common";
import { ambiente } from "../config/ambiente";

/**
 * Desfecho de uma tentativa de alerta.
 *
 * `desabilitado` existe separado de `falhou` de propósito: são problemas
 * diferentes e a resposta a cada um é diferente. `falhou` é transitório e vale
 * tentar de novo; `desabilitado` é configuração faltando e tentar de novo não
 * muda nada — precisa de gente. Devolver o mesmo valor para os dois faria o
 * sistema retentar para sempre um endereço que não existe, ou desistir de um
 * webhook que só estava fora do ar por um minuto.
 */
export type ResultadoAlerta = "enviado" | "falhou" | "desabilitado";

/**
 * Reporte de erro para fora do processo — opcional, sem SDK.
 *
 * Não é Sentry nem nenhum APM: é um `fetch` simples, de propósito. Adicionar
 * uma dependência nova aqui exigiria `npm install` e reescrever o
 * `package-lock.json`, e este repositório trata lockfile fora de sincronia
 * como falha de CI (ver `.github/workflows/ci.yml`) — não é algo para fazer
 * sem rodar a instalação de verdade e ver o resultado. Um `fetch` sem
 * dependência nenhuma resolve o problema que importa agora — "alguém fica
 * sabendo quando algo quebra fora do horário que estão olhando o log" — sem
 * arriscar isso.
 *
 * O corpo é compatível com webhook de entrada do Slack/Discord/Teams (todos
 * aceitam `{ text: "..." }` ou equivalente) porque é o destino mais rápido de
 * configurar sem conta nova. Quem quiser Sentry de verdade — agrupamento de
 * issue, releases, breadcrumbs — precisa do SDK deles; isto aqui não substitui
 * isso, só evita o silêncio total enquanto ele não existe.
 */
@Injectable()
export class ObservabilidadeService {
  private readonly logger = new Logger(ObservabilidadeService.name);
  /**
   * O aviso de "sem destino configurado" sai UMA vez por processo.
   *
   * `relatarErro` é chamado de todo 500 da API. Avisar em cada chamada
   * transformaria um problema de configuração numa enxurrada de log — e log
   * que se repete é log que se aprende a ignorar, inclusive o próximo, que
   * seria diferente.
   */
  private avisouQueEstaDesabilitado = false;

  /**
   * O destino do alerta, sem depender do ambiente estar válido.
   *
   * `ambiente()` LANÇA quando a validação falha — e ambiente inválido é
   * justamente o erro que este alerta mais precisa reportar: o worker subiu
   * três dias sem `APP_URL_PUBLICA`, morrendo no boot, e ninguém foi avisado
   * porque quem avisaria morria na mesma linha. Passar pelo `process.env` cru
   * nesse caso mantém verdadeira a promessa de "nunca lança" logo abaixo.
   *
   * A URL não validada é aceitável: `fetch` rejeita a promessa em endereço
   * malformado, e isso vira `falhou`, que é registrado.
   */
  private urlDoAlerta(): string | undefined {
    try {
      return ambiente().ALERTA_WEBHOOK_URL || undefined;
    } catch {
      return process.env.ALERTA_WEBHOOK_URL || undefined;
    }
  }

  /**
   * Existe um destino externo configurado?
   *
   * Público porque quem depende do alerta precisa poder DIZER que ele não
   * existe, em vez de descobrir pelo silêncio. É o que o vigia do worker usa
   * para registrar `alerta_estado = 'desabilitado'` no incidente.
   */
  alertaExternoConfigurado(): boolean {
    return this.urlDoAlerta() !== undefined;
  }

  /**
   * Nunca lança e nunca espera de propósito (`void`, não `await`, no chamador
   * também): reportar o erro não pode virar um segundo erro, nem atrasar a
   * resposta que o operador já está esperando.
   *
   * Este é o caminho usado pelo filtro de exceções e pelos handlers de crash
   * do worker, onde não há a quem devolver um resultado. Quem PRECISA saber se
   * o alerta saiu — o vigia, que grava isso no incidente — usa `enviarAlerta`.
   */
  relatarErro(origem: string, erro: unknown, contexto: Record<string, unknown> = {}): void {
    void this.enviarAlerta(origem, erro, contexto);
  }

  /**
   * Manda o alerta e diz o que aconteceu. Nunca lança.
   *
   * A diferença para `relatarErro` é só o retorno: aqui o chamador consegue
   * gravar o desfecho. Sem isso, um POST que falhou é indistinguível de um que
   * saiu — e o vigia do worker, que alerta UMA vez por incidente, nunca mais
   * tentaria.
   */
  async enviarAlerta(
    origem: string,
    erro: unknown,
    contexto: Record<string, unknown> = {},
  ): Promise<ResultadoAlerta> {
    const url = this.urlDoAlerta();
    if (!url) {
      if (!this.avisouQueEstaDesabilitado) {
        this.avisouQueEstaDesabilitado = true;
        this.logger.error(
          "ALERTA EXTERNO DESABILITADO: ALERTA_WEBHOOK_URL não está configurada. " +
            "Os incidentes continuam sendo registrados no banco, mas NINGUÉM é avisado " +
            "fora do horário em que alguém estiver olhando o log — inclusive quando o " +
            "worker parar e nenhuma campanha estiver saindo.",
        );
      }
      return "desabilitado";
    }

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const stack = erro instanceof Error ? erro.stack : undefined;

    const linhas = [
      `🔴 *${origem}*`,
      mensagem,
      ...Object.entries(contexto).map(([k, v]) => `${k}: ${v}`),
    ];

    try {
      const resposta = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: linhas.join("\n"),
          origem,
          mensagem,
          stack,
          contexto,
          ocorridoEm: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5_000),
      });

      /*
       * Status de erro é FALHA, e antes não era.
       *
       * O código anterior só olhava a rejeição da promessa. Um webhook do
       * Slack revogado responde 403 com corpo `invalid_token`: a promessa
       * resolve, nada era registrado, e o alerta estava morto havia meses sem
       * ninguém saber. Aqui isso vira `falhou`, e o vigia tenta de novo na
       * rodada seguinte.
       */
      if (!resposta.ok) {
        this.logger.error(
          `Alerta externo recusado pelo destino (HTTP ${resposta.status}). ` +
            `Confira se ALERTA_WEBHOOK_URL ainda é válida.`,
        );
        return "falhou";
      }

      return "enviado";
    } catch (e) {
      // Aqui SIM vale logar: se o próprio alerta não sai, o log local é a
      // última linha de defesa contra o silêncio total.
      this.logger.error(`Falha ao enviar alerta externo: ${semSegredos(e, url)}`);
      return "falhou";
    }
  }
}

/**
 * Descrição do erro sem a URL dentro.
 *
 * `ALERTA_WEBHOOK_URL` de Slack/Discord É a credencial: o caminho carrega o
 * token, e quem tem a URL posta mensagem no canal. O `fetch` do Node coloca o
 * endereço na mensagem em alguns casos ("Failed to parse URL from ..."), e o
 * log do Render fica guardado. Trocar por um marcador mantém a mensagem útil
 * — o interessante é o MOTIVO, não o destino, que já está no `.env`.
 */
function semSegredos(erro: unknown, url: string): string {
  const texto = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
  if (!url) return texto;

  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }

  // Substitui a URL inteira primeiro; depois o host solto, que aparece em
  // erro de DNS/conexão ("getaddrinfo ENOTFOUND hooks.slack.com").
  const semUrl = texto.split(url).join("<ALERTA_WEBHOOK_URL>");
  return host ? semUrl.split(host).join("<destino-do-alerta>") : semUrl;
}
