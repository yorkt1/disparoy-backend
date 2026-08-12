import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ambiente, origensPermitidas } from "./config/ambiente";
import { FiltroExcecoes } from "./comum/excecoes.filter";

async function iniciar() {
  const env = ambiente();
  const app = await NestFactory.create(AppModule, { bodyParser: true });

  app.setGlobalPrefix("api");
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
