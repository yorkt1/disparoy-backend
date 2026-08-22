-- ============================================================================
-- Campanha agendada não depende mais do job sobreviver na fila.
--
-- O agendamento de hoje é `boss.send(..., { startAfter })`: o pg-boss segura o
-- job até a hora. Isso funciona, e continua funcionando — mas é a ÚNICA cópia
-- do agendamento, e ela mora numa tabela com data de validade.
--
-- `keep_until` do pg-boss é de 14 dias por padrão. Uma campanha marcada para
-- daqui a 30 dias vira um job que a manutenção do pg-boss apaga no dia 14. A
-- campanha fica `agendada` no banco, com `agendada_para` no futuro, e no dia
-- marcado NADA acontece — sem erro, sem incidente, sem nada na tela. É a pior
-- forma de falhar que este sistema tem, e é a mesma classe do defeito que o
-- pulso do worker (20260815000400) foi criado para pegar.
--
-- A correção NÃO é aumentar a retenção. Retenção maior empurra o problema para
-- frente e continua fazendo a fila ser a fonte da verdade do agendamento —
-- exatamente a inversão que `ROBUSTEZ.md` diz para não fazer: "a fila é
-- transporte; quando ela e o banco discordam, o banco vence".
--
-- Aqui a fonte da verdade passa a ser `campanhas.status = 'agendada'` +
-- `agendada_para`. A manutenção do worker (cron de 1 min) pergunta ao banco
-- quem já venceu e reenfileira. Se o job do pg-boss sobreviveu, os dois
-- chegam ao mesmo `planejarCampanha` — e `enfileirado_em` garante que só um
-- reserva cada contato (ver `reservar_contatos_pendentes`, abaixo).
--
-- Idempotente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A marca de "já mandei este para a fila".
--
-- Sem ela, a manutenção reenfileiraria a MESMA campanha vencida a cada minuto
-- enquanto o job não fosse consumido. Nenhuma mensagem duplicada sairia disso
-- (a reserva no banco impede), mas a fila encheria de planejamentos inúteis e
-- o log ficaria ilegível justamente na hora em que alguém está investigando.
-- ---------------------------------------------------------------------------
alter table campanhas
  add column if not exists agendamento_reivindicado_em timestamptz;

-- Índice parcial: a varredura de minuto em minuto pergunta exatamente
-- "agendadas vencidas". Sem ele, uma tabela com anos de campanha concluída
-- vira seq scan 1.440 vezes por dia.
create index if not exists campanhas_agendadas_vencidas_idx
  on campanhas (agendada_para)
  where status = 'agendada';

/**
 * Campanhas agendadas cuja hora já passou, reivindicadas para reenfileirar.
 *
 * O UPDATE ... RETURNING é a reivindicação: quem consegue gravar
 * `agendamento_reivindicado_em` é quem leva a campanha. Dois workers rodando a
 * manutenção ao mesmo tempo disputam a linha no Postgres e só um a recebe —
 * a mesma mecânica de `reservarPendentes`, e pelo mesmo motivo.
 *
 * `p_carencia_minutos` é o que permite uma SEGUNDA tentativa: se o worker
 * morreu entre reivindicar e enfileirar, a campanha volta a ser candidata
 * depois da carência em vez de ficar reivindicada para sempre. Cinco minutos é
 * folga suficiente para o `boss.send` do chamador acontecer, e curto o
 * bastante para o operador não notar a diferença.
 *
 * O que esta função NÃO faz, de propósito:
 *
 *  - não dispara campanha futura. O filtro é `agendada_para <= now()`, e é
 *    isso que garante que reenfileirar de minuto em minuto nunca antecipe
 *    nada;
 *  - não muda `status`. Quem promove `agendada` -> `em_andamento` é o
 *    `planejarCampanha`, depois de conferir que existe canal conectado. Mudar
 *    aqui faria uma campanha sem canal aparecer "em andamento" e parada;
 *  - não fala com o pg-boss. SQL não tem como, e emular INSERT na tabela de
 *    jobs amarraria o schema interno dele (mesma decisão de
 *    `reconciliar_disparos`).
 */
create or replace function reivindicar_agendamentos_vencidos(
  p_limite            integer default 50,
  p_carencia_minutos  integer default 5
)
returns table (campanha_id uuid, rodada integer)
language sql
security definer
set search_path = public
as $$
  with candidatas as (
    select c.id
      from campanhas c
     where c.status = 'agendada'
       and c.agendada_para is not null
       and c.agendada_para <= now()
       and (
         c.agendamento_reivindicado_em is null
         or c.agendamento_reivindicado_em < now() - make_interval(mins => p_carencia_minutos)
       )
     order by c.agendada_para
     limit p_limite
     -- Duas réplicas de worker não brigam pela mesma linha: quem chegou
     -- depois pula e pega a próxima, em vez de esperar o lock.
     for update skip locked
  )
  update campanhas c
     set agendamento_reivindicado_em = now()
    from candidatas k
   where c.id = k.id
  returning c.id, coalesce(c.rodada, 0);
$$;

/**
 * Zera as marcas de agendamento da campanha. Chamada ao pausar e ao retomar.
 *
 * Duas colunas, duas razões:
 *
 *  - `agendamento_reivindicado_em`: uma campanha pausada e reagendada depois
 *    carregaria a marca antiga e ficaria até a carência inteira sem ser
 *    candidata. Pouco tempo, e é o tipo de atraso que ninguém consegue
 *    explicar depois.
 *  - `fila_ate`: ao pausar, `invalidar_rodada_campanha` aposenta todos os jobs
 *    já enfileirados — mas `fila_ate` continuaria apontando para o fim daquela
 *    fila morta, horas à frente. A campanha retomada agendaria o primeiro
 *    contato para o horário em que a execução ANTERIOR teria terminado, e o
 *    operador clicaria em "retomar" sem ver nada acontecer pelo resto do dia.
 */
create or replace function limpar_agendamento_da_campanha(p_campanha_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update campanhas
     set agendamento_reivindicado_em = null,
         fila_ate = null
   where id = p_campanha_id;
$$;

-- ---------------------------------------------------------------------------
-- Reserva de pendentes com TETO, sem perder a atomicidade.
--
-- `reservarPendentes` fazia `update ... where enfileirado_em is null returning
-- id` sobre a campanha inteira: uma campanha de 200 mil contatos devolvia 200
-- mil ids num array de JavaScript e virava 400 inserts de lote numa tacada só,
-- com o job de planejamento segurando a fila o tempo todo. Pior: enquanto ele
-- roda, NENHUMA outra campanha planeja — um cliente grande trava a fila dos
-- outros (o item 4 do diagnóstico chama isso de monopolizar o worker).
--
-- O UPDATE continua sendo UM comando com RETURNING, então a atomicidade é a
-- mesma: dois workers que chamem isto ao mesmo tempo NÃO recebem o mesmo
-- contato. Duas garantias empilhadas:
--
--  - `for update skip locked` no subselect: a segunda transação nem enxerga as
--    linhas que a primeira travou;
--  - `enfileirado_em is null` continua no WHERE do UPDATE, então mesmo que o
--    skip locked não valesse (leitura já commitada, outro caminho), a linha já
--    reservada não casa.
--
-- O que sobra do teto é replanejado no minuto seguinte por
-- `campanhas_a_replanejar`, que já existe e já procura por "pendente sem job".
-- Nenhum contato se perde: ele só sai mais tarde.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- A linha do tempo da campanha, para as levas não se sobreporem.
--
-- Com o teto acima, uma campanha grande passa a ser planejada em várias levas.
-- Cada planejamento começava o atraso em ZERO, então a leva 2 seria agendada
-- por cima da leva 1 e a cadência de 15–45 s viraria dois envios no mesmo
-- instante — o padrão exato que faz o número ser bloqueado.
--
-- Isso não é problema novo trazido pela paginação: `reconciliar_disparos` +
-- `replanejarPendentesOrfas` já chamavam o planejamento com a campanha cheia
-- de jobs agendados para as próximas horas, e os contatos recuperados já caíam
-- por cima. A paginação só tornaria o defeito comum em vez de eventual.
--
-- `fila_ate` é o instante do último contato já agendado. Cada leva reserva o
-- próprio trecho a partir dele, num UPDATE só — dois planejamentos
-- concorrentes recebem trechos que não se sobrepõem.
-- ---------------------------------------------------------------------------
alter table campanhas
  add column if not exists fila_ate timestamptz;

/**
 * Reserva `p_duracao_segundos` na linha do tempo e devolve onde ela começa.
 *
 * `greatest(fila_ate, now())` é o que faz a campanha ociosa recomeçar de agora
 * em vez de herdar um `fila_ate` de uma semana atrás — sem isso, uma campanha
 * pausada e retomada depois agendaria tudo para o passado, o pg-boss entregaria
 * os jobs todos de uma vez e a cadência sumiria.
 *
 * Lê com `for update` e só então escreve, em vez de um UPDATE ... RETURNING: o
 * RETURNING de um UPDATE enxerga a linha DEPOIS da escrita, e o que interessa
 * aqui é o valor de antes — é ele que marca onde o trecho começa. O `for
 * update` é o que serializa dois planejamentos concorrentes; o segundo espera,
 * lê o `fila_ate` já empurrado pelo primeiro e reserva a seguir, sem
 * sobreposição.
 */
create or replace function reservar_janela_de_envio(
  p_campanha_id      uuid,
  p_duracao_segundos integer
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inicio timestamptz;
begin
  select greatest(coalesce(fila_ate, now()), now())
    into v_inicio
    from campanhas
   where id = p_campanha_id
     for update;

  -- Campanha sumiu entre a reserva dos contatos e esta chamada: agendar a
  -- partir de agora é o comportamento anterior, e o planejamento seguinte
  -- descobre que ela não existe mais.
  if v_inicio is null then
    return now();
  end if;

  update campanhas
     set fila_ate = v_inicio + make_interval(secs => greatest(p_duracao_segundos, 0))
   where id = p_campanha_id;

  return v_inicio;
end;
$$;

/**
 * Devolve a janela quando o enfileiramento falhou. Compare-and-swap.
 *
 * Sem isto, um `agendarContatosEmLote` que estoura (fila fora do ar) deixaria
 * `fila_ate` empurrado por uma leva que nunca virou job: os contatos seriam
 * devolvidos à reserva e o replanejamento seguinte os agendaria DEPOIS do
 * buraco — até 16 horas de silêncio numa leva de 2.000 contatos, sem nada na
 * tela explicando.
 *
 * A escrita só acontece se `fila_ate` ainda for exatamente o que aquela leva
 * gravou. Se outro planejamento tiver avançado a linha do tempo no meio, o
 * UPDATE não casa e não faz nada — devolver ali encavalaria a leva do outro.
 */
create or replace function devolver_janela_de_envio(
  p_campanha_id      uuid,
  p_inicio           timestamptz,
  p_duracao_segundos integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_devolvida boolean;
begin
  update campanhas
     set fila_ate = p_inicio
   where id = p_campanha_id
     and fila_ate = p_inicio + make_interval(secs => greatest(p_duracao_segundos, 0))
  returning true into v_devolvida;

  return coalesce(v_devolvida, false);
end;
$$;

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
