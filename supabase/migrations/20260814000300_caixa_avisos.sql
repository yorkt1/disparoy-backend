-- ============================================================================
-- Caixa de avisos por perfil.
--
-- `incidentes` guarda o FATO: uma linha por canal e código. Esta tabela guarda
-- a ENTREGA: uma linha por pessoa que precisa saber.
--
-- Separar não é preciosismo. Se o estado de leitura morasse no incidente, a
-- primeira pessoa a abrir marcaria como lido para todas — e num disparo quem
-- precisa agir é justamente quem ainda não viu.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tipo_notificacao') then
    create type tipo_notificacao as enum ('abertura', 'resolucao');
  end if;
end;
$$;

create table if not exists notificacoes (
  id            bigserial primary key,
  perfil_id     uuid not null references perfis (id) on delete cascade,

  -- Nulo em aviso que não vem de incidente (campanha concluída, importação
  -- terminada). A caixa não é só para erro.
  incidente_id  bigint references incidentes (id) on delete cascade,
  tipo          tipo_notificacao not null default 'abertura',

  categoria     categoria_falha not null,
  codigo        text not null,

  -- Texto JÁ renderizado, com nome de canal e contagens dentro. Guardado em vez
  -- de montado na leitura porque "4.812 contatos na fila" era verdade às 3h07 e
  -- não é mais amanhã. O aviso é registro de um momento, não consulta viva.
  titulo        text not null,
  corpo         text not null default '',

  canal_id      uuid references canais (id) on delete set null,
  campanha_id   uuid references campanhas (id) on delete set null,

  criada_em     timestamptz not null default now(),
  lida_em       timestamptz,
  arquivada_em  timestamptz
);

create index if not exists notificacoes_caixa_idx
  on notificacoes (perfil_id, criada_em desc)
  where arquivada_em is null;

-- O número do sininho. Roda a cada abertura de tela; precisa ser barato.
create index if not exists notificacoes_nao_lidas_idx
  on notificacoes (perfil_id)
  where lida_em is null and arquivada_em is null;

/*
 * Um aviso por pessoa, por incidente, por tipo.
 *
 * É esta constraint que impede a enxurrada: quando um canal cai, cada job que
 * acorda chama `abrir_incidente`. O incidente só incrementa `ocorrencias`, mas
 * sem este índice uma corrida entre dois workers ainda geraria avisos
 * duplicados na caixa de todo mundo.
 */
create unique index if not exists notificacoes_unicas_idx
  on notificacoes (perfil_id, incidente_id, tipo)
  where incidente_id is not null;

-- ---------------------------------------------------------------------------
-- Fan-out na ESCRITA, não na leitura.
--
-- Poderia ser uma view com join em `canal_membros` resolvida a cada consulta.
-- Não é: a caixa é lida muitas vezes por sessão e escrita poucas vezes por dia,
-- e um join de permissão no caminho de leitura vira o gargalo do painel.
-- Materializar também congela quem tinha acesso NAQUELE momento, que é o
-- comportamento certo — tirar alguém de um canal não deve apagar o aviso que
-- ela já recebeu.
-- ---------------------------------------------------------------------------
create or replace function notificar_envolvidos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notificacoes (
    perfil_id, incidente_id, tipo, categoria, codigo, titulo, corpo, canal_id, campanha_id
  )
  select
    p.id, new.id, 'abertura', new.categoria, new.codigo,
    new.titulo, coalesce(new.detalhe, ''), new.canal_id, new.campanha_id
  from perfis p
  where p.ativo
    and (
      p.papel = 'admin'
      -- Incidente sem canal (infra, configuração) é assunto de admin.
      or (new.canal_id is not null and exists (
            select 1 from canal_membros m
            where m.canal_id = new.canal_id and m.perfil_id = p.id
          ))
    )
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists ao_abrir_incidente on incidentes;
create trigger ao_abrir_incidente
  after insert on incidentes
  for each row execute function notificar_envolvidos();

-- ---------------------------------------------------------------------------
-- Resolução também é aviso.
--
-- "Vendas 02 reconectou e a campanha retomou" é a mensagem que evita o telefone
-- tocando. Sem ela o operador fica olhando um aviso vermelho que já não vale.
-- ---------------------------------------------------------------------------
create or replace function notificar_resolucao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.resolvido_em is not null or new.resolvido_em is null then
    return new;
  end if;

  insert into notificacoes (
    perfil_id, incidente_id, tipo, categoria, codigo, titulo, corpo,
    canal_id, campanha_id, lida_em
  )
  select
    n.perfil_id, new.id, 'resolucao', new.categoria, new.codigo,
    'Resolvido: ' || new.titulo,
    'Durou ' || greatest(1, round(extract(epoch from (new.resolvido_em - new.aberto_em)) / 60))
      || ' min. Nenhum contato foi perdido nem enviado duas vezes.',
    new.canal_id, new.campanha_id,
    -- Nasce lida: informa, não pede ação. Deixá-la contar no sininho faria o
    -- número subir justamente quando o problema acabou.
    now()
  from notificacoes n
  where n.incidente_id = new.id and n.tipo = 'abertura'
  on conflict do nothing;

  -- Arquiva a abertura junto: ela não tem mais o que pedir.
  update notificacoes
     set arquivada_em = now()
   where incidente_id = new.id and tipo = 'abertura' and arquivada_em is null;

  return new;
end;
$$;

drop trigger if exists ao_resolver_incidente on incidentes;
create trigger ao_resolver_incidente
  after update of resolvido_em on incidentes
  for each row execute function notificar_resolucao();

-- Aviso arquivado há mais de 90 dias não serve a ninguém. O que precisa durar
-- para sempre é `logs_auditoria`, e ele não é tocado aqui.
create or replace function limpar_avisos_antigos(p_dias integer default 90)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_apagados integer;
begin
  delete from notificacoes
   where arquivada_em is not null
     and arquivada_em < now() - make_interval(days => p_dias);

  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

alter table notificacoes enable row level security;
