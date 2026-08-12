-- ============================================================================
-- Login próprio: o Supabase Auth sai, `perfis` passa a ser a fonte da verdade.
--
-- Sistema interno não precisa de provedor de identidade externo. O que o
-- Supabase Auth trazia — confirmação de e-mail, recuperação de senha, OAuth,
-- refresh token — ou não se aplica aqui ou depende de SMTP que a instalação
-- não tem. O que sobrava era acoplamento: `perfis.id` amarrado a `auth.users`,
-- um trigger de onboarding para contornar isso, e o navegador precisando da
-- anon key só para fazer login.
--
-- Agora a API guarda `senha_hash` (scrypt) e assina o próprio JWT. O Supabase
-- continua sendo o BANCO — só deixou de ser o autenticador.
--
-- Idempotente: roda sobre banco novo e sobre o que já está no ar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O trigger de onboarding perde a razão de existir
--
-- Ele só existia para espelhar `auth.users` em `perfis`. Sem Supabase Auth não
-- há o que espelhar: quem cria perfil agora é a API, explicitamente.
-- ---------------------------------------------------------------------------
drop trigger if exists ao_criar_usuario on auth.users;
drop function if exists tratar_novo_usuario();

-- ---------------------------------------------------------------------------
-- perfis ganha identidade e senha próprias
-- ---------------------------------------------------------------------------
alter table perfis alter column id set default gen_random_uuid();

-- Nulo em perfil que ainda não tem senha definida. O login recusa esses:
-- perfil sem hash não entra por acidente, entra só depois que um admin define.
alter table perfis add column if not exists senha_hash text;

create unique index if not exists perfis_email_unico on perfis (email);

-- ---------------------------------------------------------------------------
-- Todas as FKs para auth.users passam a apontar para perfis
--
-- São nove colunas espalhadas por campanhas, canais, contatos, listas,
-- templates, spintax e logs. Deixá-las apontando para `auth.users` quebraria
-- todo INSERT: o id gravado agora é o do perfil, e não existe linha
-- correspondente lá.
--
-- O loop descobre as constraints pelo catálogo em vez de listar nome por nome —
-- nome de constraint é convenção, não contrato, e errar um deixaria uma tabela
-- silenciosamente quebrada.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select con.conname, cl.relname as tabela, att.attname as coluna
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    join pg_class rf on rf.oid = con.confrelid
    join pg_namespace rns on rns.oid = rf.relnamespace
    join lateral unnest(con.conkey) as k(attnum) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'f'
      and ns.nspname = 'public'
      and rns.nspname = 'auth'
      and rf.relname = 'users'
  loop
    execute format('alter table public.%I drop constraint %I', r.tabela, r.conname);

    -- `perfis.id` era a própria amarração ao Auth: some, não vira
    -- auto-referência.
    if not (r.tabela = 'perfis' and r.coluna = 'id') then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) '
        || 'references public.perfis (id) on delete set null',
        r.tabela, r.conname, r.coluna
      );
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nota sobre RLS
--
-- As políticas continuam de pé, mas passam a negar tudo para a anon key:
-- `papel_atual()` deriva de `auth.uid()`, que sem Supabase Auth é sempre nulo.
-- Isso é o desejado — o navegador não recebe mais chave nenhuma do Supabase, e
-- todo acesso passa pela API, que usa a service role e filtra por papel.
--
-- Deixar as políticas no lugar mantém a rede de segurança para o dia em que
-- alguém expuser o PostgREST: sem sessão, o padrão é negar.
-- ---------------------------------------------------------------------------
