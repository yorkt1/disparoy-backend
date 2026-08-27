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

export interface ContatoDaCampanha {
  id: number;
  contatoId: string;
  nome: string | null;
  telefone: string;
  status: StatusContatoCampanha;
  situacao: SituacaoContato;
  /** Primeira leitura confirmada pelo WhatsApp. `null` enquanto não houve. */
  lidaEm: string | null;
  /** Quantas mensagens o contato mandou de volta. */
  respostas: number;
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
  | "usuario.reativado";

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
