-- ============================================================================
-- Limites operacionais por empresa.
--
-- O worker é UM processo, com uma fila, compartilhada por todos os clientes.
-- Hoje nada impede que um deles importe 300 mil contatos e ocupe o worker por
-- dias — os outros não recebem erro nenhum, as campanhas deles simplesmente
-- não andam. É a falha mais difícil de diagnosticar do produto, porque tudo
-- parece saudável: fila no ar, worker batendo pulso, campanhas "em andamento".
--
-- Isto NÃO é billing e não pretende virar. Não há preço, não há fatura, não há
-- gateway de pagamento e não há tabela de planos com features. Há um `plano`
-- em `empresas`, que é só um RÓTULO, e o número que aquele rótulo significa
-- mora no código (`backend/src/comum/limites-empresa.ts`) — um lugar só, em
-- TypeScript, onde dá para ler, testar e mudar sem migration.
--
-- Por que o número não mora aqui: limite é regra de negócio, e regra de
-- negócio espalhada entre uma tabela e um arquivo diverge. O banco guarda o
-- CONSUMO (que precisa ser atômico e compartilhado entre processos); o código
-- guarda o TETO (que precisa ser legível e versionado junto do resto).
--
-- Idempotente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O rótulo do plano. Ponto de extensão, não sistema de planos.
--
-- `text` e não enum: acrescentar valor a um enum exige migration própria e não
-- fica visível para função `language sql` criada na mesma transação (ver o
-- CLAUDE.md do repositório). Um rótulo livre com default é o que permite criar
-- 'piloto' ou 'parceiro' amanhã mexendo só no mapa do TypeScript.
-- ---------------------------------------------------------------------------
alter table empresas
  add column if not exists plano text not null default 'padrao';

-- ---------------------------------------------------------------------------
-- Consumo diário de mensagens, por empresa.
--
-- Tabela própria, e não uma coluna em `empresas` no molde de
-- `canais.enviadas_hoje`: aquele padrão perde o histórico na virada do dia, e
-- aqui o histórico é o que responde "esse cliente bate no teto todo dia ou foi
-- uma vez só?" — que é a pergunta que decide se o limite está no lugar certo.
--
-- Uma linha por empresa por dia. `limpar_cotas_empresa_antigas` faz a
-- retenção, chamada pela manutenção junto com as outras limpezas.
-- ---------------------------------------------------------------------------
create table if not exists empresa_cotas (
  empresa_id  uuid not null references empresas (id) on delete cascade,
  dia         date not null default current_date,
  consumidas  integer not null default 0 check (consumidas >= 0),
  -- Guardado para o log/painel dizerem "bateu no teto às 14h", não só "bateu".
  atingido_em timestamptz,
  primary key (empresa_id, dia)
);

alter table empresa_cotas enable row level security;

drop policy if exists empresa_cotas_por_empresa on empresa_cotas;
create policy empresa_cotas_por_empresa on empresa_cotas
  for select using (empresa_visivel(empresa_id));

/**
 * Consome cota diária da empresa. `false` significa "não pode enviar agora".
 *
 * O teto chega por parâmetro porque ele mora no código (ver o cabeçalho).
 * `p_limite` nulo é "sem teto" — mesma convenção de `canais.limite_diario`,
 * para não haver duas leituras de "ilimitado" no sistema.
 *
 * Atômico de propósito: `insert ... on conflict do update` com o teste do teto
 * DENTRO do `where` do update. Ler o total e depois gravar deixaria dois
 * envios simultâneos passarem juntos pelo limite — e o worker roda a fila de
 * contatos com `batchSize` maior que 1 quando alguém sobe
 * `DISPARO_CONCORRENCIA_POR_CANAL`, então é concorrência real, não teórica.
 *
 * O `returning` diz se a linha foi de fato atualizada: sem `where`, o
 * `on conflict do update` sempre grava, e não haveria como distinguir "consumi"
 * de "estourei".
 */
create or replace function consumir_cota_empresa(
  p_empresa_id uuid,
  p_quantidade integer,
  p_limite     integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  if p_empresa_id is null or p_quantidade <= 0 then
    -- Sem empresa não há cota a consumir. Devolver `true` mantém o
    -- comportamento anterior para qualquer caminho que ainda não passe a
    -- empresa — barrar aqui pararia disparo por causa de dado faltando, que é
    -- trocar um problema por um pior.
    return true;
  end if;

  /*
   * Lote maior que o teto do DIA INTEIRO: recusa antes de tocar na tabela.
   *
   * O `on conflict do update ... where` abaixo não pega este caso quando a
   * linha do dia ainda não existe — o INSERT passaria direto e a primeira
   * chamada do dia furaria o limite. Conferir aqui, antes de escrever, evita
   * o gravar-e-desfazer, que deixaria um `consumidas` inflado visível para
   * qualquer chamada concorrente no meio do caminho.
   */
  if p_limite is not null and p_quantidade > p_limite then
    insert into empresa_cotas (empresa_id, dia, consumidas, atingido_em)
    values (p_empresa_id, current_date, 0, now())
    on conflict (empresa_id, dia) do update
       set atingido_em = coalesce(empresa_cotas.atingido_em, now());
    return false;
  end if;

  insert into empresa_cotas (empresa_id, dia, consumidas)
  values (p_empresa_id, current_date, p_quantidade)
  on conflict (empresa_id, dia) do update
     set consumidas = empresa_cotas.consumidas + p_quantidade
   where p_limite is null
      or empresa_cotas.consumidas + p_quantidade <= p_limite
  returning true into v_ok;

  /*
   * `v_ok` nulo = o `on conflict do update` não achou linha para atualizar,
   * porque o `where` reprovou. É o estouro do teto — e é a única forma de
   * distinguir "consumi" de "estourei", já que sem o `where` o `do update`
   * gravaria sempre.
   */
  if v_ok is null then
    update empresa_cotas
       set atingido_em = coalesce(atingido_em, now())
     where empresa_id = p_empresa_id and dia = current_date;
    return false;
  end if;

  return true;
end;
$$;

/**
 * Devolve o que foi reservado e não virou mensagem.
 *
 * Mesma ideia de `devolver_cota_canal`: a cota é RESERVA, não cobrança. Uma
 * sequência de 3 passos que falha no primeiro não pode queimar os outros dois
 * do teto diário do cliente — o efeito seria a campanha parar mais cedo do que
 * precisava, que é justamente o que o limite não deveria causar.
 */
create or replace function devolver_cota_empresa(
  p_empresa_id uuid,
  p_quantidade integer
)
returns void
language sql
security definer
set search_path = public
as $$
  update empresa_cotas
     set consumidas = greatest(consumidas - p_quantidade, 0)
   where empresa_id = p_empresa_id
     and dia = current_date
     and p_quantidade > 0
     and p_empresa_id is not null;
$$;

/**
 * Quanto a empresa já consumiu hoje. Leitura, sem efeito.
 *
 * A API usa para responder "quanto falta" ANTES de aceitar uma campanha — e
 * perguntar sem consumir é obrigatório aqui pelo mesmo motivo de
 * `estado_do_freio` existir separado de `consumir_freio`.
 */
create or replace function cota_empresa_hoje(p_empresa_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select consumidas from empresa_cotas
      where empresa_id = p_empresa_id and dia = current_date),
    0
  );
$$;

/**
 * Retenção do histórico de cota.
 *
 * 180 dias: o suficiente para comparar um mês com o anterior, longe o bastante
 * de "cresce para sempre". Chamada pela manutenção do worker, junto com as
 * demais limpezas — a mesma decisão de `limpar_avisos_antigos`.
 */
create or replace function limpar_cotas_empresa_antigas(p_dias integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_apagadas integer;
begin
  delete from empresa_cotas where dia < current_date - p_dias;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

-- ---------------------------------------------------------------------------
-- Só a service role executa o que MOVE contador.
--
-- Mesma regra de `consumir_freio` (20260820000100): quem alcança
-- `devolver_cota_empresa` zera o próprio limite. `cota_empresa_hoje` é
-- leitura e fica com o grant padrão, protegida pelo RLS da tabela.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function consumir_cota_empresa(uuid, integer, integer) from anon, authenticated';
    execute 'revoke execute on function devolver_cota_empresa(uuid, integer) from anon, authenticated';
    execute 'revoke execute on function limpar_cotas_empresa_antigas(integer) from anon, authenticated';
  end if;
end;
$$;
