import "reflect-metadata";
import { Logger, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { ambiente, origemPermitida, origensPermitidas } from "./config/ambiente";
import { FiltroExcecoes } from "./comum/excecoes.filter";
import { cabecalhosDeSeguranca } from "./comum/seguranca.middleware";
import { ObservabilidadeService } from "./observabilidade/observabilidade.service";

async function iniciar() {
  const env = ambiente();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });

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
    credentials: true,
    // O frontend manda o JWT do Supabase aqui.
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  Logger.log(`CORS liberado para: ${origensPermitidas().join(", ")}`, "Bootstrap");
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  Logger.log(`API em http://localhost:${env.PORT}/api`, "Bootstrap");
}

void iniciar();
