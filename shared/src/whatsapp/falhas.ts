/**
 * Taxonomia de falha de envio.
 *
 * Existe porque, até aqui, toda falha virava texto livre gravado em
 * `mensagens_enviadas.erro`. Texto livre não agrupa, não filtra e não vira
 * alerta — e por isso "o WhatsApp do cliente desconectou" e "nosso worker
 * quebrou" chegavam iguais na tela do operador, que só conseguia concluir a
 * única coisa que os dados permitiam: que o sistema quebrou.
 *
 * A união é FECHADA de propósito. Com `codigo` obrigatório em `ResultadoEnvio`,
 * o compilador recusa qualquer caminho de falha que não classifique — é o que
 * impede o problema de voltar por descuido daqui a seis meses.
 *
 * O texto original nunca é descartado: o código classifica, não substitui.
 * Quando um caso novo cair em `desconhecido`, é o texto bruto guardado que
 * permite escrever a regra nova.
 */

export type CategoriaFalha =
  /** O WhatsApp do cliente: desconectou, foi banido, perdeu a sessão. */
  | "canal"
  /** O número de destino: não existe, bloqueou, recusou. */
  | "destinatario"
  /** Evolution, rede, nosso host. Não é culpa de ninguém do lado do cliente. */
  | "infra"
  /** Credencial ou URL faltando. Culpa nossa, mas de instalação. */
  | "configuracao"
  /** A mensagem em si foi recusada: mídia, template, texto. */
  | "conteudo"
  /** Cota atingida. Não é erro: é a proteção anti-bloqueio funcionando. */
  | "limite";

export type CodigoFalha =
  | "canal_desconectado"
  | "canal_banido"
  | "canal_sem_sessao"
  | "numero_inexistente"
  | "numero_recusou"
  | "gateway_indisponivel"
  | "gateway_timeout"
  | "gateway_sobrecarregado"
  | "resposta_sem_id"
  | "provedor_nao_configurado"
  | "credencial_invalida"
  | "canal_mal_configurado"
  | "midia_invalida"
  | "conteudo_recusado"
  | "template_obrigatorio"
  | "template_rejeitado"
  | "cota_diaria_atingida"
  | "desconhecido";

export interface PerfilFalha {
  categoria: CategoriaFalha;
  /** Vale a pena tentar de novo, ou é definitivo? */
  retentavel: boolean;
  /**
   * Deve parar a campanha inteira, em vez de queimar só este contato?
   *
   * `true` significa que a causa afeta todos os próximos envios igualmente —
   * insistir só transformaria uma falha em cinco mil.
   */
  paraCampanha: boolean;
  /** Texto para o operador. `{canal}` e `{detalhe}` são substituídos. */
  mensagem: string;
}

export const FALHAS: Record<CodigoFalha, PerfilFalha> = {
  canal_desconectado: {
    categoria: "canal",
    retentavel: false,
    paraCampanha: true,
    mensagem: "O WhatsApp de {canal} desconectou. Escaneie o QR Code novamente para retomar.",
  },
  canal_banido: {
    categoria: "canal",
    retentavel: false,
    paraCampanha: true,
    mensagem: "O número de {canal} foi banido pelo WhatsApp. Será preciso usar outro número.",
  },
  canal_sem_sessao: {
    categoria: "canal",
    retentavel: false,
    paraCampanha: true,
    mensagem: "A instância de {canal} não está pareada. Conecte pelo QR Code.",
  },
  numero_inexistente: {
    categoria: "destinatario",
    retentavel: false,
    paraCampanha: false,
    mensagem: "Este número não tem WhatsApp.",
  },
  numero_recusou: {
    categoria: "destinatario",
    retentavel: false,
    paraCampanha: false,
    mensagem: "O contato bloqueou este número.",
  },
  gateway_indisponivel: {
    categoria: "infra",
    retentavel: true,
    paraCampanha: true,
    mensagem:
      "O servidor de envio está fora do ar. Não é problema do seu WhatsApp — " +
      "as campanhas retomam sozinhas quando ele voltar.",
  },
  gateway_timeout: {
    categoria: "infra",
    retentavel: true,
    paraCampanha: true,
    mensagem: "O servidor de envio não respondeu a tempo. Tentando novamente.",
  },
  gateway_sobrecarregado: {
    categoria: "infra",
    retentavel: true,
    paraCampanha: false,
    mensagem: "Servidor sobrecarregado. Reduzindo o ritmo do disparo.",
  },
  resposta_sem_id: {
    categoria: "infra",
    retentavel: true,
    paraCampanha: false,
    // Sem id externo o webhook nunca acha esta mensagem para marcar entregue:
    // ela ficaria "enviada" para sempre no relatório.
    mensagem: "O gateway aceitou a mensagem mas não devolveu o id de rastreio.",
  },
  provedor_nao_configurado: {
    categoria: "configuracao",
    retentavel: false,
    paraCampanha: true,
    mensagem: "A integração de envio não está configurada.",
  },
  credencial_invalida: {
    categoria: "configuracao",
    retentavel: false,
    paraCampanha: true,
    mensagem: "A chave de acesso do gateway foi recusada. Verifique a configuração.",
  },
  canal_mal_configurado: {
    categoria: "configuracao",
    retentavel: false,
    paraCampanha: true,
    mensagem: "Falta configuração neste canal: {detalhe}",
  },
  midia_invalida: {
    categoria: "conteudo",
    retentavel: false,
    paraCampanha: false,
    mensagem: "O arquivo foi recusado: {detalhe}",
  },
  conteudo_recusado: {
    categoria: "conteudo",
    retentavel: false,
    paraCampanha: false,
    mensagem: "A mensagem foi recusada: {detalhe}",
  },
  template_obrigatorio: {
    categoria: "conteudo",
    retentavel: false,
    // Para a campanha: se um passo exige template e não tem, todos os contatos
    // vão falhar no mesmo ponto. É defeito de configuração da campanha.
    paraCampanha: true,
    mensagem: "Este passo precisa de um template aprovado pela Meta.",
  },
  template_rejeitado: {
    categoria: "conteudo",
    retentavel: false,
    paraCampanha: true,
    mensagem: "A Meta recusou o template usado nesta campanha: {detalhe}",
  },
  cota_diaria_atingida: {
    categoria: "limite",
    retentavel: true,
    paraCampanha: false,
    mensagem: "O limite diário de {canal} foi atingido. O envio continua amanhã.",
  },
  desconhecido: {
    categoria: "infra",
    retentavel: true,
    paraCampanha: false,
    mensagem: "Falha não classificada: {detalhe}",
  },
};

/** Frase pronta para a tela, com o nome do canal e o detalhe já dentro. */
export function explicar(
  codigo: CodigoFalha,
  ctx: { canal?: string; detalhe?: string } = {},
): string {
  return FALHAS[codigo].mensagem
    .replace("{canal}", ctx.canal ?? "o canal")
    .replace("{detalhe}", ctx.detalhe ?? "sem detalhe informado");
}

export function categoriaDe(codigo: CodigoFalha): CategoriaFalha {
  return FALHAS[codigo].categoria;
}

/** Falha que exige parar a campanha em vez de só marcar o contato. */
export function paraCampanha(codigo: CodigoFalha): boolean {
  return FALHAS[codigo].paraCampanha;
}

/**
 * Classifica uma resposta da Evolution API.
 *
 * `status: 0` significa que o fetch nem chegou a receber resposta. É o sinal
 * mais importante do sistema inteiro, porque é ele que distingue "a VPS da
 * Evolution caiu" (culpa nossa) de qualquer coisa que o WhatsApp do cliente
 * tenha feito. Antes ele virava a string genérica "Falha ao falar com a
 * Evolution API", sem código — o dado mais valioso era o que menos informação
 * carregava. Por isso é o primeiro caso tratado aqui.
 */
export function classificarEvolution(status: number, detalhe: string): CodigoFalha {
  const d = detalhe.toLowerCase();

  if (status === 0) {
    return /timeout|abort|etimedout|timedout/.test(d) ? "gateway_timeout" : "gateway_indisponivel";
  }
  if (status === 408) return "gateway_timeout";
  if (status === 429) return "gateway_sobrecarregado";
  if (status === 401 || status === 403) return "credencial_invalida";
  // 404 numa rota /message/send ou /instance significa instância inexistente.
  if (status === 404) return "canal_sem_sessao";
  if (status >= 500) return "gateway_indisponivel";

  if (/connection (closed|lost)|not connected|no session|closed by|logged out/.test(d)) {
    return "canal_desconectado";
  }
  if (/banned|forbidden device|account.*(blocked|banned)/.test(d)) return "canal_banido";
  if (/not.*(exist|valid).*whatsapp|number.*not.*found|exists.*false|invalid.*jid/.test(d)) {
    return "numero_inexistente";
  }
  if (/mediatype|media|mimetype|file|upload/.test(d)) return "midia_invalida";

  /*
   * 4xx sem regra que case é DESCONHECIDO, não "conteúdo recusado".
   *
   * O fallback antigo rotulava todo 4xx não reconhecido como
   * `conteudo_recusado` — um palpite de aparência confiante. O efeito colateral
   * era pior que o erro em si: essas falhas nunca apareciam no balde "sem
   * classificação", então a Cobertura da Taxonomia marcava 100% enquanto parte
   * dela era chute, e a tela de Diagnóstico deixava de apontar exatamente as
   * regras que faltavam escrever.
   *
   * `desconhecido` é honesto e mostra o texto bruto para virar regra nova.
   */
  return "desconhecido";
}

/**
 * Classifica uma resposta da Graph API da Meta.
 *
 * Separada da Evolution porque os vocabulários não coincidem: a Meta fala em
 * template e janela de 24 h, a Evolution fala em sessão e instância. Uma função
 * só para as duas acabaria classificando errado nos dois lados.
 */
export function classificarMeta(status: number, detalhe: string): CodigoFalha {
  const d = detalhe.toLowerCase();

  if (status === 0) {
    return /timeout|abort|etimedout|timedout/.test(d) ? "gateway_timeout" : "gateway_indisponivel";
  }
  if (status === 408) return "gateway_timeout";
  if (status === 429) return "gateway_sobrecarregado";
  if (status === 401 || status === 403) return "credencial_invalida";
  if (status >= 500) return "gateway_indisponivel";

  if (/template/.test(d)) return "template_rejeitado";
  if (/re-?engagement|24 ?hour|outside.*window|message.*window/.test(d)) return "conteudo_recusado";
  if (/not.*(exist|valid).*whatsapp|invalid.*recipient|recipient.*not/.test(d)) {
    return "numero_inexistente";
  }
  if (/media|mime|file|upload/.test(d)) return "midia_invalida";

  // Mesmo raciocínio da Evolution: chute confiante esconde a regra que falta.
  return "desconhecido";
}
