import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Orçamento de consultas NÃO escopadas por empresa.
 *
 * Por que este teste existe, e por que ele é do jeito que é:
 *
 * A API conecta com a service role do Supabase, e esse papel tem `BYPASSRLS`.
 * Nenhuma política do banco se aplica a ela — nem as que a migration
 * 20260822000200 escreveu. Para a LEITURA feita pela própria API, o filtro por
 * empresa em `noEscopo()` não tem segunda linha de defesa em lugar nenhum: ele
 * é a defesa.
 *
 * O modo de falha é silencioso por natureza. Um `.eq("empresa_id", ...)` que
 * some de um caminho não quebra teste nenhum e não muda nada na tela do dono —
 * o defeito só aparece quando um cliente lê dentro de outro, e aí já vazou.
 * `isolamento.test.ts` e `campanhas.test.ts` cobrem os caminhos que já se
 * sabe que importam; este cobre os que ainda vão ser escritos.
 *
 * COMO ELE FUNCIONA: conta, por arquivo, quantas consultas a tabelas de dado
 * de cliente NÃO estão dentro de um `noEscopo(...)`. Se o número subir, o
 * teste quebra e diz onde. Não é análise estática de verdade — é um orçamento,
 * e é de propósito: o alvo não é provar que todo caminho está certo (nem
 * daria, várias consultas são legitimamente sem escopo), é impedir que alguém
 * acrescente uma consulta sem escopo sem ninguém olhar.
 *
 * CONTAGEM POR ARQUIVO, e não por linha: número de linha muda com qualquer
 * edição, e um teste que quebra em toda mudança é um teste que se aprende a
 * atualizar sem ler.
 *
 * QUANDO ESTE TESTE QUEBRAR, há duas saídas honestas:
 *  1. envolver a consulta nova em `noEscopo(consulta, usuario)` — quase sempre
 *     é isto;
 *  2. se ela é legitimamente sem escopo, subir o número aqui embaixo E
 *     escrever ao lado por que ela é segura.
 * Subir o número sem a segunda parte é derrotar o propósito.
 */

/** Tabelas cujo dado pertence a UMA empresa. `perfis` entra: é acesso. */
const TABELAS_DE_CLIENTE = [
  "campanhas",
  "canais",
  "contatos",
  "listas",
  "templates",
  "spintax",
  "opt_outs",
  "perfis",
];

/**
 * Quantas consultas sem escopo cada arquivo tem hoje, e por quê.
 *
 * Arquivo que não aparece aqui precisa ter ZERO.
 */
const ORCAMENTO: Record<string, number> = {
  /*
   * Caminhos do WORKER e do WEBHOOK: não há usuário autenticado.
   *
   * O worker executa a campanha que o job aponta e o webhook responde ao
   * gateway — nenhum dos dois tem `UsuarioAutenticado` para escopar, e é assim
   * de propósito (ver o cabeçalho de `comum/escopo.ts`). O isolamento deles é
   * outro: o job carrega o id da campanha, e a campanha carrega a empresa.
   */
  "worker/disparo.service.ts": 10,
  "webhooks/evolution.service.ts": 3,

  /*
   * BOOT e SAÚDE: rodam antes de existir requisição.
   *
   * `admin-inicial` garante o primeiro admin no boot, e o health check só
   * prova que o banco responde.
   */
  "usuarios/admin-inicial.service.ts": 4,
  "saude.controller.ts": 1,

  /*
   * LOGIN: o usuário ainda não foi identificado — é o que a rota faz.
   * `auth.guard` é quem RESOLVE o perfil a partir do `sub` do token: escopar
   * ali seria circular.
   */
  "auth/sessao.service.ts": 3,
  "auth/auth.guard.ts": 1,

  /*
   * `auditoria.service.ts`: lê `perfis` por id para DERIVAR a empresa de quem
   * praticou a ação. É a origem do escopo, não um consumidor dele.
   */
  "auditoria/auditoria.service.ts": 1,

  /*
   * `limites.service.ts`: filtra com `.eq("empresa_id", empresaId)` explícito,
   * a partir do valor que `empresaParaEscrita` já validou. Não passa por
   * `noEscopo` porque não recebe `UsuarioAutenticado` — recebe a empresa.
   */
  "comum/limites.service.ts": 2,

  /*
   * `empresas.service.ts`: a administração global de empresas. As rotas são
   * `@SomenteAdmin()` e a checagem de conta global é feita no serviço.
   */
  "empresas/empresas.service.ts": 2,

  /*
   * Consultas por ID cujo dono JÁ foi conferido na mesma função, mais os
   * INSERTs, que não filtram — eles GRAVAM a empresa.
   *
   * O escopo de uma escrita é `empresaParaEscrita(usuario)`, que recusa a
   * conta global em vez de escolher uma empresa por ela. Envolver um insert em
   * `noEscopo` não faria sentido: não há linha para filtrar.
   *
   * `campanhas`: `pausar`/`retomar`/`linha`/`rodadaAtual` rodam depois de
   * `obter()`, que é escopado e lança `NotFoundException` para campanha de
   * outra empresa — `campanhas.test.ts` guarda isso. `exigirCanaisProntos` lê
   * `canais` depois de `canais.exigirAcesso`, que confere a empresa antes do
   * papel. `textosDasRespostas` e `publicoDaCampanha` entram pela mesma porta:
   * as duas filtram por `campanha_id` e só são chamadas por métodos que já
   * passaram por `obter()` — quem não é dono da campanha nem chega no id.
   *
   * `canais`: mesma coisa via `obter()`/`exigirAcesso()`. `isolamento.test.ts`
   * cobre esses caminhos, inclusive o furo do vínculo cruzado em
   * `canal_membros`.
   *
   * `usuarios`: `ajustar` lê o alvo com `noEscopo` antes de escrever, e
   * `isolamento.test.ts` prova que o admin de uma empresa não redefine senha
   * nem desativa acesso de outra.
   */
  "campanhas/campanhas.service.ts": 9,
  "canais/canais.service.ts": 7,
  "spintax/spintax.service.ts": 1,
  "templates/templates.service.ts": 2,
  "usuarios/usuarios.service.ts": 5,
};

/**
 * Uma consulta conta como escopada quando `noEscopo(` aparece na mesma linha
 * ou nas 4 anteriores.
 *
 * É o formato que todos os call sites usam — `noEscopo(` abrindo e a consulta
 * encadeada logo abaixo. A janela é curta para não dar falso positivo com um
 * `noEscopo` de outra consulta mais acima.
 */
const JANELA = 4;

/**
 * A raiz de `src`, a partir do diretório de execução.
 *
 * Não usa `import.meta.url`: o `tsconfig` do backend compila para CommonJS, e
 * `tsc --noEmit` recusa `import.meta` nesse alvo (TS1470) — o teste passaria e
 * o typecheck do CI quebraria.
 *
 * As duas tentativas cobrem os dois jeitos de rodar a suíte: `npm test` na
 * raiz do monorepo entra em cada workspace (cwd = `backend/`), e `npx vitest`
 * chamado da raiz mantém o cwd lá. Se nenhuma existir, o teste de varredura
 * vazia logo abaixo acusa.
 */
const RAIZ = existsSync(join(process.cwd(), "src"))
  ? join(process.cwd(), "src")
  : join(process.cwd(), "backend", "src");

function arquivosDeCodigo(diretorio: string): string[] {
  const encontrados: string[] = [];
  for (const nome of readdirSync(diretorio).sort()) {
    const caminho = join(diretorio, nome);
    if (statSync(caminho).isDirectory()) {
      encontrados.push(...arquivosDeCodigo(caminho));
    } else if (nome.endsWith(".ts") && !nome.endsWith(".test.ts")) {
      encontrados.push(caminho);
    }
  }
  return encontrados;
}

function consultasSemEscopo(conteudo: string): number {
  const linhas = conteudo.split("\n");
  const alvo = new RegExp(`\\.tabela\\("(${TABELAS_DE_CLIENTE.join("|")})"\\)`);

  let total = 0;
  for (let i = 0; i < linhas.length; i += 1) {
    if (!alvo.test(linhas[i])) continue;
    const contexto = linhas.slice(Math.max(i - JANELA, 0), i + 1).join("\n");
    if (!contexto.includes("noEscopo(")) total += 1;
  }
  return total;
}

describe("orçamento de consultas sem escopo de empresa", () => {
  const arquivos = arquivosDeCodigo(RAIZ);

  it("encontra os arquivos do backend (guarda contra varredura vazia)", () => {
    // Um teste que varre nada passa sempre. Este número só precisa provar que
    // a varredura funcionou, então é um piso folgado.
    expect(arquivos.length).toBeGreaterThan(30);
  });

  it("nenhum arquivo tem mais consultas sem escopo do que o orçamento", () => {
    const estouraram: string[] = [];

    for (const caminho of arquivos) {
      const relativo = relative(RAIZ, caminho).split("\\").join("/");
      const encontradas = consultasSemEscopo(readFileSync(caminho, "utf8"));
      const permitidas = ORCAMENTO[relativo] ?? 0;

      if (encontradas > permitidas) {
        estouraram.push(
          `${relativo}: ${encontradas} consulta(s) sem noEscopo, orçamento é ${permitidas}. ` +
            `Envolva a consulta nova em noEscopo(consulta, usuario) — ou, se ela for ` +
            `legitimamente sem escopo, suba o número em escopo-cobertura.test.ts E escreva por quê.`,
        );
      }
    }

    expect(estouraram).toEqual([]);
  });

  /**
   * O orçamento também não pode ficar FOLGADO.
   *
   * Se alguém escopar uma consulta e não baixar o número, o teste passa a
   * aceitar uma consulta sem escopo de graça — a proteção seria devolvida em
   * silêncio, que é como este tipo de teste morre.
   */
  it("o orçamento não sobra: nenhum arquivo tem menos do que o declarado", () => {
    const folgados: string[] = [];

    for (const [relativo, permitidas] of Object.entries(ORCAMENTO)) {
      const caminho = join(RAIZ, relativo);
      const encontradas = consultasSemEscopo(readFileSync(caminho, "utf8"));

      if (encontradas < permitidas) {
        folgados.push(
          `${relativo}: só ${encontradas} consulta(s) sem noEscopo, mas o orçamento é ` +
            `${permitidas}. Baixe o número — orçamento folgado libera uma consulta sem ` +
            `escopo sem ninguém perceber.`,
        );
      }
    }

    expect(folgados).toEqual([]);
  });
});
