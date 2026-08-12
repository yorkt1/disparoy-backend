-- ============================================================================
-- DisparoY — schema
--
-- Sistema INTERNO (single-tenant): um único negócio, vários logins.
-- O isolamento não é por empresa, é por PAPEL (admin/operator) e, no caso dos
-- canais, por vínculo explícito em `canal_membros`.
--
-- Contatos, listas, templates e variações são compartilhados pelo negócio —
-- é o mesmo time operando a mesma base.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type papel_usuario as enum ('admin', 'operator');
create type tipo_conexao as enum ('qrcode', 'api_oficial');
create type status_canal as enum ('conectado', 'desconectado', 'aguardando_qr', 'banido');
create type permissao_canal as enum ('owner', 'operator', 'viewer');
create type categoria_template as enum ('marketing', 'utilidade', 'autenticacao');
create type status_template as enum ('aprovado', 'pendente', 'rejeitado', 'pausado');
create type status_campanha as enum (
  'rascunho', 'agendada', 'em_andamento', 'pausada', 'concluida', 'falhou'
);
create type status_contato_campanha as enum (
  'pendente', 'validando', 'invalido', 'enviando', 'concluido', 'falhou', 'bloqueado'
);
create type status_mensagem as enum ('enfileirada', 'enviada', 'entregue', 'lida', 'falhou');

-- ---------------------------------------------------------------------------
-- Perfis
-- ---------------------------------------------------------------------------
create table perfis (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text not null check (length(trim(nome)) between 2 and 120),
  email text not null,
  papel papel_usuario not null default 'operator',
  -- Desativar em vez de excluir: o histórico de campanhas aponta para o perfil.
  ativo boolean not null default true,
  criado_por uuid references auth.users (id) on delete set null,
  criado_em timestamptz not null default now()
);

/**
 * Papel do usuário autenticado. `security definer` para enxergar `perfis`
 * mesmo com RLS ativo na própria tabela, e `stable` para o Postgres cachear
 * dentro da consulta em vez de reavaliar linha a linha.
 */
create or replace function papel_atual()
returns papel_usuario
language sql
stable
security definer
set search_path = public
as $$
  select papel from perfis where id = auth.uid() and ativo;
$$;

create or replace function eh_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(papel_atual() = 'admin', false);
$$;

/** Qualquer usuário ativo. Base das políticas de leitura compartilhada. */
create or replace function eh_ativo()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from perfis where id = auth.uid() and ativo);
$$;

-- ---------------------------------------------------------------------------
-- Canais (instâncias de WhatsApp na Evolution API)
-- ---------------------------------------------------------------------------
create table canais (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 2 and 60),
  numero text not null unique check (numero ~ '^\+[1-9][0-9]{7,14}$'),
  -- Nome da instância na Evolution API. Único porque é a chave que o webhook
  -- usa para achar o canal.
  instancia_evolution text not null unique,
  tipo_conexao tipo_conexao not null default 'qrcode',
  status status_canal not null default 'aguardando_qr',

  -- Anti-ban: teto diário e estágio de aquecimento do número.
  limite_diario integer not null default 200 check (limite_diario > 0),
  estagio_aquecimento smallint not null default 0 check (estagio_aquecimento >= 0),
  enviadas_hoje integer not null default 0 check (enviadas_hoje >= 0),
  contador_zerado_em date not null default current_date,

  meta_phone_number_id text,
  solicitado_em timestamptz not null default now(),
  conectado_em timestamptz,
  criado_por uuid references auth.users (id) on delete set null
);
create index canais_status_idx on canais (status);

-- Quem pode operar cada canal. Um número pode ser compartilhado entre
-- operadores; admin enxerga todos independentemente desta tabela.
create table canal_membros (
  canal_id uuid not null references canais (id) on delete cascade,
  perfil_id uuid not null references perfis (id) on delete cascade,
  permissao permissao_canal not null default 'operator',
  primary key (canal_id, perfil_id)
);
create index canal_membros_perfil_idx on canal_membros (perfil_id);

/** O usuário atual pode operar este canal? Admin pode todos. */
create or replace function pode_operar_canal(p_canal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select eh_admin() or exists (
    select 1 from canal_membros
    where canal_id = p_canal_id and perfil_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Contatos
--
-- Entidade reutilizável, não linha de campanha: a mesma pessoa entra em várias
-- listas e várias campanhas, e o consentimento vive com ela.
-- ---------------------------------------------------------------------------
create table contatos (
  id uuid primary key default gen_random_uuid(),
  nome text,
  telefone text not null unique check (telefone ~ '^\+[1-9][0-9]{7,14}$'),
  tags text[] not null default '{}',

  -- LGPD: sem base legal registrada, o contato não pode receber campanha.
  opt_in boolean not null default false,
  opt_in_origem text,
  opt_in_em timestamptz,
  -- Preenchido quando o contato pede saída. Vale MAIS que opt_in: uma vez
  -- preenchido, nenhuma campanha futura o alcança, mesmo que opt_in siga true.
  opt_out_em timestamptz,
  opt_out_motivo text,

  -- Colunas extras da planilha, disponíveis como variáveis do template.
  variaveis jsonb not null default '{}'::jsonb,

  criado_por uuid references auth.users (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  -- Consentimento sem data de origem é consentimento não comprovável.
  constraint opt_in_precisa_de_prova
    check (not opt_in or (opt_in_origem is not null and opt_in_em is not null))
);
-- Índice parcial: a seleção para campanha é sempre "quem pode receber".
create index contatos_elegiveis_idx on contatos (id)
  where opt_in and opt_out_em is null;
create index contatos_tags_idx on contatos using gin (tags);

create table listas (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 2 and 80),
  descricao text,
  criado_por uuid references auth.users (id) on delete set null,
  criada_em timestamptz not null default now()
);

create table lista_contatos (
  lista_id uuid not null references listas (id) on delete cascade,
  contato_id uuid not null references contatos (id) on delete cascade,
  adicionado_em timestamptz not null default now(),
  primary key (lista_id, contato_id)
);
create index lista_contatos_contato_idx on lista_contatos (contato_id);

/** Quantos contatos da lista podem legalmente receber mensagem agora. */
create or replace function contatos_elegiveis_da_lista(p_lista_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from lista_contatos lc
  join contatos c on c.id = lc.contato_id
  where lc.lista_id = p_lista_id and c.opt_in and c.opt_out_em is null;
$$;

-- ---------------------------------------------------------------------------
-- Templates (WhatsApp Business API oficial) e variações (spintax)
-- ---------------------------------------------------------------------------
create table templates (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (nome ~ '^[a-z0-9_]+$'),
  categoria categoria_template not null,
  status status_template not null default 'pendente',
  idioma text not null default 'pt_BR',
  corpo text not null check (length(corpo) between 1 and 1024),
  variaveis integer not null default 0,
  meta_template_id text,
  criado_por uuid references auth.users (id) on delete set null,
  atualizado_em timestamptz not null default now(),
  -- Chave natural da Meta: o par (nome, idioma) é único por conta.
  unique (nome, idioma)
);

/**
 * Variações de texto sorteadas por envio, referenciadas como {{*nome*}}.
 *
 * Existem para que dois contatos não recebam texto idêntico: mensagem repetida
 * em volume é um dos sinais mais fortes de bloqueio em conexão não oficial.
 */
create table spintax (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique check (nome ~ '^[a-z0-9_]+$'),
  opcoes jsonb not null default '[]'::jsonb,
  criado_por uuid references auth.users (id) on delete set null,
  criado_em timestamptz not null default now(),
  -- Sortear entre menos de duas opções não é variação nenhuma.
  constraint spintax_min_opcoes check (jsonb_array_length(opcoes) >= 2)
);

-- ---------------------------------------------------------------------------
-- Campanhas
-- ---------------------------------------------------------------------------
create table campanhas (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 3 and 80),
  status status_campanha not null default 'rascunho',
  lista_id uuid references listas (id) on delete restrict,

  /**
   * Sequência ordenada de até 10 passos, cada um com tipo (texto/mídia) e
   * corpo próprio. É documento, não relação: a ordem importa e o formato varia
   * por passo, então normalizar custaria um join a cada envio sem ganho algum.
   */
  sequencia jsonb not null default '[]'::jsonb,

  -- Dois intervalos porque medem coisas diferentes: entre passos do mesmo
  -- contato é ritmo de digitação; entre contatos é a cadência do disparo.
  -- Sorteados dentro da faixa a cada envio — cadência fixa é padrão de robô.
  intervalo_contatos_min integer not null default 15 check (intervalo_contatos_min >= 0),
  intervalo_contatos_max integer not null default 45 check (intervalo_contatos_max >= 0),
  intervalo_mensagens_min integer not null default 3 check (intervalo_mensagens_min >= 0),
  intervalo_mensagens_max integer not null default 9 check (intervalo_mensagens_max >= 0),

  validar_numeros boolean not null default true,
  agendada_para timestamptz,
  criada_por uuid references auth.users (id) on delete set null,
  criada_em timestamptz not null default now(),
  iniciada_em timestamptz,
  concluida_em timestamptz,
  template_principal text,

  -- Contadores mantidos pelo worker. Agregar mensagens_enviadas a cada
  -- atualização de tela não escala em campanha de dezenas de milhares.
  total_contatos integer not null default 0,
  total_enviadas integer not null default 0,
  total_entregues integer not null default 0,
  total_lidas integer not null default 0,
  total_falhas integer not null default 0,
  total_respostas integer not null default 0,

  constraint intervalo_contatos_coerente check (intervalo_contatos_max >= intervalo_contatos_min),
  constraint intervalo_mensagens_coerente check (intervalo_mensagens_max >= intervalo_mensagens_min)
);
create index campanhas_criada_idx on campanhas (criada_em desc);
create index campanhas_ativas_idx on campanhas (status)
  where status in ('agendada', 'em_andamento');

-- Vários canais por campanha: os contatos são distribuídos em rodízio, o que
-- reduz o volume por número e o risco de bloqueio.
create table campanha_canais (
  campanha_id uuid not null references campanhas (id) on delete cascade,
  canal_id uuid not null references canais (id) on delete restrict,
  primary key (campanha_id, canal_id)
);

-- Instantâneo do contato dentro da campanha. Aponta para `contatos`, mas
-- guarda o telefone usado: se o contato for editado depois, o histórico
-- continua dizendo para onde a mensagem realmente foi.
create table campanha_contatos (
  id bigserial primary key,
  campanha_id uuid not null references campanhas (id) on delete cascade,
  contato_id uuid not null references contatos (id) on delete cascade,
  telefone text not null,
  variaveis jsonb not null default '{}'::jsonb,
  status status_contato_campanha not null default 'pendente',
  canal_id uuid references canais (id) on delete set null,
  motivo text,
  tentativas smallint not null default 0,
  processado_em timestamptz,
  unique (campanha_id, contato_id)
);
-- Índice parcial: o worker busca exatamente "próximos pendentes desta campanha".
create index campanha_contatos_fila_idx on campanha_contatos (campanha_id, id)
  where status = 'pendente';

-- ---------------------------------------------------------------------------
-- Mensagens enviadas (uma linha por passo da sequência, por contato)
-- ---------------------------------------------------------------------------
create table mensagens_enviadas (
  id bigserial primary key,
  campanha_id uuid not null references campanhas (id) on delete cascade,
  campanha_contato_id bigint not null references campanha_contatos (id) on delete cascade,
  canal_id uuid references canais (id) on delete set null,
  passo smallint not null,
  /**
   * Texto final, com spintax e variáveis já resolvidos.
   *
   * Guardado porque é o que o contato viu: com spintax cada pessoa recebe um
   * texto diferente, e o template sozinho não diz qual foi. Sem isto não há
   * como auditar uma reclamação.
   */
  corpo_renderizado text,
  id_externo text,
  status status_mensagem not null default 'enfileirada',
  erro text,
  enviada_em timestamptz default now(),
  entregue_em timestamptz,
  lida_em timestamptz
);
create index mensagens_campanha_idx on mensagens_enviadas (campanha_id, status);
-- O webhook chega com o id externo e precisa achar a linha rápido.
create unique index mensagens_id_externo_idx on mensagens_enviadas (id_externo)
  where id_externo is not null;

-- ---------------------------------------------------------------------------
-- Webhooks e auditoria
-- ---------------------------------------------------------------------------

-- Payload bruto de cada evento da Evolution API, para depuração e auditoria.
create table eventos_webhook (
  id bigserial primary key,
  instancia text,
  canal_id uuid references canais (id) on delete set null,
  evento text not null,
  payload jsonb not null,
  processado boolean not null default false,
  erro text,
  recebido_em timestamptz not null default now()
);
create index eventos_webhook_recebido_idx on eventos_webhook (recebido_em desc);

create table logs_auditoria (
  id uuid primary key default gen_random_uuid(),
  ocorrido_em timestamptz not null default now(),
  usuario_id uuid references auth.users (id) on delete set null,
  usuario_nome text not null,
  acao text not null,
  tipo_entidade text not null,
  entidade_id text,
  entidade_rotulo text not null,
  ip inet,
  detalhes jsonb not null default '{}'::jsonb
);
create index logs_ocorrido_idx on logs_auditoria (ocorrido_em desc);
