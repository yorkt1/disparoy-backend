-- ============================================================================
-- Empresas: o dado passa a ter dono.
--
-- O schema original diz, com todas as letras, que o sistema é single-tenant:
-- "um único negócio, vários logins", e contatos/listas/templates/variações são
-- compartilhados de propósito. Isso deixou de ser verdade — cada empresa
-- cliente terá sua conta (`acesso@empresa.com`), e uma conta global de
-- administração enxerga todas.
--
-- O que isso conserta não é arrumação: hoje `contatos.telefone` é único GLOBAL
-- e a importação faz upsert por telefone. A segunda empresa que subir um número
-- que a primeira já tem não cria uma linha nova — ela ASSUME a linha da
-- primeira, herda nome, tags e variáveis, e passa a poder incluí-la nas
-- próprias listas. É vazamento entre clientes, e acontece no primeiro dia com
-- dois clientes.
--
-- ---------------------------------------------------------------------------
-- Esta migration é de propósito NÃO destrutiva e pode ser aplicada sozinha.
--
-- `empresa_id` entra com default apontando para a empresa padrão, que recebe
-- todo o dado que já existe. Enquanto a API não for atualizada, todo insert cai
-- na empresa padrão e o sistema se comporta exatamente como hoje. A troca do
-- default por `not null` é a migration seguinte, depois de a API passar a
-- informar o dono em toda escrita — separado para que um deploy pela metade
-- não derrube a importação de contatos.
-- ---------------------------------------------------------------------------
-- ============================================================================

create table if not exists empresas (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null check (length(trim(nome)) between 2 and 120),
  ativa     boolean not null default true,
  criada_em timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- A empresa padrão: dona de tudo que já existe.
--
-- Id fixo em vez de sorteado porque a migration precisa ser idempotente e as
-- linhas de baixo referenciam este id. Com `gen_random_uuid()` cada execução
-- criaria uma empresa nova e o backfill apontaria para outro dono.
-- ---------------------------------------------------------------------------
insert into empresas (id, nome)
values ('00000000-0000-0000-0000-000000000001', 'Empresa padrão')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Quem é de qual empresa.
--
-- `null` significa acesso global — é a conta de administração, que enxerga
-- todas as empresas. Por isso a coluna NÃO é `not null`: a ausência de empresa
-- é um estado legítimo, não um dado faltando.
--
-- Os admins que já existem ficam com `null`, que é exatamente o que eles têm
-- hoje: acesso a tudo. Operadores existentes vão para a empresa padrão.
-- ---------------------------------------------------------------------------
alter table perfis
  add column if not exists empresa_id uuid references empresas (id) on delete restrict;

update perfis
   set empresa_id = '00000000-0000-0000-0000-000000000001'
 where empresa_id is null
   and papel = 'operator';

create index if not exists perfis_empresa_idx on perfis (empresa_id);

/**
 * Empresa do usuário autenticado, para uso em políticas RLS.
 *
 * `security definer` pelo mesmo motivo de `papel_atual()`: precisa enxergar
 * `perfis` mesmo com RLS ativo na própria tabela. Devolve `null` para a conta
 * de administração — quem escrever política com esta função precisa tratar o
 * `null` como "vê tudo", nunca como "não vê nada".
 */
create or replace function empresa_atual()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select empresa_id from perfis where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- O dono em cada tabela de dado do cliente.
--
-- `campanhas` e `canais` entram junto mesmo já tendo `canal_membros`: aquele
-- vínculo diz quem OPERA o canal dentro do time, não de quem ele é. São
-- perguntas diferentes, e responder as duas com a mesma tabela faria o dia em
-- que uma empresa tiver dois logins virar um bug de vazamento.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['contatos', 'listas', 'templates', 'spintax', 'campanhas', 'canais']
  loop
    execute format(
      'alter table %I add column if not exists empresa_id uuid
         references empresas (id) on delete restrict
         default ''00000000-0000-0000-0000-000000000001''::uuid',
      t
    );
    execute format(
      'update %I set empresa_id = ''00000000-0000-0000-0000-000000000001''::uuid
        where empresa_id is null',
      t
    );
    execute format('create index if not exists %I on %I (empresa_id)', t || '_empresa_idx', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- As unicidades passam a valer POR EMPRESA. É o coração desta migration.
--
-- Sem isto, `empresa_id` seria decoração: a empresa B continuaria colidindo com
-- a linha da empresa A no telefone e o upsert seguiria assumindo a linha alheia.
--
-- Os nomes de constraint são os que o Postgres gera para `unique` declarado na
-- coluna (`<tabela>_<coluna>_key`). `if exists` mantém a migration idempotente
-- e a deixa rodar mesmo num banco onde ela já passou.
-- ---------------------------------------------------------------------------
alter table contatos  drop constraint if exists contatos_telefone_key;
alter table templates drop constraint if exists templates_nome_idioma_key;
alter table spintax   drop constraint if exists spintax_nome_key;

create unique index if not exists contatos_empresa_telefone_idx
  on contatos (empresa_id, telefone);

create unique index if not exists templates_empresa_nome_idioma_idx
  on templates (empresa_id, nome, idioma);

create unique index if not exists spintax_empresa_nome_idx
  on spintax (empresa_id, nome);

-- ---------------------------------------------------------------------------
-- Uma lista não pode misturar contatos de duas empresas.
--
-- `lista_contatos` não ganha `empresa_id`: duplicar o dono numa tabela de
-- ligação cria a chance de ele divergir das duas pontas. O trigger compara as
-- pontas a cada inserção, que é a única forma de a regra não depender de todo
-- caminho de escrita lembrar dela — e o caminho que hoje erra é justamente o
-- `vincularALista` da importação.
-- ---------------------------------------------------------------------------
create or replace function verificar_lista_mesma_empresa()
returns trigger
language plpgsql
as $$
declare
  v_empresa_lista  uuid;
  v_empresa_contato uuid;
begin
  select empresa_id into v_empresa_lista   from listas   where id = new.lista_id;
  select empresa_id into v_empresa_contato from contatos where id = new.contato_id;

  if v_empresa_lista is distinct from v_empresa_contato then
    raise exception 'Contato % não pertence à empresa da lista %', new.contato_id, new.lista_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists lista_contatos_mesma_empresa on lista_contatos;
create trigger lista_contatos_mesma_empresa
  before insert or update on lista_contatos
  for each row execute function verificar_lista_mesma_empresa();

alter table empresas enable row level security;
