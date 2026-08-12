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
  /** Teto de mensagens por dia; protege número novo de volume alto demais. */
  limiteDiario: number;
  /** 0 = número novo. Sobe conforme o número amadurece. */
  estagioAquecimento: number;
  enviadasHoje: number;
  solicitadoEm: string;
  conectadoEm: string | null;
  metaPhoneNumberId?: string;
}

export interface MembroCanal {
  canalId: string;
  perfilId: string;
  nome: string;
  permissao: PermissaoCanal;
}

/** Quanto do teto diário do canal já foi consumido (0..100). */
export function consumoDoCanal(canal: Canal): number {
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
}

/** Campanha sem a sequência — payload leve para tabelas. */
export type ResumoCampanha = Omit<Campanha, "sequencia"> & {
  totalMensagens: number;
  progresso: number; // 0..100
};

/** Amostra de contato exibida no detalhe da campanha. */
export interface ContatoDaCampanha {
  id: number;
  contatoId: string;
  nome: string | null;
  telefone: string;
  status: StatusContatoCampanha;
  motivo: string | null;
  variaveis: Record<string, string>;
}

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
  | "campanha.rascunho_salvo"
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
  | "contato.opt_in"
  | "contato.opt_out"
  | "contato.excluido"
  | "lista.criada"
  | "lista.excluida"
  | "sessao.iniciada"
  | "usuario.criado"
  | "usuario.papel_alterado"
  | "usuario.senha_redefinida"
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
  | "usuario";

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
