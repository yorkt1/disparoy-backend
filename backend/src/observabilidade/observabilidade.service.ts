import { Injectable, Logger } from "@nestjs/common";
import { ambiente } from "../config/ambiente";

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
   * O destino do alerta, sem depender do ambiente estar válido.
   *
   * `ambiente()` LANÇA quando a validação falha — e ambiente inválido é
   * justamente o erro que este alerta mais precisa reportar: o worker subiu
   * três dias sem `APP_URL_PUBLICA`, morrendo no boot, e ninguém foi avisado
   * porque quem avisaria morria na mesma linha. Passar pelo `process.env` cru
   * nesse caso mantém verdadeira a promessa de "nunca lança" logo abaixo.
   *
   * A URL não validada é aceitável: `fetch` rejeita a promessa em endereço
   * malformado, e o `.catch` no fim deste arquivo já registra isso no log.
   */
  private urlDoAlerta(): string | undefined {
    try {
      return ambiente().ALERTA_WEBHOOK_URL || undefined;
    } catch {
      return process.env.ALERTA_WEBHOOK_URL || undefined;
    }
  }

  /**
   * Nunca lança e nunca espera de propósito (`void`, não `await`, no chamador
   * também): reportar o erro não pode virar um segundo erro, nem atrasar a
   * resposta que o operador já está esperando.
   */
  relatarErro(origem: string, erro: unknown, contexto: Record<string, unknown> = {}): void {
    const url = this.urlDoAlerta();
    if (!url) return;

    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const stack = erro instanceof Error ? erro.stack : undefined;

    const linhas = [
      `🔴 *${origem}*`,
      mensagem,
      ...Object.entries(contexto).map(([k, v]) => `${k}: ${v}`),
    ];

    fetch(url, {
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
    }).catch((e) => {
      // Aqui SIM vale logar: se o próprio alerta não sai, o log local é a
      // última linha de defesa contra o silêncio total.
      this.logger.error(`Falha ao enviar alerta externo: ${String(e)}`);
    });
  }
}
