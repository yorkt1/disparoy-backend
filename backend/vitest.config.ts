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

    /**
     * 30 s, e não os 5 s padrão — pelo mesmo motivo das opções acima.
     *
     * Aqui timeout não é rede: não há nenhuma neste diretório. O que estoura é
     * setup honesto num processo disputado — `vi.resetModules()` seguido de
     * `await import()` reconstrói o grafo (`config/ambiente`, zod,
     * `@nestjs/common`), e o scrypt de `sessao.test.ts` custa centenas de ms
     * por chamada de propósito. Medido: um arquivo que roda em ~40 ms passou de
     * 10993 ms com a máquina saturada.
     *
     * O prejuízo não é o teste vermelho — é o que vem depois. O vitest ABORTA o
     * teste no estouro, mas não tem como matar o corpo dele, que segue rodando.
     * Quando esse corpo faz algo fire-and-forget (`relatarErro` manda o POST
     * sem esperar), a chamada aterrissa no espião do teste SEGUINTE, com o
     * `stubEnv` do teste seguinte. A lista chega com uma entrada a mais e quem
     * fica vermelho é o inocente — foi assim que `observabilidade.test.ts`
     * passou meses sendo acusado de um defeito que não era dele.
     *
     * O contrário — teste que trava de verdade — continua sendo pego: 30 s numa
     * suíte de ~14 s é ruído impossível de confundir com lentidão.
     */
    testTimeout: 30_000,
  },
});
