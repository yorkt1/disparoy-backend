-- ============================================================================
-- Isolamento entre empresas, no banco.
--
-- ---------------------------------------------------------------------------
-- LEIA ISTO ANTES DE CONFIAR NAS POLÍTICAS ABAIXO
-- ---------------------------------------------------------------------------
-- A API do Disparoy conecta com a SERVICE ROLE do Supabase, e esse papel é
-- criado com `BYPASSRLS`. Nenhuma política deste arquivo — nem `force row
-- level security` — se aplica a ele. Isso é fato do produto, não escolha
-- daqui, e não há como contorná-lo mantendo o supabase-js como transporte:
-- trocar o papel exigiria um JWT assinado com o segredo do projeto, que o
-- Disparoy não tem (a autenticação é própria, ver 20260809000200).
--
-- Portanto, o que esta migration entrega são TRÊS camadas com alcances
-- diferentes, e é honesto saber qual cobre o quê:
--
--  1. TRIGGERS DE COERÊNCIA (secção 3) — valem para TODO MUNDO, service role
--     inclusive. São a única defesa real contra um caminho da API que esqueça
--     `noEscopo()` numa ESCRITA: vincular canal da empresa A a campanha da
--     empresa B passa a ser um erro do Postgres, não um vazamento silencioso.
--
--  2. POLÍTICAS RLS (secção 2) — valem para qualquer conexão que NÃO seja
--     service role: PostgREST com anon key, um painel de BI, um `psql` com
--     papel de aplicação, o relatório que alguém vai plugar no ano que vem.
--     Hoje elas negam tudo (não há sessão), e passam a NEGAR POR EMPRESA
--     assim que houver — que é a diferença entre "ninguém entra" e "cada um
--     entra na sua casa".
--
--  3. IDENTIDADE POR GUC (secção 1) — o que faz (2) deixar de ser decoração.
--     `auth.uid()` é sempre nulo desde que o login virou próprio, então toda
--     política escrita sobre ele nega tudo, para sempre, inclusive para quem
--     deveria poder ler. `perfil_atual()` passa a resolver o usuário por
--     `set_config('app.perfil_id', ...)`, que é como uma conexão direta se
--     identifica sem depender do Supabase Auth.
--
-- O que continua sem cobertura de banco é a LEITURA feita pela própria API
-- com service role. Ela é defendida no NestJS (`comum/escopo.ts`) e verificada
-- por teste (`comum/isolamento.test.ts`, `comum/escopo-cobertura.test.ts`).
--
-- O worker não é afetado: ele usa a mesma service role e não tem usuário
-- autenticado — `perfil_atual()` devolve nulo para ele e nenhuma política o
-- alcança, exatamente como hoje.
--
-- Idempotente.
-- ============================================================================

-- ===========================================================================
-- 1. Quem é o usuário atual, sem Supabase Auth
-- ===========================================================================

/**
 * O perfil da sessão corrente.
 *
 * Três fontes, nesta ordem:
 *
 *  1. `app.perfil_id` — GUC definido por quem abre a conexão
 *     (`select set_config('app.perfil_id', '<uuid>', true)` dentro da
 *     transação). É o caminho que funciona com o JWT próprio do Disparoy.
 *  2. `sub` de `request.jwt.claims` — o que o PostgREST publica quando aceita
 *     um token. Fica aqui para o dia em que o projeto emitir um JWT que ele
 *     reconheça; hoje não emite, e a expressão simplesmente não casa.
 *  3. `auth.uid()` — herança do Supabase Auth, sempre nula desde
 *     20260809000200. Mantida por compatibilidade e resolvida por
 *     `to_regprocedure` para a migration continuar rodando fora do Supabase,
 *     onde o schema `auth` não existe.
 *
 * `stable` e não `immutable`: o valor muda entre transações.
 */
create or replace function perfil_atual()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_bruto text;
  v_id    uuid;
begin
  v_bruto := nullif(current_setting('app.perfil_id', true), '');

  if v_bruto is null then
    -- `request.jwt.claims` pode vir ausente ou não ser jsonb válido conforme
    -- o transporte. Um erro aqui derrubaria toda política que chama esta
    -- função, o que na prática é o banco inteiro fora do ar.
    begin
      v_bruto := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '');
    exception
      when others then v_bruto := null;
    end;
  end if;

  if v_bruto is null and to_regprocedure('auth.uid()') is not null then
    begin
      execute 'select auth.uid()' into v_id;
      return v_id;
    exception
      when others then return null;
    end;
  end if;

  begin
    return v_bruto::uuid;
  exception
    when invalid_text_representation then return null;
  end;
end;
$$;

/**
 * As funções de papel passam a derivar de `perfil_atual()`.
 *
 * Estavam presas a `auth.uid()` desde o schema original. Depois que o login
 * virou próprio, isso as congelou em "sempre nulo" — `eh_ativo()` respondendo
 * `false` para todo mundo faz `using (eh_ativo())` negar tudo, o que parece
 * seguro e não é: uma política que nunca libera nada é uma política que
 * ninguém testa, e no dia em que alguém precisar liberar o acesso ela é
 * reescrita às pressas, sem o filtro de empresa.
 */
create or replace function papel_atual()
returns papel_usuario
language sql
stable
security definer
set search_path = public
as $$
  select papel from perfis where id = perfil_atual() and ativo;
$$;

create or replace function eh_ativo()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from perfis where id = perfil_atual() and ativo);
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

/**
 * A empresa do usuário atual. `null` para a conta global.
 *
 * Quem escrever política com esta função precisa tratar o nulo como "vê tudo"
 * — e nunca comparar direto: `empresa_id = null` é NULL, que em `using` vale
 * `false`, e o admin global deixaria de ver o próprio sistema. Por isso existe
 * `eh_global()` logo abaixo, e é ela que as políticas usam.
 */
create or replace function empresa_atual()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select empresa_id from perfis where id = perfil_atual() and ativo;
$$;

/**
 * A conta de administração do sistema: ativa e sem empresa.
 *
 * É o que separa "operação administrativa/global" de "operação de usuário
 * normal". Note que `papel = 'admin'` NÃO entra: cada empresa cliente tem o
 * próprio admin, e ele administra a empresa dele. Confundir os dois foi um
 * furo real do lado da API (ver `canais.service.ts`, `exigirAcesso`).
 */
create or replace function eh_global()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from perfis
     where id = perfil_atual() and ativo and empresa_id is null
  );
$$;

/**
 * A linha é visível para a sessão atual?
 *
 * Um lugar só para a regra, para as vinte políticas abaixo não divergirem —
 * mesma razão de `noEscopo()` existir do lado do NestJS.
 */
create or replace function empresa_visivel(p_empresa_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select eh_global() or (p_empresa_id is not null and p_empresa_id = empresa_atual());
$$;

/**
 * `pode_operar_canal` deixa de liberar canal de outra empresa.
 *
 * A versão anterior era `eh_admin() or exists (canal_membros ...)`. As duas
 * pernas vazavam: `eh_admin()` é verdadeiro para o admin de QUALQUER empresa,
 * e `canal_membros` liga perfil a canal sem mencionar empresa nenhuma — um
 * vínculo cruzado (perfil que mudou de empresa, vínculo plantado) bastava.
 * A empresa é conferida ANTES, que é a mesma ordem que a API já adotou.
 */
create or replace function pode_operar_canal(p_canal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from canais c
     where c.id = p_canal_id
       and empresa_visivel(c.empresa_id)
       and (
         eh_global()
         or eh_admin()
         or exists (
           select 1 from canal_membros m
            where m.canal_id = c.id and m.perfil_id = perfil_atual()
         )
       )
  );
$$;

-- ===========================================================================
-- 2. As políticas passam a filtrar por empresa
--
-- As antigas eram `for select using (eh_ativo())`: "usuário ativo lê a base
-- compartilhada", que era verdade quando o sistema era single-tenant e deixou
-- de ser em 20260815000200. Trocá-las é o item central desta migration.
--
-- `for all` e não só `for select`: as originais cobriam apenas leitura porque
-- "escrita passa sempre pela API". Continua passando — mas uma política que
-- só existe para SELECT deixa INSERT/UPDATE/DELETE sem regra nenhuma no dia
-- em que outra conexão chegar, e é justamente o caminho que faz estrago.
-- ===========================================================================

do $$
declare
  t text;
begin
  /*
   * Tabelas com `empresa_id` próprio: a regra é direta.
   *
   * `canais` fica FORA da lista e tem política própria mais abaixo. A regra
   * dele não é só empresa: operador enxerga apenas canal em que foi vinculado
   * (`canal_membros`), e é assim desde o schema original. Uma política só de
   * empresa aqui seria mais FROUXA que a aplicação — o operador passaria a ver
   * pelo banco um número que a tela dele esconde.
   */
  foreach t in array array[
    'contatos', 'listas', 'templates', 'spintax', 'campanhas', 'opt_outs'
  ]
  loop
    execute format('alter table %I enable row level security', t);

    -- As políticas antigas somem: manter `..._visiveis on using (eh_ativo())`
    -- ao lado da nova seria pior que não ter nenhuma — políticas se somam por
    -- OR, e a permissiva anularia a restritiva.
    execute format('drop policy if exists %I on %I', t || '_visiveis', t);
    execute format('drop policy if exists %I on %I', t || '_visivel', t);
    execute format('drop policy if exists %I on %I', t || '_por_empresa', t);

    execute format(
      'create policy %I on %I for all
         using (empresa_visivel(empresa_id))
         with check (empresa_visivel(empresa_id))',
      t || '_por_empresa', t
    );
  end loop;
end;
$$;

-- --- Tabelas que herdam o dono de outra ------------------------------------
--
-- Não ganham `empresa_id` próprio de propósito: duplicar o dono numa tabela
-- de ligação cria a chance de ele divergir das duas pontas (mesma decisão da
-- migration 20260815000200 para `lista_contatos`). O `exists` custa uma busca
-- por chave primária, que é o que o planejador já faria pelo FK.

alter table campanha_canais   enable row level security;
alter table campanha_contatos enable row level security;
alter table mensagens_enviadas enable row level security;
alter table lista_contatos    enable row level security;
alter table canal_membros     enable row level security;

/*
 * `force row level security` NÃO é usado em lugar nenhum deste arquivo, e não
 * por esquecimento.
 *
 * Ele só remove a isenção do DONO da tabela — que aqui é `postgres`, o papel
 * que roda a migration, não um caminho de aplicação. Em troca, ele criaria um
 * risco concreto: as funções de identidade da secção 1 são `security definer`
 * e rodam justamente como `postgres`. Se esse papel não tiver `BYPASSRLS` na
 * instalação, `eh_ativo()` passaria a ler `perfis` SOB a política de `perfis`,
 * que chama `eh_ativo()` — recursão infinita (42P17) em toda consulta, ou
 * seja, banco fora do ar. Ganho marginal, risco de derrubar tudo.
 */
drop policy if exists campanha_canais_visiveis   on campanha_canais;
drop policy if exists campanha_contatos_visiveis on campanha_contatos;
drop policy if exists mensagens_visiveis         on mensagens_enviadas;
drop policy if exists lista_contatos_visiveis    on lista_contatos;
drop policy if exists canal_membros_visiveis     on canal_membros;

drop policy if exists campanha_canais_por_empresa   on campanha_canais;
create policy campanha_canais_por_empresa on campanha_canais
  for all
  using (exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)))
  with check (exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)));

drop policy if exists campanha_contatos_por_empresa on campanha_contatos;
create policy campanha_contatos_por_empresa on campanha_contatos
  for all
  using (exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)))
  with check (exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)));

drop policy if exists mensagens_por_empresa on mensagens_enviadas;
create policy mensagens_por_empresa on mensagens_enviadas
  for all
  using (exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)))
  with check (exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)));

drop policy if exists lista_contatos_por_empresa on lista_contatos;
create policy lista_contatos_por_empresa on lista_contatos
  for all
  using (exists (select 1 from listas l where l.id = lista_id and empresa_visivel(l.empresa_id)))
  with check (exists (select 1 from listas l where l.id = lista_id and empresa_visivel(l.empresa_id)));

/*
 * `canais`: empresa E vínculo, não só empresa.
 *
 * `pode_operar_canal` foi reescrita no topo deste arquivo para conferir a
 * empresa ANTES do papel — a versão antiga liberava para `eh_admin()`, que é
 * verdadeiro para o admin de QUALQUER empresa. Com ela, a política diz a mesma
 * coisa que `CanaisService.listar`: a conta global vê tudo, o admin vê os da
 * empresa dele, o operador vê aqueles em que foi vinculado.
 *
 * O `with check` é só a empresa: quem cria um canal ainda não pode ser membro
 * dele — o vínculo de dono é inserido logo depois, na mesma requisição.
 */
alter table canais enable row level security;
drop policy if exists canais_visiveis on canais;
drop policy if exists canais_por_empresa on canais;
create policy canais_por_empresa on canais
  for all
  using (pode_operar_canal(id))
  with check (empresa_visivel(empresa_id));

drop policy if exists canal_membros_por_empresa on canal_membros;
/*
 * O vínculo é pessoal, como era: cada um vê o próprio, o admin vê os da
 * empresa dele, a conta global vê todos. Uma política só de empresa deixaria
 * um operador ler quem mais opera cada número do cliente — informação de
 * gestão de acesso, não de operação diária.
 */
create policy canal_membros_por_empresa on canal_membros
  for all
  using (
    perfil_id = perfil_atual()
    or eh_global()
    or (eh_admin()
        and exists (select 1 from canais c where c.id = canal_id and empresa_visivel(c.empresa_id)))
  )
  with check (
    eh_global()
    or (eh_admin()
        and exists (select 1 from canais c where c.id = canal_id and empresa_visivel(c.empresa_id)))
  );

-- --- Perfis, empresas, avisos, incidentes, auditoria -----------------------

drop policy if exists perfil_proprio on perfis;
drop policy if exists perfis_por_empresa on perfis;
/*
 * Todo mundo lê o próprio perfil; o admin lê os da empresa dele; a conta
 * global lê todos. `eh_admin()` sozinho era o furo: o admin da empresa A
 * enxergava (e, sem política de escrita, poderia alterar) o perfil de B.
 */
create policy perfis_por_empresa on perfis
  for all
  using (id = perfil_atual() or eh_global() or (eh_admin() and empresa_visivel(empresa_id)))
  with check (eh_global() or (eh_admin() and empresa_visivel(empresa_id)));

alter table empresas enable row level security;
drop policy if exists empresas_por_empresa on empresas;
-- Cada cliente enxerga a própria empresa (o painel mostra o nome dela);
-- criar, renomear e desativar empresa é operação global.
create policy empresas_por_empresa on empresas
  for select using (eh_global() or id = empresa_atual());

alter table incidentes enable row level security;
drop policy if exists incidentes_por_empresa on incidentes;
/*
 * Incidente com canal ou campanha herda o dono deles. O que não tem nenhum dos
 * dois é infraestrutura — `worker_parado`, por exemplo — e fica restrito à
 * conta global: dizer ao cliente "o worker caiu" é papel do produto, não da
 * tabela crua, e o detalhe ali dentro fala de processo nosso.
 */
create policy incidentes_por_empresa on incidentes
  for select using (
    eh_global()
    or (canal_id is not null
        and exists (select 1 from canais c where c.id = canal_id and empresa_visivel(c.empresa_id)))
    or (campanha_id is not null
        and exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)))
  );

alter table notificacoes enable row level security;
drop policy if exists notificacoes_do_perfil on notificacoes;
-- A caixa é pessoal: nem o admin da empresa lê o sininho de outra pessoa.
create policy notificacoes_do_perfil on notificacoes
  for all using (perfil_id = perfil_atual()) with check (perfil_id = perfil_atual());

drop policy if exists logs_admin on logs_auditoria;
drop policy if exists logs_por_empresa on logs_auditoria;
-- Trilha continua sendo material de investigação: admin, e só da própria
-- empresa. Log de sistema (`empresa_id is null`) fica com a conta global.
create policy logs_por_empresa on logs_auditoria
  for select using (eh_global() or (eh_admin() and empresa_visivel(empresa_id)));

/*
 * `eventos_webhook`, `freios`, `worker_pulso` e as tabelas de infraestrutura
 * seguem com RLS ligado e SEM política: o padrão do Postgres é negar, e é o
 * que deve valer. São dados de processo, não de produto — quem precisa deles
 * é a service role e mais ninguém.
 */

-- ===========================================================================
-- 3. Coerência de empresa nas ligações — a camada que vale para todos
--
-- Estes triggers são a única parte deste arquivo que alcança a SERVICE ROLE.
-- Se um caminho da API esquecer `noEscopo()` numa escrita e tentar amarrar
-- dado de duas empresas, o INSERT falha aqui — em vez de gravar o vazamento.
--
-- Mesma forma de `verificar_lista_mesma_empresa` (20260815000200), que já
-- provou o padrão em `lista_contatos`.
-- ===========================================================================

/** Erro único para os quatro triggers: a mensagem tem que dizer o quê e onde. */
create or replace function recusar_mistura_de_empresa(
  p_relacao text,
  p_esquerda text,
  p_direita  text
) returns void
language plpgsql
as $$
begin
  raise exception
    'Isolamento entre empresas: % liga % a %, que são de empresas diferentes.',
    p_relacao, p_esquerda, p_direita
    using errcode = 'check_violation';
end;
$$;

create or replace function verificar_campanha_canal_mesma_empresa()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_campanha uuid;
  v_canal    uuid;
begin
  select empresa_id into v_campanha from campanhas where id = new.campanha_id;
  select empresa_id into v_canal    from canais    where id = new.canal_id;

  if v_campanha is distinct from v_canal then
    perform recusar_mistura_de_empresa(
      'campanha_canais',
      format('campanha %s', new.campanha_id),
      format('canal %s', new.canal_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists campanha_canais_mesma_empresa on campanha_canais;
create trigger campanha_canais_mesma_empresa
  before insert or update on campanha_canais
  for each row execute function verificar_campanha_canal_mesma_empresa();

create or replace function verificar_campanha_contato_mesma_empresa()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_campanha uuid;
  v_contato  uuid;
  v_canal    uuid;
begin
  select empresa_id into v_campanha from campanhas where id = new.campanha_id;

  /*
   * `contato_id` nulo é o caso NORMAL desde 20260815000500: o público entra
   * direto da planilha e não existe linha em `contatos` para apontar. Só há o
   * que conferir quando ele existe — campanhas antigas, criadas por lista.
   */
  if new.contato_id is not null then
    select empresa_id into v_contato from contatos where id = new.contato_id;
    if v_campanha is distinct from v_contato then
      perform recusar_mistura_de_empresa(
        'campanha_contatos',
        format('campanha %s', new.campanha_id),
        format('contato %s', new.contato_id)
      );
    end if;
  end if;

  -- `canal_id` é preenchido pelo worker na hora do envio: é o ponto em que um
  -- rodízio mal filtrado mandaria a mensagem de um cliente pelo número de
  -- outro. É a pior mistura possível do sistema, e é a mais barata de barrar.
  if new.canal_id is not null then
    select empresa_id into v_canal from canais where id = new.canal_id;
    if v_campanha is distinct from v_canal then
      perform recusar_mistura_de_empresa(
        'campanha_contatos',
        format('campanha %s', new.campanha_id),
        format('canal %s', new.canal_id)
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists campanha_contatos_mesma_empresa on campanha_contatos;
/*
 * `when` limita o custo ao que importa.
 *
 * `popular_publico_da_campanha` insere o público inteiro num comando só — até
 * 20 mil linhas. Sem esta cláusula, cada uma pagaria duas buscas mesmo com os
 * dois campos nulos, que é o caso da esmagadora maioria delas.
 */
create trigger campanha_contatos_mesma_empresa
  before insert or update on campanha_contatos
  for each row
  when (new.contato_id is not null or new.canal_id is not null)
  execute function verificar_campanha_contato_mesma_empresa();

create or replace function verificar_mensagem_mesma_empresa()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_campanha uuid;
  v_canal    uuid;
begin
  if new.canal_id is null then return new; end if;

  select empresa_id into v_campanha from campanhas where id = new.campanha_id;
  select empresa_id into v_canal    from canais    where id = new.canal_id;

  if v_campanha is distinct from v_canal then
    perform recusar_mistura_de_empresa(
      'mensagens_enviadas',
      format('campanha %s', new.campanha_id),
      format('canal %s', new.canal_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists mensagens_mesma_empresa on mensagens_enviadas;
create trigger mensagens_mesma_empresa
  before insert on mensagens_enviadas
  for each row
  when (new.canal_id is not null)
  execute function verificar_mensagem_mesma_empresa();

create or replace function verificar_canal_membro_mesma_empresa()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_canal  uuid;
  v_perfil uuid;
begin
  select empresa_id into v_canal  from canais where id = new.canal_id;
  select empresa_id into v_perfil from perfis where id = new.perfil_id;

  -- Perfil sem empresa é a conta global de suporte: opera qualquer canal de
  -- propósito, e barrá-la aqui tiraria justamente o acesso que existe para
  -- socorrer o cliente.
  if v_perfil is null then return new; end if;

  if v_canal is distinct from v_perfil then
    perform recusar_mistura_de_empresa(
      'canal_membros',
      format('canal %s', new.canal_id),
      format('perfil %s', new.perfil_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists canal_membros_mesma_empresa on canal_membros;
create trigger canal_membros_mesma_empresa
  before insert or update on canal_membros
  for each row execute function verificar_canal_membro_mesma_empresa();

-- ===========================================================================
-- 4. Vínculos cruzados que já existam no banco
--
-- A migration não APAGA nada: um vínculo cruzado pode ser o acesso que alguém
-- usa agora, e removê-lo em silêncio troca um vazamento por um chamado de
-- suporte sem explicação. Ela AVISA, com a lista, para a decisão ser humana.
-- ===========================================================================
do $$
declare
  v_membros integer;
  v_canais  integer;
begin
  select count(*) into v_membros
    from canal_membros m
    join canais c on c.id = m.canal_id
    join perfis p on p.id = m.perfil_id
   where p.empresa_id is not null
     and p.empresa_id is distinct from c.empresa_id;

  select count(*) into v_canais
    from campanha_canais cc
    join campanhas ca on ca.id = cc.campanha_id
    join canais    cn on cn.id = cc.canal_id
   where ca.empresa_id is distinct from cn.empresa_id;

  if v_membros > 0 or v_canais > 0 then
    raise warning
      'Isolamento: % vínculo(s) perfil-canal e % vínculo(s) campanha-canal cruzam empresas. '
      'Eles continuam no banco, mas os triggers criados agora recusam novos. '
      'Confira com: select * from canal_membros m join canais c on c.id=m.canal_id '
      'join perfis p on p.id=m.perfil_id where p.empresa_id is distinct from c.empresa_id;',
      v_membros, v_canais;
  end if;
end;
$$;
