import "reflect-metadata";
import { Logger, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ambiente, origemPermitida, origensPermitidas } from "./config/ambiente";
import { FiltroExcecoes } from "./comum/excecoes.filter";

async function iniciar() {
  const env = ambiente();
  const app = await NestFactory.create(AppModule, { bodyParser: true });

  // `/` fica de fora do prefixo: é o que o navegador abre ao colar a URL do
  // serviço, e um "Cannot GET /" ali parece deploy quebrado. Só essa rota.
  app.setGlobalPrefix("api", { exclude: [{ path: "/", method: RequestMethod.GET }] });
  app.useGlobalFilters(new FiltroExcecoes());
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
