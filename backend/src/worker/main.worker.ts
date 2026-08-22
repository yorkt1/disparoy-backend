import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { DisparoService } from "./disparo.service";
import { ObservabilidadeService } from "../observabilidade/observabilidade.service";
import {
  FILA_CAMPANHA,
  FILA_CONTATO,
  FILA_MANUTENCAO,
  FILA_MORTOS,
  FILA_RETENCAO,
  FilaService,
  type JobCampanha,
  type JobContato,
} from "../fila/fila.service";

/**
 * Processo separado da API.
 *
 * Roda com `npm run dev:worker` (ou `start:worker` em produção) e pode ser
 * escalado sozinho: subir mais instâncias aumenta a vazão sem tocar na API,
 * porque o pg-boss distribui os jobs por advisory lock no Postgres.
 */
async function iniciar() {
  const logger = new Logger("Worker");
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["log", "warn", "error"],
    /*
     * Sem isto o `catch` no fim deste arquivo é decoração.
     *
     * O padrão do Nest é `abortOnError: true`, e aí uma falha de inicialização
     * termina em `process.abort()` DENTRO do framework (`nest-factory.js`):
     * a promessa nunca rejeita, o processo morre ali, e nenhum alerta sai —
     * foi assim que um `render.yaml` sem `APP_URL_PUBLICA` derrubou o worker
     * por três dias em silêncio. Com `false`, o erro volta para quem chamou,
     * que é quem sabe avisar antes de sair.
     */
    abortOnError: false,
  });
  app.enableShutdownHooks();

  const fila = app.get(FilaService);
  const disparo = app.get(DisparoService);
  const observabilidade = app.get(ObservabilidadeService);
  const boss = fila.instancia();

  // Planejamento: um de cada vez, porque é rápido e só enfileira.
  await boss.work<JobCampanha>(FILA_CAMPANHA, { batchSize: 1 }, async ([job]) => {
    logger.log(`Planejando campanha ${job.data.campanhaId}`);
    await disparo.planejarCampanha(job.data);
  });

  /**
   * Envio.
   *
   * ATENÇÃO À SEMÂNTICA DE `DISPARO_CONCORRENCIA_POR_CANAL`: o nome diz "por
   * canal", mas o valor vira `batchSize` da fila `disparo-contato`, que é
   * GLOBAL — vale para todos os canais, todas as campanhas e todas as empresas
   * somados. Com o padrão `1`, o worker processa um contato por vez no sistema
   * inteiro; com `5`, cinco ao mesmo tempo, e nada garante que sejam de canais
   * diferentes.
   *
   * O laço abaixo ainda é `await` sequencial dentro do lote, então na prática
   * o paralelismo real é 1 mesmo com `batchSize` maior — o que muda é quantos
   * jobs saem da fila por rodada. Subir o número sem trocar este laço por
   * `Promise.all` não acelera nada; trocar o laço por `Promise.all` acelera e
   * derruba a garantia de cadência que o `startAfter` de cada job carrega,
   * porque vários contatos passariam a sair no mesmo instante.
   *
   * Por isso o valor NÃO deve ser mexido sem estudar o efeito: cadência fixa e
   * rajada simultânea são os dois padrões que mais pesam no risco de bloqueio
   * do número, e o sistema inteiro (intervalos sorteados, rodízio de canais,
   * cota diária) existe para evitá-los.
   */
  await boss.work<JobContato>(
    FILA_CONTATO,
    { batchSize: disparo.concorrenciaPorCanal() },
    async (jobs) => {
      for (const job of jobs) {
        await disparo.dispararContato(job.data);
      }
    },
  );

  /**
   * Manutenção: reconcilia travados, agrega métricas, aplica retenção.
   *
   * É a rede que segura tudo o que este processo pode largar pelo caminho —
   * deploy do Render, OOM, queda da VPS da Evolution. Sem ela, contato que
   * ficou em "enviando" nunca mais sai de lá e a campanha não conclui.
   */
  await boss.work(FILA_MANUTENCAO, { batchSize: 1 }, async () => {
    await disparo.manutencao();
  });
  await fila.agendarManutencao();

  /**
   * Expurgo de `mensagens_enviadas`, uma vez por dia — fila própria, e não
   * dentro de `FILA_MANUTENCAO`. Ver o comentário de `FILA_RETENCAO` em
   * `fila.service.ts` para o motivo de não rodar a cada minuto.
   */
  await boss.work(FILA_RETENCAO, { batchSize: 1 }, async () => {
    await disparo.purgarMensagensAntigas();
  });
  await fila.agendarRetencao();

  /**
   * Dead letter: jobs que esgotaram as tentativas.
   *
   * `createQueue` já apontava as duas filas para cá desde o começo, mas nada
   * consumia — os jobs se acumulavam no schema `fila` sem que ninguém soubesse
   * que tinham morrido. Cada um vira um incidente visível no painel.
   */
  /*
   * O JOB INTEIRO, não só `job.data`.
   *
   * `jobs_mortos` deduplica por `job_id`, e o id só existe aqui: o handler da
   * dead letter roda em lote e, se falhar no meio, o pg-boss reentrega o que
   * não completou — sem o id, o mesmo job morto viraria duas linhas e o
   * operador reprocessaria duas vezes. Um "mecanismo de recuperação" que
   * duplica mensagem é pior que não ter mecanismo nenhum.
   */
  await boss.work(FILA_MORTOS, { batchSize: 10 }, async (jobs) => {
    for (const job of jobs) {
      await disparo.registrarJobMorto({ id: job.id, name: job.name, data: job.data });
    }
  });

  logger.log(
    `Worker ativo — filas "${FILA_CAMPANHA}", "${FILA_CONTATO}", "${FILA_MANUTENCAO}" e ` +
      `"${FILA_RETENCAO}" (concorrência ${disparo.concorrenciaPorCanal()}).`,
  );

  /**
   * Encerramento com teto de tempo.
   *
   * O Render manda SIGTERM e mata em 30 s. Um `app.close()` sem limite pode
   * ficar esperando um envio em andamento e levar SIGKILL no meio da escrita —
   * pior que sair sozinho. Saindo por conta própria, o contato em voo fica em
   * "enviando" e o reaper o devolve à fila em até 15 minutos.
   */
  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    logger.log(`${sinal} recebido, encerrando o worker...`);

    const prazo = setTimeout(() => {
      logger.warn("Encerramento passou de 20 s; saindo à força.");
      process.exit(1);
    }, 20_000);
    prazo.unref();

    await app.close().catch((e: unknown) => logger.error(`Falha ao encerrar: ${String(e)}`));
    clearTimeout(prazo);
    process.exit(0);
  };
  process.on("SIGINT", () => void encerrar("SIGINT"));
  process.on("SIGTERM", () => void encerrar("SIGTERM"));

  /**
   * Um erro não tratado deixa o processo num estado que ninguém modelou.
   *
   * Sair é mais seguro que seguir: o Render reinicia o worker, os jobs em voo
   * voltam para a fila e o reaper cuida do resto. Ficar de pé "meio quebrado"
   * é o cenário em que a campanha para sem ninguém perceber.
   */
  /*
   * O alerta aqui é MELHOR-ESFORÇO, não a defesa principal.
   *
   * Quem detecta de verdade o worker morto é o vigia do pulso, rodando na API
   * (`VigiaWorkerService`) — de FORA deste processo, porque um processo que
   * travou ou levou SIGKILL não tem como avisar coisa nenhuma. O que sai
   * daqui só ajuda no caso feliz: uma exceção JS que ainda dá tempo de um
   * `fetch` sair antes do `process.exit`. Não substitui o vigia, complementa:
   * quando funciona, chega minutos antes e já vem com o motivo.
   */
  process.on("unhandledRejection", (motivo) => {
    logger.error(`Promessa rejeitada sem tratamento: ${String(motivo)}`);
    observabilidade.relatarErro("Worker — promessa rejeitada sem tratamento", motivo);
    void encerrar("unhandledRejection");
  });
  process.on("uncaughtException", (erro) => {
    logger.error(`Exceção não capturada: ${erro.stack ?? erro.message}`);
    observabilidade.relatarErro("Worker — exceção não capturada", erro);
    void encerrar("uncaughtException");
  });
}

/**
 * Falha ANTES de o worker existir — boot, na prática.
 *
 * Os dois handlers de dentro de `iniciar()` não cobrem nada disto: eles são
 * registrados no fim da função, e um ambiente inválido ou um Postgres
 * inalcançável derrubam o processo em `createApplicationContext`, muito antes.
 * Era um ponto cego real: o worker ficou três dias reiniciando em laço por uma
 * variável faltando no `render.yaml`, sem que um único alerta saísse — o
 * incidente veio do vigia do pulso, do outro lado, sem dizer o motivo.
 *
 * Isto NÃO substitui o vigia (`VigiaWorkerService`): um SIGKILL continua não
 * deixando ninguém avisar coisa nenhuma. É o mesmo melhor-esforço dos outros
 * handlers, cobrindo a janela que faltava — e aqui ele chega com a causa, que
 * é o que o vigia não tem como saber.
 */
iniciar().catch((erro: unknown) => {
  const logger = new Logger("Worker");
  logger.error(
    `O worker não conseguiu iniciar: ${erro instanceof Error ? (erro.stack ?? erro.message) : String(erro)}`,
  );

  // Instanciado à mão porque o contexto Nest é exatamente o que não existe
  // aqui. O serviço não tem dependência de construtor — só `fetch` e ambiente.
  new ObservabilidadeService().relatarErro("Worker — falha ao iniciar", erro);

  /*
   * Sai com 1 sem cortar o alerta no meio do caminho.
   *
   * `exitCode` em vez de `process.exit()` imediato: o `fetch` do alerta segura
   * o event loop até responder (ou até o timeout de 5 s dele), e só então o
   * processo termina — com código 1, que é o que faz o Render tratar isto como
   * deploy quebrado em vez de encerramento limpo. O prazo com `unref` é a
   * saída para o caso em que a fila deixou conexão aberta e o loop nunca
   * drenaria sozinho: sem ele, o ponto cego viraria um worker pendurado, que é
   * pior que um que reinicia.
   */
  process.exitCode = 1;
  const prazo = setTimeout(() => process.exit(1), 6_000);
  prazo.unref();
});
