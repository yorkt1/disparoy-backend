import "reflect-metadata";
import { Logger, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { ambiente, origemPermitida, origensPermitidas } from "./config/ambiente";
import { FiltroExcecoes } from "./comum/excecoes.filter";
import { cabecalhosDeSeguranca } from "./comum/seguranca.middleware";
import { limitarCorpo, TETO_CAMPANHA, TETO_PADRAO } from "./comum/corpo.middleware";
import { ObservabilidadeService } from "./observabilidade/observabilidade.service";

async function iniciar() {
  const env = ambiente();
  /**
   * Parser desligado aqui para ser registrado à mão mais abaixo.
   *
   * Com `bodyParser: true` o Nest registra `express.json()` sem `limit`, e o
   * padrão do Express é 100 kB — estreito demais para `POST /api/campanhas`,
   * que recebe o público inteiro num JSON só. Registrando à mão, o teto é
   * explícito e o middleware de recorte por rota entra antes dele.
   */
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  app.use(cabecalhosDeSeguranca);

  /**
   * Confia no proxy à frente da aplicação.
   *
   * Render e Vercel terminam o TLS e repassam o IP real em `X-Forwarded-For`.
   * Sem isto, `req.ip` é sempre o IP do proxy — e aí o rate limit vira global:
   * a primeira pessoa a estourar o limite derruba todo mundo, porque para o
   * Express todos são o mesmo cliente. A trilha de auditoria também passaria a
   * gravar o IP errado em toda linha.
   */
  app.set("trust proxy", 1);

  // `/` fica de fora do prefixo: é o que o navegador abre ao colar a URL do
  // serviço, e um "Cannot GET /" ali parece deploy quebrado. Só essa rota.
  app.setGlobalPrefix("api", { exclude: [{ path: "/", method: RequestMethod.GET }] });
  // Instanciado à mão porque `useGlobalFilters` roda fora do container do
  // Nest — `app.get(...)` é o jeito de pedir uma dependência já resolvida.
  app.useGlobalFilters(new FiltroExcecoes(app.get(ObservabilidadeService)));
  app.enableCors({
    // Callback, e não a lista crua, porque as entradas aceitam `*` — sem isso
    // cada deploy novo da Vercel exigiria editar a variável no painel.
    // Requisição sem Origin (curl, health check do Render, webhook) passa: CORS
    // é regra de navegador, e barrar aqui não protege nada.
    origin: (origem: string | undefined, callback: (erro: Error | null, ok: boolean) => void) =>
      callback(null, !origem || origemPermitida(origem)),
    /**
     * Sem credencial automática, de propósito.
     *
     * Esta API não emite nem lê cookie nenhum: a sessão é um Bearer no header
     * `Authorization`, guardado no `localStorage` do painel (ver
     * `sessao.service.ts`). `credentials: true` não habilitava nada que o
     * frontend use — o cliente HTTP dele nunca manda `credentials: "include"`.
     *
     * O que ele fazia era alargar o estrago de uma origem frouxa. O curinga de
     * `ORIGENS_PERMITIDAS` existe para os domínios que a Vercel troca a cada
     * deploy, e `https://disparoy-*.vercel.app` casa com qualquer projeto que
     * um terceiro publique com esse prefixo — `vercel.app` é domínio de
     * cadastro aberto. Sem `Access-Control-Allow-Credentials`, essa origem não
     * ganha nada que um `curl` já não pudesse fazer: o token da vítima vive no
     * `localStorage` da origem dela, que outra origem não lê. Com ele ligado, o
     * dia em que alguém trocar o token por cookie de sessão vira sequestro de
     * conta a partir de um subdomínio comprado de graça.
     *
     * Se um cookie passar a existir aqui, isto volta para `true` — e aí o
     * curinga do CORS precisa ser reavaliado junto, não depois.
     */
    credentials: false,
    // O painel manda o token da sessão aqui.
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  Logger.log(`CORS liberado para: ${origensPermitidas().join(", ")}`, "Bootstrap");

  /**
   * Recorte por rota ANTES do parser, parser depois.
   *
   * A ordem importa nas duas pontas: depois do `enableCors` para o 413 chegar
   * legível no painel em vez de virar erro de origem no console, e antes dos
   * parsers para a recusa acontecer sem bufferizar o corpo.
   */
  app.use(limitarCorpo);

  // O parser tem um teto só, então ele fica no maior corpo legítimo do sistema
  // (o público de uma campanha). Quem recorta rota a rota é o middleware acima.
  app.useBodyParser("json", { limit: TETO_CAMPANHA });
  // Nenhuma rota daqui recebe formulário; o teto fica no mínimo que preserva o
  // comportamento anterior sem oferecer superfície nova.
  app.useBodyParser("urlencoded", { extended: true, limit: TETO_PADRAO });

  app.enableShutdownHooks();

  await app.listen(env.PORT);
  Logger.log(`API em http://localhost:${env.PORT}/api`, "Bootstrap");
}

void iniciar();
