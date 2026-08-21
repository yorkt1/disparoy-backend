import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { SupabaseService } from "../supabase/supabase.service";

/**
 * Freios que valem para as DUAS réplicas da API, não para uma só.
 *
 * O contador do `ThrottlerModule` vive na memória do processo, e a API roda
 * com `numInstances: 2` (ver `render.yaml`). Todo teto escrito no código valia
 * por réplica: "10 tentativas de login por minuto" eram 20 de verdade, e
 * viraram 30 no dia em que alguém subir a terceira instância — sem uma linha de
 * código mudar. Este serviço move a contagem para o Postgres, que as réplicas
 * já compartilham.
 *
 * Ele NÃO é usado em toda requisição de propósito: ver o comentário em
 * `freio-armazenamento.ts`.
 */

/** O que `consumir_freio` devolve, já em nomes de código. */
export interface RegistroDeFreio {
  ocorrencias: number;
  /** Segundos até a janela de contagem virar. */
  expiraEmSegundos: number;
  bloqueado: boolean;
  /** Segundos até o bloqueio acabar. Zero quando não há bloqueio. */
  bloqueioEmSegundos: number;
}

/**
 * Falhas de login toleradas na janela antes de trancar a conta.
 *
 * Dez é folgado para quem está só errando a senha (o painel não tem "esqueci
 * minha senha": quem se tranca depende de um admin, e transformar erro de
 * digitação em chamado seria pior do que o ataque). É apertado para quem
 * varre: uma lista de senhas comuns tem centenas de linhas, não dez.
 */
export const FALHAS_ATE_TRANCAR_CONTA = 10;
const JANELA_DE_FALHAS_MS = 15 * 60_000;
const DURACAO_DO_BLOQUEIO_MS = 15 * 60_000;

@Injectable()
export class FreioService {
  private readonly logger = new Logger(FreioService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Conta uma ocorrência da chave e devolve o veredito.
   *
   * `null` significa que o banco não respondeu — quem chama decide o que fazer,
   * porque a resposta certa depende do que está sendo freado. Engolir a falha
   * aqui e devolver "liberado" transformaria uma queda do banco em rate limit
   * desligado sem ninguém saber.
   */
  async consumir(
    chave: string,
    ttlMs: number,
    limite: number,
    bloqueioMs: number,
  ): Promise<RegistroDeFreio | null> {
    const { data, error } = await this.supabase.db.rpc("consumir_freio", {
      p_chave: chave,
      p_ttl_ms: ttlMs,
      p_limite: limite,
      p_bloqueio_ms: bloqueioMs,
    });

    if (error) {
      this.logger.error(`Freio compartilhado indisponível: ${error.message}`);
      return null;
    }

    // `returns table` chega como lista de uma linha só.
    const linha = (data as LinhaFreio[] | null)?.[0];
    if (!linha) return null;

    return {
      ocorrencias: linha.total,
      expiraEmSegundos: linha.janela_segundos,
      bloqueado: linha.bloqueado,
      bloqueioEmSegundos: linha.bloqueio_segundos,
    };
  }

  /**
   * Segundos que faltam do bloqueio desta conta. Zero = pode tentar.
   *
   * Falha de banco devolve zero — libera. Não é descuido: o login LÊ `perfis`
   * logo depois, então banco fora significa login falhando de qualquer jeito.
   * Recusar aqui só trocaria a mensagem de erro, e um freio que derruba o
   * sistema inteiro quando ele mesmo cai não é uma proteção, é um segundo
   * ponto de falha.
   */
  async loginBloqueadoPor(email: string): Promise<number> {
    const { data, error } = await this.supabase.db.rpc("estado_do_freio", {
      p_chave: chaveDeLogin(email),
    });

    if (error) {
      this.logger.error(`Não foi possível conferir o bloqueio da conta: ${error.message}`);
      return 0;
    }
    return Number(data ?? 0);
  }

  /**
   * Registra um login falho para esta conta.
   *
   * A chave é o e-mail TENTADO, exista a conta ou não. É o que permite ao
   * `sessao.service` responder igual nos dois casos: se só e-mail existente
   * fosse contado, a diferença entre "bloqueado" e "senha errada" viraria um
   * oráculo de quais endereços estão na base — exatamente o que a mensagem
   * única de erro e a derivação de scrypt em tempo constante existem para
   * evitar.
   */
  async registrarFalhaDeLogin(email: string): Promise<void> {
    await this.consumir(
      chaveDeLogin(email),
      JANELA_DE_FALHAS_MS,
      FALHAS_ATE_TRANCAR_CONTA,
      DURACAO_DO_BLOQUEIO_MS,
    );
  }

  /** Login que deu certo apaga o histórico de falhas da conta. */
  async limparFalhasDeLogin(email: string): Promise<void> {
    const { error } = await this.supabase.db.rpc("limpar_freio", {
      p_chave: chaveDeLogin(email),
    });
    if (error) this.logger.warn(`Não foi possível limpar o freio da conta: ${error.message}`);
  }
}

interface LinhaFreio {
  total: number;
  janela_segundos: number;
  bloqueado: boolean;
  bloqueio_segundos: number;
}

/**
 * `login:<sha256 do e-mail normalizado>`.
 *
 * Hasheado porque `freios` é escrita pela rota de login, que é pública e sem
 * sessão: guardar o e-mail em claro criaria uma tabela de endereços tentados
 * alimentada por qualquer um da internet. O `toLowerCase()` acompanha o
 * `email.trim().toLowerCase()` do login — sem isso `Fulano@x.com` e
 * `fulano@x.com` seriam contas diferentes para o freio e iguais para o banco,
 * e dez tentativas viravam vinte só alternando a caixa das letras.
 */
export function chaveDeLogin(email: string): string {
  const alvo = email.trim().toLowerCase();
  return `login:${createHash("sha256").update(alvo).digest("hex")}`;
}
