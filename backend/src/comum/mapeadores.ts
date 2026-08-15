import type {
  Campanha,
  Canal,
  Contato,
  ContatoDaCampanha,
  EstadoGateway,
  Lista,
  LogAuditoria,
  MensagemSequencia,
  ResumoCampanha,
  Spintax,
  Template,
  Usuario,
} from "@disparoy/dominio";
import { percentual } from "@disparoy/dominio";

/**
 * Tradução entre as linhas do Postgres (snake_case, timestamps) e os tipos do
 * domínio (camelCase, datas ISO).
 *
 * Fica num arquivo só de propósito: quando o schema mudar, este é o único
 * ponto que precisa acompanhar, e o resto da API segue falando em domínio.
 */

const iso = (v: string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

function textos(bruto: unknown): string[] {
  return Array.isArray(bruto) ? bruto.map(String) : [];
}

function variaveis(bruto: unknown): Record<string, string> {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
  return Object.fromEntries(
    Object.entries(bruto as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]),
  );
}

// --------------------------------------------------------------------------
// Perfil
// --------------------------------------------------------------------------

export const COLUNAS_PERFIL = "id, nome, email, papel, ativo, criado_em";

export interface LinhaPerfil {
  id: string;
  nome: string;
  email: string;
  papel: Usuario["papel"];
  ativo: boolean;
  criado_em: string;
}

export function paraUsuario(l: LinhaPerfil): Usuario {
  return {
    id: l.id,
    nome: l.nome,
    email: l.email,
    papel: l.papel,
    ativo: l.ativo,
    criadoEm: iso(l.criado_em)!,
  };
}

// --------------------------------------------------------------------------
// Canal
// --------------------------------------------------------------------------

export const COLUNAS_CANAL =
  "id, nome, numero, instancia_evolution, tipo_conexao, status, limite_diario, " +
  "estagio_aquecimento, enviadas_hoje, solicitado_em, conectado_em, meta_phone_number_id, " +
  // Gravadas pela vigilância desde a migration de atribuição de falha, mas até
  // aqui nunca lidas: o painel mostrava `status` — cache do webhook — como se
  // fosse fato confirmado.
  "estado_gateway, estado_verificado_em";

export interface LinhaCanal {
  id: string;
  nome: string;
  numero: string;
  instancia_evolution: string;
  tipo_conexao: Canal["tipoConexao"];
  status: Canal["status"];
  limite_diario: number;
  estagio_aquecimento: number;
  enviadas_hoje: number;
  solicitado_em: string;
  conectado_em: string | null;
  meta_phone_number_id: string | null;
  estado_gateway: EstadoGateway | null;
  estado_verificado_em: string | null;
}

export function paraCanal(l: LinhaCanal): Canal {
  return {
    id: l.id,
    nome: l.nome,
    numero: l.numero,
    instanciaEvolution: l.instancia_evolution,
    tipoConexao: l.tipo_conexao,
    status: l.status,
    limiteDiario: l.limite_diario,
    estagioAquecimento: l.estagio_aquecimento,
    enviadasHoje: l.enviadas_hoje,
    solicitadoEm: iso(l.solicitado_em)!,
    conectadoEm: iso(l.conectado_em),
    estadoGateway: l.estado_gateway ?? null,
    estadoVerificadoEm: iso(l.estado_verificado_em),
    metaPhoneNumberId: l.meta_phone_number_id ?? undefined,
  };
}

// --------------------------------------------------------------------------
// Contato
// --------------------------------------------------------------------------

export const COLUNAS_CONTATO =
  "id, nome, telefone, tags, opt_in, opt_in_origem, opt_in_em, opt_out_em, " +
  "opt_out_motivo, variaveis, criado_em";

export interface LinhaContato {
  id: string;
  nome: string | null;
  telefone: string;
  tags: unknown;
  opt_in: boolean;
  opt_in_origem: string | null;
  opt_in_em: string | null;
  opt_out_em: string | null;
  opt_out_motivo: string | null;
  variaveis: unknown;
  criado_em: string;
}

export function paraContato(l: LinhaContato): Contato {
  return {
    id: l.id,
    nome: l.nome,
    telefone: l.telefone,
    tags: textos(l.tags),
    optIn: l.opt_in,
    optInOrigem: l.opt_in_origem,
    optInEm: iso(l.opt_in_em),
    optOutEm: iso(l.opt_out_em),
    optOutMotivo: l.opt_out_motivo,
    variaveis: variaveis(l.variaveis),
    criadoEm: iso(l.criado_em)!,
  };
}

// --------------------------------------------------------------------------
// Lista
// --------------------------------------------------------------------------

export interface LinhaLista {
  id: string;
  nome: string;
  descricao: string | null;
  criada_em: string;
}

export function paraLista(l: LinhaLista, total: number, elegiveis: number): Lista {
  return {
    id: l.id,
    nome: l.nome,
    descricao: l.descricao,
    totalContatos: total,
    totalElegiveis: elegiveis,
    criadaEm: iso(l.criada_em)!,
  };
}

// --------------------------------------------------------------------------
// Template e spintax
// --------------------------------------------------------------------------

export const COLUNAS_TEMPLATE =
  "id, nome, categoria, status, idioma, corpo, variaveis, meta_template_id, atualizado_em";

export interface LinhaTemplate {
  id: string;
  nome: string;
  categoria: Template["categoria"];
  status: Template["status"];
  idioma: string;
  corpo: string;
  variaveis: number;
  meta_template_id: string | null;
  atualizado_em: string;
}

export function paraTemplate(l: LinhaTemplate): Template {
  return {
    id: l.id,
    nome: l.nome,
    categoria: l.categoria,
    status: l.status,
    idioma: l.idioma,
    corpo: l.corpo,
    variaveis: l.variaveis,
    atualizadoEm: iso(l.atualizado_em)!,
    metaTemplateId: l.meta_template_id ?? undefined,
  };
}

export interface LinhaSpintax {
  id: string;
  nome: string;
  opcoes: unknown;
  criado_em: string;
}

export function paraSpintax(l: LinhaSpintax): Spintax {
  return {
    id: l.id,
    nome: l.nome,
    opcoes: textos(l.opcoes),
    criadoEm: iso(l.criado_em)!,
  };
}

// --------------------------------------------------------------------------
// Campanha
// --------------------------------------------------------------------------

export const COLUNAS_CAMPANHA =
  "id, nome, status, lista_id, sequencia, intervalo_contatos_min, intervalo_contatos_max, " +
  "intervalo_mensagens_min, intervalo_mensagens_max, validar_numeros, agendada_para, " +
  "criada_em, iniciada_em, concluida_em, template_principal, pausada_motivo, total_contatos, " +
  "total_enviadas, total_entregues, total_lidas, total_falhas, total_respostas, " +
  "listas(nome), campanha_canais(canal_id)";

export interface LinhaCampanha {
  id: string;
  nome: string;
  status: Campanha["status"];
  lista_id: string | null;
  sequencia: unknown;
  intervalo_contatos_min: number;
  intervalo_contatos_max: number;
  intervalo_mensagens_min: number;
  intervalo_mensagens_max: number;
  validar_numeros: boolean;
  agendada_para: string | null;
  criada_em: string;
  iniciada_em: string | null;
  concluida_em: string | null;
  template_principal: string | null;
  pausada_motivo: string | null;
  total_contatos: number;
  total_enviadas: number;
  total_entregues: number;
  total_lidas: number;
  total_falhas: number;
  total_respostas: number;
  listas?: { nome: string } | null;
  campanha_canais?: { canal_id: string }[];
}

function sequenciaDe(l: LinhaCampanha): MensagemSequencia[] {
  return Array.isArray(l.sequencia) ? (l.sequencia as MensagemSequencia[]) : [];
}

function base(l: LinhaCampanha): Omit<Campanha, "sequencia"> {
  return {
    id: l.id,
    nome: l.nome,
    status: l.status,
    listaId: l.lista_id,
    listaNome: l.listas?.nome ?? null,
    canaisIds: (l.campanha_canais ?? []).map((c) => c.canal_id),
    intervaloEntreContatos: {
      minSegundos: l.intervalo_contatos_min,
      maxSegundos: l.intervalo_contatos_max,
    },
    intervaloEntreMensagens: {
      minSegundos: l.intervalo_mensagens_min,
      maxSegundos: l.intervalo_mensagens_max,
    },
    validarNumeros: l.validar_numeros,
    agendadaPara: iso(l.agendada_para),
    criadaEm: iso(l.criada_em)!,
    iniciadaEm: iso(l.iniciada_em),
    concluidaEm: iso(l.concluida_em),
    templatePrincipal: l.template_principal,
    pausadaMotivo: l.pausada_motivo,
    metricas: {
      total: l.total_contatos,
      enviadas: l.total_enviadas,
      entregues: l.total_entregues,
      lidas: l.total_lidas,
      falhas: l.total_falhas,
      respostas: l.total_respostas,
    },
  };
}

export function paraResumoCampanha(l: LinhaCampanha): ResumoCampanha {
  return {
    ...base(l),
    totalMensagens: sequenciaDe(l).length,
    progresso: percentual(l.total_enviadas, l.total_contatos),
  };
}

export function paraCampanha(l: LinhaCampanha): Campanha {
  return { ...base(l), sequencia: sequenciaDe(l) };
}

export interface LinhaContatoCampanha {
  id: number;
  contato_id: string;
  telefone: string;
  status: ContatoDaCampanha["status"];
  motivo: string | null;
  variaveis: unknown;
  contatos?: { nome: string | null } | null;
}

export function paraContatoDaCampanha(l: LinhaContatoCampanha): ContatoDaCampanha {
  return {
    id: l.id,
    contatoId: l.contato_id,
    nome: l.contatos?.nome ?? null,
    telefone: l.telefone,
    status: l.status,
    motivo: l.motivo,
    variaveis: variaveis(l.variaveis),
  };
}

// --------------------------------------------------------------------------
// Log de auditoria
// --------------------------------------------------------------------------

export const COLUNAS_LOG =
  "id, ocorrido_em, usuario_id, usuario_nome, acao, tipo_entidade, entidade_id, " +
  "entidade_rotulo, ip, detalhes";

export interface LinhaLog {
  id: string;
  ocorrido_em: string;
  usuario_id: string | null;
  usuario_nome: string;
  acao: string;
  tipo_entidade: string;
  entidade_id: string | null;
  entidade_rotulo: string;
  ip: string | null;
  detalhes: unknown;
}

export function paraLog(l: LinhaLog): LogAuditoria {
  return {
    id: l.id,
    ocorridoEm: iso(l.ocorrido_em)!,
    usuarioId: l.usuario_id ?? "",
    usuarioNome: l.usuario_nome,
    acao: l.acao as LogAuditoria["acao"],
    tipoEntidade: l.tipo_entidade as LogAuditoria["tipoEntidade"],
    entidadeId: l.entidade_id,
    entidadeRotulo: l.entidade_rotulo,
    ip: l.ip ?? "—",
    detalhes: (l.detalhes as Record<string, unknown>) ?? {},
  };
}
