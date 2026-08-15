-- ============================================================================
-- Pulso do worker: provar que o disparo está vivo.
--
-- O `render.yaml` já descrevia o modo de falha: "Só a API no ar significa
-- campanha criada e nada saindo — sem nenhum erro visível na tela". Foi
-- exatamente o que aconteceu. Campanhas ficaram "Em andamento" a 0% por dias,
-- canais ficaram "Conectado" sem nunca terem sido conferidos, e nada em lugar
-- nenhum dizia que o processo que faz o trabalho não estava rodando.
--
-- Uma linha só, carimbada no início de cada `manutencao()` (cron de um minuto).
--
-- Por que uma tabela própria e não reaproveitar `canais.estado_verificado_em`:
-- aquele campo só é escrito quando a Evolution RESPONDE. Com o gateway fora do
-- ar e o worker perfeitamente vivo, ele congela — e o painel acusaria "worker
-- parado" quando o problema é outro. Confundir as duas falhas é a mesma classe
-- de erro que a taxonomia inteira existe para evitar.
--
-- Idempotente.
-- ============================================================================

create table if not exists worker_pulso (
  -- Trava de linha única: o `check` impede que um segundo worker crie a sua.
  id        smallint primary key default 1 check (id = 1),
  batida_em timestamptz not null default now()
);

insert into worker_pulso (id, batida_em)
values (1, now())
on conflict (id) do nothing;

/**
 * Carimba o pulso. Chamada no começo da manutenção, antes de qualquer trabalho.
 *
 * Antes de tudo de propósito: o pulso responde "o worker está vivo?", não "a
 * manutenção terminou sem erro". Carimbar no fim faria uma rotina que falha no
 * meio parecer um worker morto, e o operador iria procurar o problema no lugar
 * errado.
 */
create or replace function bater_pulso_worker()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  insert into worker_pulso (id, batida_em)
  values (1, now())
  on conflict (id) do update set batida_em = now()
  returning batida_em;
$$;

alter table worker_pulso enable row level security;
