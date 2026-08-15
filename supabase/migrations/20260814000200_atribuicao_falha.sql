-- ============================================================================
-- Atribuição de falha: o sistema passa a dizer de quem foi a culpa.
--
-- Até aqui toda falha virava texto livre em `mensagens_enviadas.erro` e
-- `campanha_contatos.motivo`. Texto livre não agrupa, não filtra e não vira
-- alerta — por isso "o WhatsApp do cliente desconectou" e "nosso worker
-- quebrou" chegavam idênticos na tela, e o operador só conseguia concluir a
-- única coisa que os dados permitiam: que o sistema estava quebrado.
--
-- Idempotente: roda sobre o banco que já está no ar.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'categoria_falha') then
    create type categoria_falha as enum (
      'canal', 'destinatario', 'infra', 'configuracao', 'conteudo', 'limite'
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- O código já era calculado no provedor e descartado antes do insert.
-- ---------------------------------------------------------------------------
alter table mensagens_enviadas
  add column if not exists erro_codigo    text,
  add column if not exists erro_categoria categoria_falha;

alter table campanha_contatos
  add column if not exists falha_codigo    text,
  add column if not exists falha_categoria categoria_falha;

-- Agrupamento por causa na tela da campanha: "Sem WhatsApp (312)".
create index if not exists mensagens_falha_idx
  on mensagens_enviadas (campanha_id, erro_categoria)
  where erro_categoria is not null;

-- `status` é cache do webhook. Estas colunas registram quando ele foi
-- conferido ATIVAMENTE contra o gateway, e o que o gateway respondeu.
alter table canais
  add column if not exists estado_verificado_em timestamptz,
  add column if not exists estado_gateway       text,
  add column if not exists ultimo_erro_codigo   text;

-- Quem causou a pausa. Sem isto a retomada automática não sabe quais campanhas
-- soltar quando o canal voltar.
alter table campanhas
  add column if not exists pausada_por_canal_id uuid references canais (id) on delete set null,
  add column if not exists pausada_motivo       text;

-- ---------------------------------------------------------------------------
-- Incidentes: o que está quebrado agora, e desde quando.
--
-- Separado de `logs_auditoria` de propósito. Auditoria é ação humana e é
-- imutável; incidente é estado de máquina, abre e fecha sozinho.
-- ---------------------------------------------------------------------------
create table if not exists incidentes (
  id           bigserial primary key,
  categoria    categoria_falha not null,
  codigo       text not null,
  canal_id     uuid references canais (id) on delete cascade,
  campanha_id  uuid references campanhas (id) on delete cascade,
  titulo       text not null,
  detalhe      text,
  ocorrencias  integer not null default 1,
  aberto_em    timestamptz not null default now(),
  visto_em     timestamptz not null default now(),
  resolvido_em timestamptz
);

/*
 * Um incidente ABERTO por canal e código.
 *
 * É esta constraint que impede a enxurrada: quando um canal cai no meio de uma
 * campanha, cada job que acorda chama `abrir_incidente`. Sem ela, 4.800
 * contatos falhando pelo mesmo motivo abririam 4.800 incidentes — e a tela
 * viraria exatamente a avalanche que ela existe para substituir.
 *
 * O `coalesce` com o uuid zerado existe porque, em índice único, NULL não
 * colide com NULL: sem ele, incidentes sem canal (infra, configuração)
 * duplicariam à vontade.
 */
create unique index if not exists incidentes_abertos_idx
  on incidentes (
    categoria,
    codigo,
    coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where resolvido_em is null;

create index if not exists incidentes_abertos_por_canal_idx
  on incidentes (canal_id) where resolvido_em is null;

-- ---------------------------------------------------------------------------
-- Abre ou incrementa. Devolve o id do incidente aberto.
-- ---------------------------------------------------------------------------
create or replace function abrir_incidente(
  p_categoria   categoria_falha,
  p_codigo      text,
  p_titulo      text,
  p_canal_id    uuid default null,
  p_campanha_id uuid default null,
  p_detalhe     text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  insert into incidentes (categoria, codigo, canal_id, campanha_id, titulo, detalhe)
  values (p_categoria, p_codigo, p_canal_id, p_campanha_id, p_titulo, p_detalhe)
  on conflict (categoria, codigo, coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid))
    where resolvido_em is null
  do update set
    ocorrencias = incidentes.ocorrencias + 1,
    visto_em    = now(),
    detalhe     = coalesce(excluded.detalhe, incidentes.detalhe)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function resolver_incidentes_do_canal(p_canal_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_fechados integer;
begin
  update incidentes
     set resolvido_em = now()
   where canal_id = p_canal_id
     and resolvido_em is null;

  get diagnostics v_fechados = row_count;
  return v_fechados;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pausa causada pelo sistema. Devolve quantos contatos voltaram para a fila.
--
-- Um único UPDATE por tabela, não um laço: a campanha precisa parar antes do
-- próximo job acordar, e um laço sobre milhares de linhas não para nada a tempo.
--
-- O `rodada + 1` é o que aposenta os jobs JÁ enfileirados — mesma mecânica que
-- `invalidar_rodada_campanha` usa na pausa manual. Sem ele, os jobs antigos
-- acordariam e tentariam enviar por um canal que acabou de cair.
-- ---------------------------------------------------------------------------
create or replace function pausar_campanha_por_canal(
  p_campanha_id uuid,
  p_canal_id    uuid,
  p_motivo      text
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_devolvidos integer;
begin
  update campanhas
     set status               = 'pausada_por_canal',
         rodada               = rodada + 1,
         pausada_por_canal_id = p_canal_id,
         pausada_motivo       = p_motivo
   where id = p_campanha_id
     and status in ('em_andamento', 'agendada');

  if not found then
    return 0;
  end if;

  -- Tudo que ainda não foi entregue volta a ser candidato. `enviando` entra
  -- junto: o job daquele contato acabou de morrer com a sessão.
  update campanha_contatos
     set status         = 'pendente',
         enfileirado_em = null,
         enviando_desde = null
   where campanha_id = p_campanha_id
     and status in ('pendente', 'validando', 'enviando');

  get diagnostics v_devolvidos = row_count;
  return v_devolvidos;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retomada automática quando o canal volta.
--
-- Solta SÓ o que o sistema pausou. Campanha que uma pessoa pausou continua
-- pausada — é por isso que `pausada_por_canal` existe como estado separado.
-- ---------------------------------------------------------------------------
create or replace function retomar_campanhas_do_canal(p_canal_id uuid)
returns table (campanha_id uuid, rodada integer)
language plpgsql security definer set search_path = public as $$
begin
  return query
    update campanhas
       set status               = 'em_andamento',
           pausada_por_canal_id = null,
           pausada_motivo       = null
     where pausada_por_canal_id = p_canal_id
       and status = 'pausada_por_canal'
    returning campanhas.id, campanhas.rodada;
end;
$$;

alter table incidentes enable row level security;
