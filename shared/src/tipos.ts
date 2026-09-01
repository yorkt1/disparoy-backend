/**
 * Tipos de domínio do DisparoY.
 *
 * Sistema interno single-tenant: um negócio, vários logins. O que separa o que
 * cada um enxerga é o PAPEL (admin/operator) e, nos canais, o vínculo em
 * `canal_membros`.
 *
 * Datas trafegam como ISO-8601 (string) para atravessar a fronteira
 * servidor -> cliente sem perder informação na serialização.
 */

// --------------------------------------------------------------------------
// Usuários e papéis
// --------------------------------------------------------------------------

export type Papel = "admin" | "operator";

export interface Usuario {
  id: string;
  nome: string;
  email: string;
  papel: Papel;
  ativo: boolean;
  criadoEm: string;
}

export const ROTULO_PAPEL: Record<Papel, string> = {
  admin: "Administrador",
  operator: "Operador",
};

// --------------------------------------------------------------------------
// Canais (instâncias de WhatsApp)
// --------------------------------------------------------------------------

/**
 * `qrcode` = número pareado por QR Code na Evolution API: texto livre, sem
 * tarifa por mensagem, porém sujeito a bloqueio pela Meta.
 * `api_oficial` = WhatsApp Business API: só templates aprovados, com tarifa.
 */
export type TipoConexao = "qrcode" | "api_oficial";

export type StatusCanal = "conectado" | "desconectado" | "aguardando_qr" | "banido";

export type PermissaoCanal = "owner" | "operator" | "viewer";

/**
 * O que o gateway respondeu quando foi perguntado sobre a sessão.
 *
 * Mora neste módulo base, e não no do provedor, porque o painel precisa do
 * mesmo vocabulário para renderizar — e `whatsapp/tipos.ts` já importa daqui,
 * então o caminho contrário fecharia um ciclo.
 *
 * `indisponivel` NÃO é sinônimo de `close`. Um diz "não consegui perguntar"
 * (problema nosso), o outro diz "perguntei, e a sessão caiu" (WhatsApp do
 * cliente). Colapsar os dois é acusar o cliente de um defeito nosso.
 */
export type EstadoGateway = "open" | "close" | "connecting" | "indisponivel";

export interface Canal {
  id: string;
  nome: string;
  /**
   * E.164, ou `null` enquanto o canal não pareou.
   *
   * Preenchido pelo webhook a partir do `ownerJid` que a Evolution reporta —
   * é o número que de fato escaneou o QR, não o que alguém digitou.
   */
  numero: string | null;
  /** Nome da instância na Evolution API — chave que o webhook usa. */
  instanciaEvolution: string;
  tipoConexao: TipoConexao;
  status: StatusCanal;
  /**
   * Teto de mensagens por dia, ou `null` para sem limite.
   *
   * Nasceu como proteção anti-bloqueio de número novo. Virou opcional porque o
   * dono do número decide o próprio risco — e um teto de 50 fazia uma campanha
   * de mil contatos levar vinte dias sem ninguém ter pedido isso.
   *
   * `null` é diferente de `0`: zero seria "não pode enviar nada".
   */
  limiteDiario: number | null;
  /** 0 = número novo. Sobe conforme o número amadurece. */
  estagioAquecimento: number;
  enviadasHoje: number;
  solicitadoEm: string;
  conectadoEm: string | null;
  /**
   * O que o gateway respondeu na última vez em que foi PERGUNTADO.
   *
   * `status` acima é cache do webhook, e webhook é a primeira coisa que morre
   * quando algo dá errado — VPS caída, webhook nunca registrado, evento perdido
   * num 429. Estes dois campos existem para a tela poder dizer "conectado, e eu
   * confirmei há 40 segundos" em vez de repetir um cache de três dias atrás
   * como se fosse fato.
   *
   * Nulo significa NUNCA conferido. Não é o mesmo que desconectado, e a tela
   * precisa tratar os dois de forma diferente.
   */
  estadoGateway: EstadoGateway | null;
  estadoVerificadoEm: string | null;
  /**
   * Foto de perfil do número, guardada no nosso Storage.
   *
   * Não é o link do WhatsApp: aquele expira sozinho, e a tela passaria a
   * mostrar imagem quebrada sem nada ter acontecido. `null` é legítimo —
   * número sem foto, ou foto ainda não baixada.
   */
  fotoUrl: string | null;
  metaPhoneNumberId?: string;
}

export interface MembroCanal {
  canalId: string;
  perfilId: string;
  nome: string;
  permissao: PermissaoCanal;
}

/**
 * Quanto do teto diário do canal já foi consumido (0..100).
 *
 * `null` quando não há teto: sem limite não existe "percentual consumido", e
 * devolver 0 faria uma barra de progresso vazia sugerir que ainda há muito a
 * usar de um limite que não existe.
 */
export function consumoDoCanal(canal: Canal): number | null {
  if (canal.limiteDiario === null) return null;
  if (canal.limiteDiario <= 0) return 100;
  return Math.min(Math.round((canal.enviadasHoje / canal.limiteDiario) * 100), 100);
}

// --------------------------------------------------------------------------
// Contatos e listas
// --------------------------------------------------------------------------

export interface Contato {
  id: string;
  nome: string | null;
  telefone: string; // E.164
  tags: string[];
  /** Consentimento registrado. Sem ele o contato não entra em campanha. */
  optIn: boolean;
  optInOrigem: string | null;
  optInEm: string | null;
  /** Preenchido quando o contato pede saída; vale mais que `optIn`. */
  optOutEm: string | null;
  optOutMotivo: string | null;
  /** Colunas extras da planilha, usadas como variáveis do template. */
  variaveis: Record<string, string>;
  criadoEm: string;
}

/**
 * Um contato só pode receber campanha com consentimento registrado e sem
 * pedido de saída. Vale nos dois lados: a API valida, e o banco também.
 */
export function podeReceberCampanha(c: Contato): boolean {
  return c.optIn && c.optOutEm === null;
}

export type MotivoInelegivel = "sem_opt_in" | "pediu_saida";

export function motivoInelegivel(c: Contato): MotivoInelegivel | null {
  if (c.optOutEm !== null) return "pediu_saida";
  if (!c.optIn) return "sem_opt_in";
  return null;
}

export const ROTULO_INELEGIVEL: Record<MotivoInelegivel, string> = {
  sem_opt_in: "Sem consentimento registrado",
  pediu_saida: "Pediu para sair da lista",
};

export interface Lista {
  id: string;
  nome: string;
  descricao: string | null;
  totalContatos: number;
  /** Quantos podem legalmente receber agora — o número que importa. */
  totalElegiveis: number;
  criadaEm: string;
}

// --------------------------------------------------------------------------
// Templates (WhatsApp Business API oficial)
// --------------------------------------------------------------------------

export type CategoriaTemplate = "marketing" | "utilidade" | "autenticacao";
export type StatusTemplate = "aprovado" | "pendente" | "rejeitado" | "pausado";

export interface Template {
  id: string;
  nome: string;
  categoria: CategoriaTemplate;
  status: StatusTemplate;
  idioma: string;
  corpo: string;
  variaveis: number;
  atualizadoEm: string;
  metaTemplateId?: string;
}

// --------------------------------------------------------------------------
// Spintax (variações)
// --------------------------------------------------------------------------

/**
 * Lista salva de variações de texto. No corpo da mensagem é referenciada
 * como {{*nome*}} e sorteada a cada envio, para que dois contatos não recebam
 * texto idêntico.
 */
export interface Spintax {
  id: string;
  nome: string;
  opcoes: string[];
  criadoEm: string;
}

// --------------------------------------------------------------------------
// Campanhas
// --------------------------------------------------------------------------

export type TipoMensagem = "texto" | "midia";
export type TipoMidia = "imagem" | "video" | "documento" | "audio";

export interface MensagemSequencia {
  id: string;
  tipo: TipoMensagem;
  corpo: string;
  midia?: {
    tipo: TipoMidia;
    url: string;
    nomeArquivo: string;
  };
  /** Preenchido quando o passo usa um template aprovado da Meta. */
  templateId?: string;
}

export interface IntervaloAleatorio {
  minSegundos: number;
  maxSegundos: number;
}

export type StatusCampanha =
  | "rascunho"
  | "agendada"
  | "em_andamento"
  | "pausada"
  /**
   * Pausada pelo SISTEMA, não por uma pessoa.
   *
   * Distinta de `pausada` porque só ela pode ser retomada automaticamente
   * quando o canal voltar. Retomar sozinho o que alguém pausou de propósito
   * seria a pior surpresa possível num sistema que fala com gente de verdade.
   *
   * O motivo fica em `campanhas.pausada_motivo`, já em linguagem de operador.
   */
  | "pausada_por_canal"
  | "concluida"
  | "falhou";

export type StatusContatoCampanha =
  | "pendente"
  | "validando"
  | "invalido"
  | "enviando"
  | "concluido"
  | "falhou"
  | "bloqueado";

export interface MetricasCampanha {
  total: number;
  enviadas: number;
  entregues: number;
  lidas: number;
  falhas: number;
  respostas: number;
}

export interface Campanha {
  id: string;
  nome: string;
  status: StatusCampanha;
  listaId: string | null;
  listaNome: string | null;
  canaisIds: string[];
  sequencia: MensagemSequencia[];
  intervaloEntreContatos: IntervaloAleatorio;
  intervaloEntreMensagens: IntervaloAleatorio;
  validarNumeros: boolean;
  agendadaPara: string | null;
  criadaEm: string;
  iniciadaEm: string | null;
  concluidaEm: string | null;
  metricas: MetricasCampanha;
  templatePrincipal: string | null;
  /**
   * Por que o SISTEMA parou a campanha, em linguagem de operador.
   *
   * Preenchido quando `status === "pausada_por_canal"` (o canal caiu) e quando
   * `status === "falhou"` por agendamento expirado — a hora passou e o disparo
   * não começou. É o texto que a faixa da tela mostra; sem ele, a campanha
   * pararia sozinha e a tela não teria como dizer o motivo, que era exatamente
   * o problema original.
   *
   * O nome ficou de quando só a pausa por canal escrevia aqui. Trocá-lo
   * custaria uma migration, o mapeador e as duas cópias de `shared/` — e a
   * coluna significa a mesma coisa nos dois casos: "o sistema parou isto, e
   * aqui está o porquê, em português".
   */
  pausadaMotivo: string | null;
}

/** Campanha sem a sequência — payload leve para tabelas. */
export type ResumoCampanha = Omit<Campanha, "sequencia"> & {
  totalMensagens: number;
  progresso: number; // 0..100
};

/** Amostra de contato exibida no detalhe da campanha. */
/**
 * Até onde este contato chegou na campanha.
 *
 * É uma escada, não um conjunto de rótulos soltos: cada degrau implica os
 * anteriores, e o valor é sempre o ponto mais avançado alcançado. É o que
 * permite a tela ter um filtro por vez em vez de três caixinhas combinadas.
 *
 * **A regra NÃO mora aqui.** Ela é a coluna gerada `campanha_contatos.situacao`
 * (migration `20260826000200`), porque filtrar e contar 20 mil contatos só
 * acontece no banco — uma segunda cópia em TypeScript seria a que diverge e
 * faz o total do filtro não bater com a lista embaixo dele. Este tipo existe
 * para o painel saber o que pode chegar; quem decide é o Postgres.
 *
 *  - `pendente`  — ainda não saiu (inclui validando e enviando)
 *  - `falhou`    — não chegou (falha, número inválido, bloqueado)
 *  - `enviado`   — saiu, sem confirmação de leitura
 *  - `lido`      — leu e não respondeu
 *  - `respondeu` — respondeu, com ou sem recibo de leitura
 */
export type SituacaoContato = "pendente" | "falhou" | "enviado" | "lido" | "respondeu";

/**
 * O que veio de volta. Mídia não tem texto: o que informa é o `tipo`, e a tela
 * mostra "[áudio]" em vez de uma linha em branco que se lê como "não respondeu".
 */
export type TipoResposta =
  | "texto"
  | "imagem"
  | "audio"
  | "video"
  | "documento"
  | "figurinha"
  | "outro";

export interface RespostaRecebida {
  texto: string;
  tipo: TipoResposta;
  recebidaEm: string;
}

/**
 * Quantas respostas por contato a lista da campanha carrega.
 *
 * Uma, porque resposta de campanha é uma: a migration
 * `20260901000100_resposta_uma_por_contato` faz `registrar_resposta` guardar a
 * PRIMEIRA e descartar o resto. O que vinha depois não respondia a disparo
 * nenhum — era a conversa seguindo, creditada à campanha para sempre porque a
 * busca não tinha janela nem teto.
 *
 * O corte continua existindo, e não virou 1 por acaso: o histórico anterior à
 * migration não foi limpo, e sem ele um contato com 34 linhas antigas
 * despejaria as 34 na tela.
 */
export const MAX_RESPOSTAS_NA_LISTA = 1;

export interface ContatoDaCampanha {
  id: number;
  contatoId: string;
  nome: string | null;
  telefone: string;
  status: StatusContatoCampanha;
  situacao: SituacaoContato;
  /** Primeira leitura confirmada pelo WhatsApp. `null` enquanto não houve. */
  lidaEm: string | null;
  /**
   * Se o contato respondeu: 0 ou 1.
   *
   * Era "quantas mensagens ele mandou de volta", e crescia sem limite — o
   * bate-papo dos meses seguintes ao disparo entrava aqui, porque
   * `registrar_resposta` creditava à campanha tudo o que chegasse daquele
   * número. Contatos com 34 "respostas" cujo texto era `[figurinha]` e `jkkkk`
   * foram o que denunciou. Vale para o que chegou depois da migration
   * `20260901000100`; campanhas mais antigas guardam o número inflado.
   */
  respostas: number;
  /**
   * O TEXTO da resposta, cortado em `MAX_RESPOSTAS_NA_LISTA`.
   *
   * O painel contava respostas e nunca mostrava nenhuma: o texto existia em
   * `respostas_recebidas` desde a migration `20260826000100` e só saía pelo
   * CSV do relatório. Quem disparava via "3" na coluna e tinha de baixar uma
   * planilha para descobrir que uma delas era "pode me ligar agora?".
   *
   * Vazio não quer dizer "não respondeu" — quer dizer que esta consulta não
   * carregou o texto (lista antiga, campanha sem resposta). Quem responde
   * "respondeu?" é `situacao`.
   *
   * **Opcional de propósito.** A API sempre manda (`[]` quando não há), mas
   * painel e API sobem separado — Vercel e Render —, então há sempre uma
   * janela em que a tela nova conversa com o servidor antigo e o campo chega
   * `undefined`. Declarar obrigatório fazia a tela inteira cair no limite de
   * erro com "Cannot read properties of undefined (reading 'length')": o
   * operador perdia a lista de contatos completa por causa de um campo
   * acessório. Assim o compilador exige o `?? []` em cada leitura.
   */
  ultimasRespostas?: RespostaRecebida[];
  motivo: string | null;
  variaveis: Record<string, string>;
}

/** Quantos contatos há em cada situação. Ausente quer dizer zero. */
export type ResumoSituacao = Partial<Record<SituacaoContato, number>>;

// --------------------------------------------------------------------------
// Mensagens e webhooks
// --------------------------------------------------------------------------

export type StatusMensagem = "enfileirada" | "enviada" | "entregue" | "lida" | "falhou";

/** Eventos da Evolution API que o sistema assina. */
export type EventoEvolution =
  | "QRCODE_UPDATED"
  | "CONNECTION_UPDATE"
  | "SEND_MESSAGE"
  | "MESSAGES_UPDATE"
  | "MESSAGES_UPSERT";

// --------------------------------------------------------------------------
// Logs de auditoria
// --------------------------------------------------------------------------

export type AcaoLog =
  | "campanha.criada"
  | "campanha.iniciada"
  | "campanha.pausada"
  | "campanha.concluida"
  /** Encerrada à força por ter ficado "em andamento" sem worker que a executasse. */
  | "campanha.abandonada"
  /**
   * A hora do agendamento passou e o disparo não começou dentro da tolerância.
   *
   * Separada de `campanha.abandonada` porque o estado é outro e a conversa com
   * o cliente também: abandonada estava `em_andamento` e parou no meio, esta
   * nunca saiu do lugar — nenhuma mensagem foi enviada. Quem investiga "por
   * que o cliente não recebeu nada ontem" precisa ver a diferença.
   */
  | "campanha.agendamento_expirado"
  | "campanha.rascunho_salvo"
  | "campanha.editada"
  /**
   * Cópia criada a partir de outra campanha.
   *
   * Separada de `campanha.criada` porque a pergunta que ela responde é outra:
   * "de onde saiu esta lista?". A cópia leva o público inteiro do original —
   * telefone e variáveis de gente real — sem ninguém reimportar planilha
   * nenhuma, e `detalhes.origem` é o único registro de qual campanha o cedeu.
   */
  | "campanha.duplicada"
  | "campanha.excluida"
  /**
   * Relatório da campanha baixado em CSV — exportação de dado pessoal.
   *
   * Registrado pelo mesmo motivo que `contatos.extraidos`, e com um agravante:
   * a planilha leva o TEXTO que os contatos responderam, não só o telefone.
   */
  | "campanha.relatorio_exportado"
  | "midia.upload"
  | "spintax.criado"
  | "spintax.excluido"
  | "canal.onboarding"
  | "canal.conectado"
  | "canal.desconectado"
  | "canal.excluido"
  | "template.criado"
  | "template.sincronizado"
  | "contatos.importados"
  /** Agenda de um canal baixada em planilha — exportação de dado pessoal. */
  | "contatos.extraidos"
  | "contato.opt_in"
  | "contato.opt_out"
  | "contato.excluido"
  | "lista.criada"
  | "lista.excluida"
  | "sessao.iniciada"
  | "empresa.criada"
  | "usuario.criado"
  | "usuario.papel_alterado"
  // Redefinida: um admin trocou a senha de OUTRA pessoa. Alterada: a própria
  // pessoa trocou a dela, informando a anterior. Separados de propósito — para
  // quem investiga a trilha depois, são eventos de segurança bem diferentes.
  | "usuario.senha_redefinida"
  | "usuario.senha_alterada"
  | "usuario.desativado"
  | "usuario.reativado"
  /**
   * O acesso deixou de existir, e não apenas de funcionar.
   *
   * Separado de `usuario.desativado` porque a pergunta que ele responde é
   * outra: desativado ainda está na lista, dá para reativar e o e-mail
   * continua ocupado; excluído sumiu, e a única memória de que aquela pessoa
   * teve acesso é esta linha. `entidadeRotulo` guarda nome e e-mail justamente
   * por isso — o perfil não existe mais para consultar depois.
   */
  | "usuario.excluido"
  /**
   * A conta de administração entrou no painel como outra pessoa.
   *
   * É o evento mais sensível da trilha: a partir dele, tudo que aparecer no
   * nome do cliente pode ter sido feito pelo suporte. Registrado no momento em
   * que o token é emitido, e não a cada ação, porque é a ENTRADA que precisa
   * ser rastreável — as ações seguintes carregam "(via Fulano)" no próprio
   * `usuario_nome`.
   */
  | "usuario.personificado";

export type TipoEntidade =
  | "campanha"
  | "canal"
  | "template"
  | "spintax"
  | "midia"
  | "contato"
  | "lista"
  | "usuario"
  | "empresa";

export interface LogAuditoria {
  id: string;
  ocorridoEm: string;
  usuarioId: string;
  usuarioNome: string;
  acao: AcaoLog;
  tipoEntidade: TipoEntidade;
  entidadeId: string | null;
  entidadeRotulo: string;
  ip: string;
  detalhes: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

export interface MetricasDashboard {
  totalCampanhasEnviadas: number;
  mensagensHoje: number;
  taxaEntrega: number; // 0..100
  taxaLeitura: number; // 0..100
  respostasRecebidas: number;
  contatosElegiveis: number;
  contatosOptOut: number;
  porStatus: {
    enviadas: number;
    entregues: number;
    lidas: number;
    falhas: number;
  };
}

// --------------------------------------------------------------------------
// Resposta paginada padrão das rotas de listagem
// --------------------------------------------------------------------------

export interface Paginado<T> {
  itens: T[];
  pagina: number;
  porPagina: number;
  total: number;
  totalPaginas: number;
}
