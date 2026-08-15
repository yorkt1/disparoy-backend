-- ============================================================================
-- O público entra na campanha, não num cadastro.
--
-- Contatos deixam de ser entidade do sistema: a lista de destino chega por
-- planilha ou colagem, no momento de criar a campanha, e vive dentro dela.
-- `campanha_contatos` já guardava `telefone` e `variaveis` como instantâneo —
-- faltava só parar de exigir a linha em `contatos`.
--
-- O que NÃO pode sumir junto é o opt-out. Quem pediu para sair continua fora,
-- e o webhook registra pedido vindo por WhatsApp a qualquer momento, mesmo sem
-- campanha em andamento. Por isso ele ganha tabela própria, que é o único
-- resquício permanente de dado pessoal no sistema.
--
-- Idempotente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. O contato salvo passa a ser opcional.
-- ---------------------------------------------------------------------------
alter table campanha_contatos alter column contato_id drop not null;

/*
 * A unicidade muda de coluna, e isto é o ponto mais perigoso da migration.
 *
 * A trava era `unique (campanha_id, contato_id)`. Em índice único do Postgres,
 * NULL não colide com NULL — então, no instante em que `contato_id` passou a
 * aceitar nulo, ela deixou de impedir qualquer coisa: a mesma pessoa poderia
 * entrar mil vezes na campanha e receber mil mensagens.
 *
 * O telefone é o que identifica o destinatário agora, e é ele que trava.
 */
create unique index if not exists campanha_contatos_telefone_idx
  on campanha_contatos (campanha_id, telefone);

-- ---------------------------------------------------------------------------
-- 2. Opt-out com casa própria.
--
-- Sem `contato_id`: o pedido de saída sobrevive ao contato, que agora é
-- efêmero. O telefone é a identidade, e é só o que precisa ser guardado.
-- ---------------------------------------------------------------------------
create table if not exists opt_outs (
  id         bigserial primary key,
  empresa_id uuid not null references empresas (id) on delete cascade,
  telefone   text not null check (telefone ~ '^\+[1-9][0-9]{7,14}$'),
  motivo     text,
  criado_em  timestamptz not null default now(),
  unique (empresa_id, telefone)
);

create index if not exists opt_outs_telefone_idx on opt_outs (telefone);
alter table opt_outs enable row level security;

-- Traz o que já existe: quem pediu para sair não pode voltar a receber só
-- porque o cadastro mudou de lugar.
insert into opt_outs (empresa_id, telefone, motivo, criado_em)
select
  coalesce(c.empresa_id, '00000000-0000-0000-0000-000000000001'::uuid),
  c.telefone,
  c.opt_out_motivo,
  c.opt_out_em
from contatos c
where c.opt_out_em is not null
on conflict (empresa_id, telefone) do nothing;

-- ---------------------------------------------------------------------------
-- 3. O pedido de saída passa a ser gravado na tabela nova.
--
-- Continua aceitando `p_empresa_id` nulo como "todas as empresas", que é o que
-- o webhook usa: ele recebe "sair" sem saber de qual canal veio, e marcar de
-- menos é o único erro que vira violação.
-- ---------------------------------------------------------------------------
create or replace function registrar_opt_out(
  p_telefone   text,
  p_motivo     text,
  p_empresa_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
begin
  insert into opt_outs (empresa_id, telefone, motivo)
  select e.id, p_telefone, p_motivo
    from empresas e
   where p_empresa_id is null or e.id = p_empresa_id
  on conflict (empresa_id, telefone) do nothing;

  get diagnostics v_total = row_count;

  -- Tira das campanhas que ainda não dispararam para este número. Vale mesmo
  -- quando o opt-out já existia: o pedido pode ter chegado antes da campanha.
  update campanha_contatos cc
     set status        = 'bloqueado',
         motivo        = 'Contato pediu para sair',
         processado_em = now()
   where cc.telefone = p_telefone
     and cc.status = 'pendente';

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Materializar o público a partir da planilha/colagem.
--
-- Substitui `popular_contatos_da_campanha`, que lia de `listas`. O filtro de
-- consentimento continua ACONTECENDO AQUI, no banco: é a última barreira antes
-- de a mensagem existir, e nenhum caminho de código consegue contorná-la.
--
-- Recebe jsonb `[{telefone, nome, variaveis}]` em vez de uma tabela temporária
-- para ser uma chamada só, com o lote inteiro.
-- ---------------------------------------------------------------------------
create or replace function popular_publico_da_campanha(
  p_campanha_id uuid,
  p_publico     jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa   uuid;
  v_inseridos integer;
begin
  select empresa_id into v_empresa from campanhas where id = p_campanha_id;

  insert into campanha_contatos (campanha_id, contato_id, telefone, variaveis)
  select
    p_campanha_id,
    null,
    p.telefone,
    coalesce(p.variaveis, '{}'::jsonb)
  from jsonb_to_recordset(p_publico) as p(telefone text, nome text, variaveis jsonb)
  where p.telefone is not null
    and p.telefone <> ''
    -- Quem pediu para sair não entra, nem que venha na planilha.
    and not exists (
      select 1 from opt_outs o
       where o.telefone = p.telefone
         and (v_empresa is null or o.empresa_id = v_empresa)
    )
  on conflict (campanha_id, telefone) do nothing;

  get diagnostics v_inseridos = row_count;

  update campanhas set total_contatos = v_inseridos where id = p_campanha_id;
  return v_inseridos;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. `contatos_elegiveis_da_lista` e `popular_contatos_da_campanha` continuam
--    existindo de propósito: as campanhas antigas foram criadas por elas, e
--    removê-las agora quebraria qualquer rotina que ainda as chame durante o
--    deploy. Saem numa limpeza posterior, com o código novo já em produção.
-- ---------------------------------------------------------------------------
