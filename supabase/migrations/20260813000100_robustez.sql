-- ============================================================================
-- Robustez da execução: reconciliação, idempotência e contadores atômicos.
--
-- Tudo aqui existe por causa de uma pergunta só: o que acontece quando o
-- worker morre no meio? O Render reinicia no deploy, o processo leva OOM, a
-- VPS da Evolution cai. Nenhuma dessas coisas é excepcional — são terça-feira.
--
-- O desenho antigo assumia que o worker sempre termina o que começou. Quando
-- não terminava, o contato ficava em `enviando` para sempre e a campanha nunca
-- concluía: nada de errado aparecia na tela, ela só não andava mais.
--
-- Idempotente: roda sobre banco novo e sobre o que já está no ar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Colunas de rastreio da execução
-- ---------------------------------------------------------------------------

/**
 * `enfileirado_em` — quando este contato virou job na fila.
 *
 * É a trava de idempotência do planejamento. Antes, replanejar uma campanha
 * (retry do job, reconciliação, dois cliques em "Disparar") reenfileirava
 * TODO contato pendente, e o contato recebia a mensagem de novo. A garantia
 * ficava só no `singletonKey` do pg-boss, que solta a chave assim que o job
 * completa — ou seja, não valia para nada depois do primeiro envio.
 *
 * Com esta coluna a trava é do banco: `where enfileirado_em is null` num
 * UPDATE ... RETURNING é atômico, então dois planejamentos simultâneos
 * disputam a linha e só um leva.
 */
alter table campanha_contatos
  add column if not exists enfileirado_em timestamptz;

/**
 * `enviando_desde` — quando o worker pegou este contato para si.
 *
 * Sem isto não há como distinguir "enviando agora" de "enviando desde
 * ontem porque o processo morreu". É o relógio que o reaper lê.
 */
alter table campanha_contatos
  add column if not exists enviando_desde timestamptz;

/**
 * `rodada` — geração da execução da campanha.
 *
 * Resolve o problema de pausar: os jobs já enfileirados continuam na fila
 * (o pg-boss não sabe cancelar por chave de negócio, só por id de job, e o
 * código antigo passava o id da CAMPANHA para `deleteJob` — que não apagava
 * nada e ainda escrevia "jobs cancelados" no log).
 *
 * Cada job carrega a rodada em que nasceu. Pausar incrementa o contador, e
 * todo job da rodada anterior vira no-op ao acordar. É invalidação por
 * versão, não por remoção: não depende de a fila cooperar.
 *
 * Sem isso, pausar e retomar rápido faz o job velho e o job novo do MESMO
 * contato coexistirem — os dois enviam, e a pessoa recebe duas vezes.
 */
alter table campanhas
  add column if not exists rodada integer not null default 0;

-- ---------------------------------------------------------------------------
-- Índices que as novas rotinas exigem
-- ---------------------------------------------------------------------------

-- O reaper roda de minuto em minuto e pergunta sempre a mesma coisa.
create index if not exists campanha_contatos_travados_idx
  on campanha_contatos (enviando_desde)
  where status in ('enviando', 'validando');

-- O planejamento busca "pendentes ainda não enfileirados desta campanha".
create index if not exists campanha_contatos_planejar_idx
  on campanha_contatos (campanha_id, id)
  where status = 'pendente' and enfileirado_em is null;

-- Resposta recebida chega por telefone e precisa achar a campanha mais recente.
create index if not exists campanha_contatos_telefone_idx
  on campanha_contatos (telefone, processado_em desc);

-- O checkpoint pergunta quais passos deste contato já saíram.
create index if not exists mensagens_passo_idx
  on mensagens_enviadas (campanha_contato_id, passo);

-- A limpeza de retenção varre por data.
create index if not exists eventos_webhook_limpeza_idx
  on eventos_webhook (recebido_em);

-- ---------------------------------------------------------------------------
-- Reconciliação
-- ---------------------------------------------------------------------------

/**
 * Devolve à fila os contatos que ficaram presos em execução.
 *
 * Um contato em `enviando` há mais de `p_minutos` só pode significar worker
 * morto: o envio de uma sequência inteira leva segundos, não minutos. Ele
 * volta para `pendente` com `enfileirado_em` limpo, e o replanejamento o pega
 * na próxima rodada.
 *
 * `tentativas` é o freio: um contato que trava sempre (número que trava a
 * Evolution, mídia gigante) viraria loop infinito de retomada. Passando de
 * `p_max_tentativas` ele é marcado como `falhou` e sai do caminho — a campanha
 * termina em vez de ficar rodando para sempre por causa de uma linha.
 *
 * Devolve as campanhas afetadas para quem chamou reenfileirar o planejamento.
 * Não enfileira daqui: SQL não fala com o pg-boss, e emular isso com INSERT
 * direto na tabela de jobs amarraria o schema interno dele.
 */
create or replace function reconciliar_disparos(
  p_minutos integer default 15,
  p_max_tentativas integer default 3
)
returns table (campanha_id uuid, retomados bigint)
-- `language sql` e não plpgsql: com `returns table`, os nomes das colunas de
-- saída viram variáveis dentro do plpgsql e passam a competir com os nomes de
-- coluna reais nas CTEs. Em SQL puro esse conflito não existe.
language sql
security definer
set search_path = public
as $$
  with travados as (
    select cc.id as linha, cc.tentativas as tent
    from campanha_contatos cc
    where cc.status in ('enviando', 'validando')
      -- `epoch` cobre as linhas que já estavam presas antes desta migration:
      -- sem nenhum carimbo de tempo, "travado desde sempre" é a leitura certa.
      and coalesce(cc.enviando_desde, cc.processado_em, 'epoch'::timestamptz)
          < now() - make_interval(mins => p_minutos)
    for update skip locked
  ),
  desistidos as (
    update campanha_contatos c
    set status = 'falhou',
        motivo = format(
          'Interrompido %s vezes sem concluir (worker reiniciado ou envio travado).',
          t.tent
        ),
        processado_em = now(),
        enviando_desde = null
    from travados t
    where c.id = t.linha and t.tent >= p_max_tentativas
    returning c.campanha_id as cid
  ),
  retomados_ as (
    update campanha_contatos c
    set status = 'pendente',
        tentativas = c.tentativas + 1,
        enfileirado_em = null,
        enviando_desde = null,
        canal_id = null
    from travados t
    where c.id = t.linha and t.tent < p_max_tentativas
    returning c.campanha_id as cid
  ),
  afetadas as (
    select cid from desistidos
    union all
    select cid from retomados_
  )
  select a.cid, count(*) from afetadas a group by a.cid;
$$;

/**
 * Campanhas que ficaram `em_andamento` sem nada pendente.
 *
 * Sintoma clássico do worker morrer entre o último envio e a conclusão: todos
 * os contatos processados, a campanha parada em "em andamento" para sempre.
 * `concluir_campanha_se_terminou` resolve uma por vez; esta varre todas.
 */
create or replace function concluir_campanhas_orfas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  fechadas integer;
begin
  update campanhas c
  set status = 'concluida', concluida_em = now()
  where c.status = 'em_andamento'
    and not exists (
      select 1 from campanha_contatos cc
      where cc.campanha_id = c.id
        and cc.status in ('pendente', 'validando', 'enviando')
    );

  get diagnostics fechadas = row_count;
  return fechadas;
end;
$$;

/**
 * Campanhas em andamento que ainda têm contato pendente sem job na fila.
 *
 * É o que o worker consulta para saber quem replanejar depois da
 * reconciliação — inclusive campanhas cujo job de planejamento morreu antes de
 * enfileirar todo mundo.
 */
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
    and c.status = 'em_andamento'
  group by cc.campanha_id;
$$;

/**
 * Invalida os jobs em voo desta campanha e libera os pendentes.
 *
 * Chamada ao pausar. O incremento de `rodada` aposenta todo job já
 * enfileirado; limpar `enfileirado_em` dos que ainda não saíram devolve esses
 * contatos ao planejamento, para que retomar a campanha os alcance de novo.
 *
 * As duas coisas precisam andar juntas. Só invalidar deixaria os pendentes
 * marcados como enfileirados para um job que nunca mais vai rodar — eles
 * sumiriam da campanha em silêncio. Só liberar criaria dois jobs vivos para o
 * mesmo contato, e a pessoa receberia duas vezes.
 */
create or replace function invalidar_rodada_campanha(p_campanha_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  nova integer;
begin
  update campanhas
  set rodada = rodada + 1
  where id = p_campanha_id
  returning rodada into nova;

  if nova is null then
    return null;
  end if;

  update campanha_contatos
  set enfileirado_em = null
  where campanha_id = p_campanha_id and status = 'pendente';

  return nova;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contadores
-- ---------------------------------------------------------------------------

/**
 * Recalcula as métricas de TODAS as campanhas ativas de uma vez.
 *
 * Antes, cada evento de webhook chamava `recalcular_metricas_campanha`, que faz
 * `count(*)` sobre todas as mensagens da campanha. Uma mensagem gera três ou
 * quatro eventos de status (SERVER_ACK, DELIVERY_ACK, READ), então uma campanha
 * de 5 mil contatos disparava ~20 mil varreduras completas e ~20 mil UPDATEs
 * na MESMA linha de `campanhas` — contenção de lock garantida, e tudo isso no
 * caminho de um webhook que precisa responder rápido.
 *
 * Agora o webhook só grava o status da mensagem. Quem agrega é o worker, uma
 * vez por minuto, para todas as campanhas ativas juntas.
 */
create or replace function recalcular_metricas_campanhas_ativas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  atualizadas integer;
begin
  update campanhas c
  set
    total_enviadas = m.enviadas,
    total_entregues = m.entregues,
    total_lidas = m.lidas,
    total_falhas = m.falhas
  from (
    select
      campanha_id,
      count(*) filter (where status in ('enviada', 'entregue', 'lida')) as enviadas,
      count(*) filter (where status in ('entregue', 'lida')) as entregues,
      count(*) filter (where status = 'lida') as lidas,
      count(*) filter (where status = 'falhou') as falhas
    from mensagens_enviadas
    where campanha_id in (select id from campanhas where status in ('em_andamento', 'pausada'))
    group by campanha_id
  ) m
  where c.id = m.campanha_id
    and (
      c.total_enviadas is distinct from m.enviadas
      or c.total_entregues is distinct from m.entregues
      or c.total_lidas is distinct from m.lidas
      or c.total_falhas is distinct from m.falhas
    );

  get diagnostics atualizadas = row_count;
  return atualizadas;
end;
$$;

/**
 * Credita uma resposta à campanha mais recente que falou com este número.
 *
 * Substitui um SELECT seguido de UPDATE no serviço, que perdia contagem: dois
 * contatos respondendo ao mesmo tempo liam o mesmo valor e gravavam o mesmo
 * incremento — uma das respostas simplesmente sumia. Aqui o incremento é
 * relativo (`+ 1` sobre a coluna), então o Postgres serializa e nada se perde.
 */
create or replace function registrar_resposta(p_telefone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  alvo uuid;
begin
  select cc.campanha_id into alvo
  from campanha_contatos cc
  where cc.telefone = p_telefone
    and cc.processado_em is not null
  order by cc.processado_em desc
  limit 1;

  if alvo is null then
    return false;
  end if;

  update campanhas
  set total_respostas = total_respostas + 1
  where id = alvo;

  return true;
end;
$$;

/**
 * Devolve cota que foi debitada e não virou mensagem.
 *
 * A cota é consumida ANTES do envio, de propósito: reservar primeiro é o que
 * impede dois workers de estourarem o teto do mesmo número ao mesmo tempo. Mas
 * quando o envio falha na primeira mensagem, a reserva das outras vira cota
 * queimada à toa — e cota queimada em número novo significa campanha parada
 * mais cedo do que precisava.
 *
 * `greatest(..., 0)` porque a devolução nunca pode deixar o contador negativo:
 * o `check (enviadas_hoje >= 0)` da tabela recusaria e derrubaria o envio
 * inteiro por causa de uma correção de contabilidade.
 */
create or replace function devolver_cota_canal(p_canal_id uuid, p_quantidade integer)
returns void
language sql
security definer
set search_path = public
as $$
  update canais
  set enviadas_hoje = greatest(enviadas_hoje - p_quantidade, 0)
  where id = p_canal_id and p_quantidade > 0;
$$;

-- ---------------------------------------------------------------------------
-- Retenção
-- ---------------------------------------------------------------------------

/**
 * Apaga payloads brutos de webhook antigos.
 *
 * `eventos_webhook` guarda o JSON inteiro de cada evento — três ou quatro por
 * mensagem enviada. Sem limpeza a tabela cresce para sempre, e ela é de longe
 * a maior do banco: numa instalação com disparo diário, come o plano do
 * Supabase sozinha em poucos meses.
 *
 * Só apaga o que já foi processado com sucesso. Evento com erro fica: é
 * exatamente o que alguém vai querer ler quando for investigar.
 */
create or replace function limpar_eventos_webhook(p_dias integer default 14)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  apagados integer;
begin
  delete from eventos_webhook
  where processado
    and erro is null
    and recebido_em < now() - make_interval(days => p_dias);

  get diagnostics apagados = row_count;
  return apagados;
end;
$$;
