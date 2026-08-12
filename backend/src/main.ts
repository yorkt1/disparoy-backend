import "reflect-metadata";
import { Logger, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ambiente, origensPermitidas } from "./config/ambiente";
import { FiltroExcecoes } from "./comum/excecoes.filter";

async function iniciar() {
  const env = ambiente();
  const app = await NestFactory.create(AppModule, { bodyParser: true });

  // `/` fica de fora do prefixo: é o que o navegador abre ao colar a URL do
  // serviço, e um "Cannot GET /" ali parece deploy quebrado. Só essa rota.
  app.setGlobalPrefix("api", { exclude: [{ path: "/", method: RequestMethod.GET }] });
  app.useGlobalFilters(new FiltroExcecoes());
  app.enableCors({
    origin: origensPermitidas(),
    credentials: true,
    // O frontend manda o JWT do Supabase aqui.
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  Logger.log(`API em http://localhost:${env.PORT}/api`, "Bootstrap");
}

void iniciar();
