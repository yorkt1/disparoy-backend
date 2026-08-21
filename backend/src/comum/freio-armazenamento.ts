import { Logger, type OnApplicationShutdown } from "@nestjs/common";
import {
  ThrottlerStorageService,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { FreioService } from "./freio.service";

/**
 * O formato que o `ThrottlerGuard` espera de volta.
 *
 * Derivado da própria interface em vez de importado: o pacote declara
 * `ThrottlerStorageRecord` num arquivo interno e NÃO o reexporta no índice, então
 * `import { ThrottlerStorageRecord } from "@nestjs/throttler"` não compila. A
 * alternativa seria alcançar `@nestjs/throttler/dist/...` por caminho interno —
 * que é privado, some numa atualização de patch e leva o build junto. Amarrado
 * ao método, o dia em que o contrato mudar vira erro de tipo aqui, no lugar
 * certo, em vez de uma cópia desatualizada compilando em silêncio.
 */
type RegistroDeFreio = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

/**
 * Onde cada contador de rate limit é guardado.
 *
 * O armazenamento padrão do `@nestjs/throttler` é um `Map` na memória do
 * processo, e `render.yaml` roda a API com `numInstances: 2`. Contando por
 * réplica, o teto real é N vezes o escrito: os 10 logins por minuto do
 * `sessao.controller.ts` são 20 hoje e viram 30 no dia em que alguém subir a
 * terceira instância — sem uma linha de código mudar e sem nada dizendo isso.
 *
 * Mandar TUDO para o Postgres resolveria e criaria um problema maior: viraria
 * uma escrita por requisição, inclusive no caminho do webhook da Evolution, que
 * pode passar de 40 eventos por segundo durante um disparo e que precisa
 * responder rápido (webhook lento vira tempestade de reentrega). É a mesma
 * contenção de lock que o item 4 do `ROBUSTEZ.md` documenta ter custado caro —
 * repetir aquilo para proteger um teto de 40/10 s seria trocar um exagero por
 * um defeito.
 *
 * O corte é por INTENÇÃO declarada, não por rota escrita à mão aqui: quando uma
 * rota pede teto mais apertado que o global, ela está dizendo que ali tentativa
 * repetida é o ataque em si — e uma trava que conta só metade das tentativas
 * não é a trava que ela pediu. Essas vão para o banco. As demais, que herdam o
 * teto global, continuam em memória, e o comentário do `app.module.ts` registra
 * que o teto efetivo delas é N× o número escrito.
 *
 * A consequência prática, de propósito: quem apertar o teto de uma rota nova
 * ganha a contagem compartilhada junto, sem precisar lembrar de vir aqui.
 */
export class ArmazenamentoDeFreio implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger(ArmazenamentoDeFreio.name);

  /**
   * O contador em memória continua existindo, por dois motivos: é ele que
   * atende a maioria das rotas, e é para ele que o compartilhado degrada quando
   * o banco não responde.
   */
  private readonly local = new ThrottlerStorageService();

  /** Evita repetir o mesmo aviso a cada requisição enquanto o banco está fora. */
  private avisadoEm = 0;

  constructor(
    private readonly freio: FreioService,
    /** Teto global de cada freio nomeado, para reconhecer quem apertou o próprio. */
    private readonly tetosGlobais: ReadonlyMap<string, number>,
  ) {}

  async increment(
    chave: string,
    ttl: number,
    limite: number,
    bloqueio: number,
    nome: string,
  ): Promise<RegistroDeFreio> {
    if (!this.exigeContagemCompartilhada(nome, limite)) {
      return this.local.increment(chave, ttl, limite, bloqueio, nome);
    }

    const registro = await this.freio.consumir(chave, ttl, limite, bloqueio);

    if (!registro) {
      /**
       * Banco fora: cai para a contagem por réplica em vez de liberar.
       *
       * Um freio que se desliga sozinho quando o banco pisca é pior que um
       * freio frouxo — o momento em que o sistema está instável é justamente
       * quando ninguém está olhando o log. Por réplica ainda é N× o teto, mas
       * é finito.
       */
      const agora = Date.now();
      if (agora - this.avisadoEm > 60_000) {
        this.avisadoEm = agora;
        this.logger.error(
          "Freio compartilhado indisponível: contando por réplica até o banco voltar. " +
            `O teto efetivo de '${nome}' passa a ser ${limite} POR instância da API.`,
        );
      }
      return this.local.increment(chave, ttl, limite, bloqueio, nome);
    }

    return {
      totalHits: registro.ocorrencias,
      timeToExpire: registro.expiraEmSegundos,
      isBlocked: registro.bloqueado,
      timeToBlockExpire: registro.bloqueioEmSegundos,
    };
  }

  private exigeContagemCompartilhada(nome: string, limite: number): boolean {
    const global = this.tetosGlobais.get(nome);
    return global !== undefined && limite < global;
  }

  /**
   * O contador em memória agenda um `setTimeout` por acerto. Sem limpá-los o
   * processo não termina no shutdown — e o Render mata quem não sai sozinho,
   * transformando todo deploy num encerramento à força.
   */
  onApplicationShutdown(): void {
    this.local.onApplicationShutdown();
  }
}
