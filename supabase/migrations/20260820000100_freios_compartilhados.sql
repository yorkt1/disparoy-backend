-- ============================================================================
-- Freios compartilhados entre as réplicas da API.
--
-- O `ThrottlerModule` do Nest conta em memória do PROCESSO, e `render.yaml`
-- roda `numInstances: 2` na API. O teto escrito no código valia por réplica:
-- "10 tentativas de login por minuto" era, na prática, 20 — e passaria a 30 no
-- dia em que alguém subisse a terceira réplica, sem nenhuma linha de código
-- mudar e sem nada na tela dizendo isso. Um contador que mente sobre o próprio
-- teto é pior do que não ter contador, porque ninguém o audita de novo.
--
-- Aqui o contador mora no Postgres, que as réplicas já compartilham. Não vale
-- para TODA requisição — pagar uma ida ao banco em cada chamada colocaria uma
-- escrita no caminho quente do webhook da Evolution, que é exatamente o erro
-- que `ROBUSTEZ.md` (item 4) documenta ter custado contenção de lock. Só as
-- rotas que pedem teto mais apertado que o global usam este freio; o resto
-- continua em memória. Ver `backend/src/comum/freio-armazenamento.ts`.
--
-- A mesma tabela sustenta o bloqueio de conta após N logins falhos. O freio
-- por IP não cobre o ataque inverso — muitos IPs tentando a MESMA conta —, e
-- esse é o formato de credential stuffing que se compra pronto hoje.
-- ============================================================================

create table if not exists freios (
  /**
   * Chave opaca. Para o rate limit é a chave que o Nest gera (rota + IP); para
   * o bloqueio de conta é `login:<sha256 do e-mail>`.
   *
   * O e-mail entra HASHEADO de propósito: esta tabela é escrita por rota
   * pública e sem sessão, e uma coluna de e-mails em claro alimentada por
   * qualquer um que bata no login vira uma lista de endereços tentados — que é
   * meio caminho para a lista de endereços que existem. Conferir uma conta
   * específica continua possível: basta hashear o e-mail e consultar.
   */
  chave            text primary key,
  ocorrencias      integer     not null default 0,
  janela_expira_em timestamptz not null,
  bloqueado_ate    timestamptz,
  atualizado_em    timestamptz not null default now()
);

-- Só a varredura de expurgo usa este índice; sem ele ela vira seq scan sobre
-- uma tabela cujo tamanho acompanha o número de IPs distintos vistos.
create index if not exists freios_expiracao_idx on freios (janela_expira_em);

-- Ninguém além da service role tem o que fazer aqui: a tabela é infraestrutura
-- de defesa, não dado de produto.
alter table freios enable row level security;

-- ---------------------------------------------------------------------------
-- Expurgo. A folga de uma hora depois da janela existe para não apagar a linha
-- de alguém que ainda está no meio de uma sequência de tentativas.
--
-- Definida antes de quem a chama porque `consumir_freio` a aciona: plpgsql não
-- resolve a chamada na criação, mas ler o arquivo de cima para baixo deveria
-- bastar para entender a ordem.
-- ---------------------------------------------------------------------------
create or replace function limpar_freios_expirados()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_apagados integer;
begin
  delete from freios
   where janela_expira_em < now() - interval '1 hour'
     and (bloqueado_ate is null or bloqueado_ate < now());

  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

-- ---------------------------------------------------------------------------
-- Conta uma ocorrência e devolve o veredito.
--
-- Formato de janela fixa, não deslizante: o `ThrottlerStorageService` em
-- memória decrementa cada acerto individualmente com um `setTimeout`, o que não
-- tem equivalente barato em SQL. A janela fixa é um pouco mais permissiva na
-- virada da janela e MUITO menos permissiva do que contar separado em cada
-- réplica, que é o que ela substitui.
--
-- Os nomes de saída evitam os nomes das colunas de propósito: em plpgsql, uma
-- variável homônima de coluna se resolve em silêncio para o lado errado.
-- ---------------------------------------------------------------------------
create or replace function consumir_freio(
  p_chave       text,
  p_ttl_ms      integer,
  p_limite      integer,
  p_bloqueio_ms integer
) returns table (
  total             integer,
  janela_segundos   integer,
  bloqueado         boolean,
  bloqueio_segundos integer
)
language plpgsql security definer set search_path = public as $$
declare
  v_agora timestamptz := now();
  v_linha freios%rowtype;
begin
  insert into freios (chave, ocorrencias, janela_expira_em)
  values (p_chave, 1, v_agora + make_interval(secs => p_ttl_ms / 1000.0))
  on conflict (chave) do update set
    -- Durante o bloqueio a contagem congela. Sem isto, quem insiste enquanto
    -- está bloqueado empurra o contador para sempre e nunca mais destrava.
    ocorrencias = case
      when freios.bloqueado_ate is not null and freios.bloqueado_ate > v_agora
        then freios.ocorrencias
      when freios.janela_expira_em <= v_agora then 1
      else freios.ocorrencias + 1
    end,
    janela_expira_em = case
      when freios.bloqueado_ate is not null and freios.bloqueado_ate > v_agora
        then freios.janela_expira_em
      when freios.janela_expira_em <= v_agora
        then v_agora + make_interval(secs => p_ttl_ms / 1000.0)
      else freios.janela_expira_em
    end,
    bloqueado_ate = case
      when freios.bloqueado_ate is not null and freios.bloqueado_ate > v_agora
        then freios.bloqueado_ate
      when freios.janela_expira_em > v_agora and freios.ocorrencias + 1 > p_limite
        then v_agora + make_interval(secs => p_bloqueio_ms / 1000.0)
      else null
    end,
    atualizado_em = v_agora
  returning * into v_linha;

  total     := v_linha.ocorrencias;
  bloqueado := v_linha.bloqueado_ate is not null and v_linha.bloqueado_ate > v_agora;

  janela_segundos := greatest(
    0, ceil(extract(epoch from (v_linha.janela_expira_em - v_agora)))
  )::integer;

  bloqueio_segundos := case
    when bloqueado then greatest(
      0, ceil(extract(epoch from (v_linha.bloqueado_ate - v_agora)))
    )::integer
    else 0
  end;

  /**
   * Varredura oportunista.
   *
   * A tabela cresce com o número de chaves distintas vistas — e numa rota
   * pública isso é "quantos IPs bateram aqui", que sob ataque é ilimitado.
   * O cron de manutenção vive no worker, que não conhece esta tabela; até que
   * conheça (`limpar_freios_expirados` está pronta para ele), limpar em 1% das
   * chamadas mantém a tabela do tamanho do tráfego vivo sem depender de
   * agendamento nenhum.
   */
  if random() < 0.01 then
    perform limpar_freios_expirados();
  end if;

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Quanto falta do bloqueio, em segundos. Zero = livre.
--
-- Separada de `consumir_freio` porque o login precisa PERGUNTAR antes de
-- derivar a senha: consultar incrementando faria o próprio pedido bloqueado
-- renovar o bloqueio para sempre.
-- ---------------------------------------------------------------------------
create or replace function estado_do_freio(p_chave text)
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select greatest(0, ceil(extract(epoch from (bloqueado_ate - now()))))::integer
       from freios
      where chave = p_chave
        and bloqueado_ate is not null
        and bloqueado_ate > now()),
    0
  );
$$;

-- Login que deu certo zera o histórico da conta: quem provou ser o dono não
-- deve continuar a um passo do bloqueio por causa dos erros de digitação dele.
create or replace function limpar_freio(p_chave text)
returns void
language sql security definer set search_path = public as $$
  delete from freios where chave = p_chave;
$$;

-- ---------------------------------------------------------------------------
-- Só a service role executa isto.
--
-- As demais funções do projeto ficam com o `grant` padrão porque operam sobre
-- dado de produto, que o RLS já protege. Estas quatro são o contrário: quem as
-- alcança destrava o próprio bloqueio (`limpar_freio`) ou tranca a conta de um
-- terceiro (`consumir_freio` com a chave dele). O sistema não distribui a anon
-- key para navegador nenhum — mas uma função que só a API deveria chamar não
-- tem por que ficar exposta esperando esse dia.
--
-- Guardado por `pg_roles` para a migration continuar rodando fora do Supabase,
-- onde `anon`/`authenticated` não existem.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function consumir_freio(text, integer, integer, integer) from anon, authenticated';
    execute 'revoke execute on function estado_do_freio(text) from anon, authenticated';
    execute 'revoke execute on function limpar_freio(text) from anon, authenticated';
    execute 'revoke execute on function limpar_freios_expirados() from anon, authenticated';
  end if;
end;
$$;
