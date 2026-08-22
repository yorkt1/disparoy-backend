/**
 * Limites operacionais por empresa — os números, num lugar só.
 *
 * O worker é UM processo com UMA fila, e todos os clientes disputam essa fila.
 * Sem teto, um cliente que importa 300 mil contatos ocupa o worker por dias e
 * os outros não recebem erro nenhum: as campanhas deles ficam "em andamento" a
 * 0%, com a fila no ar e o worker batendo pulso. É a falha mais difícil de
 * diagnosticar do produto, porque nada parece quebrado.
 *
 * NÃO é billing e não pretende virar. Não há preço, fatura nem gateway de
 * pagamento aqui, e nada disto está no caminho para haver. O que existe é a
 * proteção operacional e um ROTULO de plano (`empresas.plano`) que permite,
 * amanhã, um cliente ter números diferentes sem mexer em código nenhum além
 * deste arquivo.
 *
 * Por que os números moram em TypeScript e não no banco: teto é regra de
 * negócio, e regra de negócio dividida entre uma tabela e um arquivo diverge —
 * a mesma razão de `comum/escopo.ts` existir em vez de um `.eq("empresa_id")`
 * repetido em cada serviço. O banco guarda o CONSUMO, que precisa ser atômico
 * e compartilhado entre processos (`empresa_cotas`); o teto fica aqui, onde é
 * legível, testável e versionado junto do código que o aplica.
 */

export interface LimitesEmpresa {
  /**
   * Mensagens que a empresa pode ENVIAR por dia, somando todas as campanhas e
   * canais. `null` é sem teto.
   *
   * Conta MENSAGEM, não contato: uma sequência de 3 passos para 100 pessoas
   * são 300. É o número que pesa no worker e no gateway, e é o que o
   * destinatário recebe.
   */
  mensagensPorDia: number | null;
  /** Canais (números de WhatsApp) que a empresa pode manter. `null` é sem teto. */
  canais: number | null;
  /**
   * Campanhas ao mesmo tempo em estado que consome fila — `em_andamento`,
   * `agendada` e `pausada_por_canal` (esta última volta sozinha quando o canal
   * reconecta, então ela ainda é trabalho reservado). `null` é sem teto.
   */
  campanhasSimultaneas: number | null;
  /**
   * Quantos contatos um único job de planejamento reserva por vez.
   *
   * É o freio que impede uma campanha grande de monopolizar o worker: com
   * 200 mil contatos e sem teto, um planejamento só devolve 200 mil ids,
   * segura a fila enquanto insere e deixa toda outra campanha esperando. O
   * resto sai no ciclo seguinte — `campanhas_a_replanejar` roda de minuto em
   * minuto e enxerga exatamente "pendente sem job".
   *
   * Nunca `null`: sem teto aqui é o caso que este campo existe para impedir.
   */
  contatosPorPlanejamento: number;
}

export const PLANO_PADRAO = "padrao";

/**
 * O mapa de planos. Dois, de propósito.
 *
 * `padrao` é o que toda empresa recebe (`empresas.plano` tem esse default).
 * `interno` existe para a operação do próprio Disparoy e para o cliente que
 * negociar volume fora da faixa — é o escape que evita a tentação de subir o
 * teto de todo mundo por causa de um caso.
 *
 * Os números do `padrao` saem do que UM worker aguenta, não de uma tabela de
 * preços: com o intervalo padrão de 15–45 s entre contatos, uma campanha leva
 * ~25 h para 3 mil pessoas. 10 mil mensagens/dia por empresa já é mais do que
 * um cliente consegue escoar sozinho, e é baixo o bastante para três clientes
 * simultâneos não estourarem o gateway.
 */
export const LIMITES_POR_PLANO: Record<string, LimitesEmpresa> = {
  [PLANO_PADRAO]: {
    mensagensPorDia: 10_000,
    canais: 5,
    campanhasSimultaneas: 3,
    contatosPorPlanejamento: 2_000,
  },
  interno: {
    mensagensPorDia: null,
    canais: null,
    campanhasSimultaneas: null,
    // Sem teto aqui seria voltar ao comportamento antigo; 10 mil é folga
    // suficiente para não paginar em campanha nenhuma que exista hoje.
    contatosPorPlanejamento: 10_000,
  },
};

/**
 * Os limites de um rótulo de plano.
 *
 * Rótulo desconhecido cai no `padrao` em vez de estourar: a coluna é `text`
 * livre justamente para receber um valor novo antes de o deploy que o conhece
 * estar no ar, e um erro aqui derrubaria o disparo de um cliente por causa de
 * uma string.
 */
export function limitesDoPlano(plano: string | null | undefined): LimitesEmpresa {
  return LIMITES_POR_PLANO[plano ?? PLANO_PADRAO] ?? LIMITES_POR_PLANO[PLANO_PADRAO];
}

/** Texto para o operador quando um teto é atingido. Um só, para não divergir. */
export function explicarLimite(
  recurso: "mensagens" | "canais" | "campanhas",
  limite: number,
): string {
  switch (recurso) {
    case "mensagens":
      return (
        `Limite diário de ${limite.toLocaleString("pt-BR")} mensagens atingido para esta empresa. ` +
        `Os envios restantes continuam na fila e seguem automaticamente amanhã — ` +
        `nada foi perdido. Fale com o suporte se precisar de um volume maior.`
      );
    case "canais":
      return (
        `Esta empresa já tem ${limite} canal(is), que é o limite do plano atual. ` +
        `Remova um canal que não use ou fale com o suporte para ampliar.`
      );
    case "campanhas":
      return (
        `Esta empresa já tem ${limite} campanha(s) ativa(s) ao mesmo tempo, que é o limite ` +
        `do plano atual. Aguarde uma concluir, ou pause uma, antes de iniciar outra.`
      );
  }
}
