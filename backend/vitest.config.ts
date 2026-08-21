import { defineConfig } from "vitest/config";

/**
 * Configuração do vitest do backend.
 *
 * Existe por um motivo só: garantir que o estado global volte ao lugar entre
 * um teste e outro, sem depender de cada arquivo lembrar de fazer isso.
 *
 * O defeito que motivou o arquivo: `observabilidade.test.ts` passava sozinho e
 * falhava na suíte inteira. `config/origens.test.ts` escrevia direto em
 * `process.env` e resetava os módulos só no `beforeEach` — que não roda depois
 * do último teste. Sobrava para o arquivo seguinte um `config/ambiente.ts` já
 * avaliado, com o `cache` do topo do módulo preenchido. Aí `ambiente()` parava
 * de lançar em `ObservabilidadeService.urlDoAlerta()`, o `catch` que lê
 * `process.env.ALERTA_WEBHOOK_URL` nunca rodava, nenhum alerta saía e o teste
 * via uma lista vazia. Um teste correto acusando um arquivo que não é o
 * culpado é a pior forma de suíte vermelha.
 *
 * Nada aqui esconde ordem de execução: não há `retry`, `isolate: false`,
 * `singleThread` nem sequência fixada. O isolamento por arquivo do vitest
 * continua ligado — estas opções são a segunda camada, para o dia em que ele
 * não segurar (worker reaproveitado, `--no-isolate` para ganhar tempo no CI) e
 * para o teste novo que ainda vai ser escrito sem `afterEach`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],

    // Desfaz `vi.stubEnv`/`vi.stubGlobal`/`vi.spyOn` antes de CADA teste. É o
    // que transforma esquecer o `afterEach` em nada, em vez de numa falha em
    // outro arquivo, meia hora depois, sem relação aparente com a mudança.
    unstubEnvs: true,
    unstubGlobals: true,
    restoreMocks: true,
  },
});
