-- ============================================================================
-- Cadência automática e campanha espalhada por vários dias.
--
-- As duas coisas na mesma migration porque são a mesma: o intervalo entre
-- contatos é de 90 a 240 s, então uma campanha de 3 mil pessoas leva dias.
-- Ou ela é dividida entre os dias de propósito, com o operador decidindo
-- quantos contatos entram em cada um, ou ela se arrasta sozinha por uma semana
-- sem ninguém ter escolhido isso.
--
-- 1. `campanhas.cadencia_automatica` — a faixa foi calculada, não digitada.
-- 2. `campanha_contatos.liberar_em`  — a partir de quando este contato pode
--                                      entrar na fila.
--
-- O ponto do desenho: NADA no worker muda. `campanhas_a_replanejar()` já roda
-- de minuto em minuto atrás de "pendente sem job" em campanha `em_andamento`
-- (migration 20260813000100), e é ela que acorda o dia 2 sozinha. Sem cron
-- novo, sem estado novo, sem uma segunda máquina de agendamento convivendo com
-- a que já existe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A origem da faixa de intervalo.
--
-- Guarda de ONDE veio o número, não o número — o valor efetivo continua em
-- `intervalo_contatos_min/max`. Sem isto, reabrir a campanha para editar
-- mostraria "150 a 180" como se alguém tivesse escolhido aqueles segundos, e
-- trocar o público não recalcularia nada.
--
-- `false` no default: campanha que já existe teve a faixa escolhida à mão (ou
-- herdou o padrão), e marcá-la como automática faria a próxima edição
-- sobrescrever um valor que alguém pode ter ajustado de propósito.
-- ---------------------------------------------------------------------------
alter table campanhas
  add column if not exists cadencia_automatica boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. O dia do contato.
--
-- Nulo = "junto com o início da campanha", que é o comportamento de sempre e o
-- de toda linha que já existe. Data = "só a partir daí".
--
-- Mora no CONTATO e não numa tabela de levas: a pergunta que o worker faz é
-- "quais contatos posso enfileirar agora?", e ela se responde numa coluna da
-- linha que ele já está lendo. Uma tabela `campanha_levas` obrigaria um join
-- no caminho mais quente do sistema para não guardar mais informação nenhuma.
-- ---------------------------------------------------------------------------
alter table campanha_contatos
  add column if not exists liberar_em timestamptz;

/*
 * Índice da fila, agora com a data.
 *
 * O `campanha_contatos_fila_idx` que já existe cobre (campanha_id, id) para
 * status pendente, e continua valendo. Este acrescenta o que a reserva passou
 * a filtrar, e é PARCIAL nas duas condições de propósito: contato já
 * enfileirado sai do índice em vez de ficar ocupando espaço para sempre, que é
 * o que se quer de um índice de fila — numa campanha de 20 mil, no fim do
 * disparo ele está praticamente vazio.
 */
create index if not exists campanha_contatos_liberacao_idx
  on campanha_contatos (campanha_id, liberar_em, id)
  where status = 'pendente' and enfileirado_em is null;

-- ---------------------------------------------------------------------------
-- 3. A reserva passa a respeitar o dia.
--
-- Uma linha nova no `where`, e é ela a feature inteira do lado do disparo.
--
-- `liberar_em is null or liberar_em <= now()`: o nulo TEM de passar, senão
-- toda campanha que já existe para de disparar no instante em que esta
-- migration roda.
--
-- Resto de um dia que não fechou continua pendente com a data no passado, e
-- por isso entra na leva seguinte junto do dia novo — sem duplicar (o
-- `enfileirado_em is null` continua sendo o que garante isso) e sem sumir.
--
-- O resto da função é idêntico à versão da 20260822000300; ela vai repetida
-- porque `create or replace` de função SQL substitui o corpo inteiro.
-- ---------------------------------------------------------------------------
create or replace function reservar_contatos_pendentes(
  p_campanha_id uuid,
  p_limite      integer default 2000
)
returns table (contato_id bigint)
language sql
security definer
set search_path = public
as $$
  with candidatos as (
    select cc.id
      from campanha_contatos cc
     where cc.campanha_id = p_campanha_id
       and cc.status = 'pendente'
       and cc.enfileirado_em is null
       and (cc.liberar_em is null or cc.liberar_em <= now())
     -- `order by id` fixa a ordem ANTES do RETURNING, que não promete
     -- nenhuma: é ela que define o rodízio de canais e o atraso acumulado de
     -- cada contato do lado do worker.
     order by cc.id
     limit greatest(p_limite, 1)
     for update skip locked
  )
  update campanha_contatos cc
     set enfileirado_em = now()
    from candidatos k
   where cc.id = k.id
     and cc.enfileirado_em is null
  returning cc.id;
$$;

-- ---------------------------------------------------------------------------
-- 4. O replanejamento também.
--
-- Sem o mesmo filtro aqui, uma campanha da semana inteira aparece nesta lista
-- a cada minuto durante seis dias: o worker planeja, a reserva devolve zero
-- porque tudo o que sobrou é de amanhã, e o ciclo repete 1.440 vezes por dia
-- por campanha. Não quebra nada — e é trabalho que nunca teve como dar em
-- coisa alguma.
--
-- Com o filtro, a campanha desaparece daqui enquanto espera e volta sozinha no
-- minuto em que o dia seguinte vence. É esse retorno que faz o dia 2 disparar
-- sem nada além do que já existia.
-- ---------------------------------------------------------------------------
create or replace function campanhas_a_replanejar()
returns table (campanha_id uuid, pendentes bigint)
language sql
stable
security definer
set search_path = public
as $$
  select cc.campanha_id, count(*)
  from campanha_contatos cc
  join campanhas c on c.id = cc.campanha_id
  where cc.status = 'pendente'
    and cc.enfileirado_em is null
    and (cc.liberar_em is null or cc.liberar_em <= now())
    and c.status = 'em_andamento'
  group by cc.campanha_id;
$$;

-- ---------------------------------------------------------------------------
-- 5. O público passa a carregar o dia de cada contato.
--
-- `liberarEm` chega dentro de cada item do jsonb, junto de telefone e
-- variáveis, porque é assim que o painel monta a semana: um público só, cada
-- contato sabendo de que dia é. Uma lista de levas em paralelo obrigaria a
-- casar duas estruturas por índice, e o dia errado num contato é a mensagem
-- saindo na terça para quem estava marcado para sexta.
--
-- O `distinct on (telefone)` ganha um significado a mais e ele é o certo: o
-- mesmo número repetido no dia 1 e no dia 4 fica no dia 1. Vence a PRIMEIRA
-- ocorrência (o `order by ord` já garantia isso), e receber mais cedo é o
-- desfecho seguro — o contrário seria a pessoa esperar três dias por causa de
-- uma duplicata que ninguém viu na planilha.
--
-- O resto da função é idêntico à 20260815000500.
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

  /*
   * O `distinct on` NÃO é redundante com o `on conflict`.
   *
   * Com o mesmo telefone repetido na entrada, `on conflict do nothing` insere
   * uma das linhas e descarta as outras — mas qual delas sobrevive não é
   * definido pelo Postgres. Na prática a última venceu, e ela costuma ser a
   * versão pobre: a planilha repete o número numa linha sem as colunas extras,
   * e as variáveis do template chegariam vazias, fazendo `{{cidade}}` sumir do
   * texto sem erro nenhum.
   *
   * Com `with ordinality` + `distinct on ... order by ord`, a PRIMEIRA
   * ocorrência vence, sempre.
   */
  with entrada as (
    select
      e.valor->>'telefone'                        as telefone,
      coalesce(e.valor->'variaveis', '{}'::jsonb) as variaveis,
      -- Ausente, nulo ou string vazia caem todos em NULL, que é "dispara junto
      -- com o início da campanha" — o comportamento de quem manda um público
      -- sem dias, inclusive o painel antigo durante o deploy.
      nullif(e.valor->>'liberarEm', '')::timestamptz as liberar_em,
      e.ord
    from jsonb_array_elements(p_publico) with ordinality as e(valor, ord)
  ),
  unicos as (
    select distinct on (telefone) telefone, variaveis, liberar_em
      from entrada
     where telefone is not null
       and telefone <> ''
     order by telefone, ord
  )
  insert into campanha_contatos (campanha_id, contato_id, telefone, variaveis, liberar_em)
  select p_campanha_id, null, u.telefone, u.variaveis, u.liberar_em
    from unicos u
   -- Quem pediu para sair não entra, nem que venha na planilha.
   where not exists (
     select 1 from opt_outs o
      where o.telefone = u.telefone
        and (v_empresa is null or o.empresa_id = v_empresa)
   )
  -- Casa com `campanha_contatos_unico_telefone_idx`. Continua valendo para
  -- reexecução da mesma campanha, que o `distinct on` não cobre.
  on conflict (campanha_id, telefone) do nothing;

  get diagnostics v_inseridos = row_count;

  update campanhas set total_contatos = v_inseridos where id = p_campanha_id;
  return v_inseridos;
end;
$$;

-- ---------------------------------------------------------------------------
-- O que NÃO muda, e por quê — para ninguém "consertar" depois:
--
-- `concluir_campanha_se_terminou` conta pendente sem olhar `liberar_em`, e tem
-- de continuar assim: é o que mantém a campanha `em_andamento` durante a
-- semana toda. Se ela olhasse a data, a campanha seria concluída na segunda à
-- noite e os dias 2 a 6 nunca sairiam — `campanhas_a_replanejar` só enxerga
-- `em_andamento`.
--
-- `expirar_agendamento_se_vencido` só age em campanha `agendada`, e a campanha
-- deixa esse estado no dia 1. Os dias seguintes não passam por ela.
-- ---------------------------------------------------------------------------
