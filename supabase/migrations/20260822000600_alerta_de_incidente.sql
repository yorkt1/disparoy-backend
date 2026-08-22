-- ============================================================================
-- O alerta externo de um incidente vira estado, não tentativa.
--
-- O vigia do pulso (`VigiaWorkerService`) decide se alerta perguntando "já
-- existia incidente aberto antes desta rodada?". Funciona para o que foi
-- escrito — não mandar um POST por minuto enquanto o worker está fora — e
-- deixa dois buracos:
--
--  1. Se o POST FALHAR (webhook fora do ar, timeout, DNS), ninguém tenta de
--     novo. O incidente segue aberto, a condição "já existia" passa a ser
--     verdadeira no minuto seguinte, e o alerta nunca mais sai. O worker está
--     morto e o único aviso externo se perdeu na primeira tentativa.
--  2. Se `ALERTA_WEBHOOK_URL` estiver vazia, `relatarErro` retorna sem fazer
--     nada e sem dizer nada. O sistema se comporta exatamente como se tivesse
--     alertado.
--
-- Duas colunas resolvem os dois: `alertado_em` marca a tentativa (e serve de
-- reivindicação atômica entre as réplicas da API), e `alerta_estado` grava o
-- desfecho — `enviado`, `falhou` ou `desabilitado`. Um alerta que não saiu
-- passa a estar ESCRITO, em vez de ausente.
--
-- Incidente novo nasce com as duas nulas, então o worker cair de novo depois
-- de voltar gera alerta de novo: `resolver_incidente` fecha a linha antiga e
-- `abrir_incidente` cria outra.
--
-- Idempotente.
-- ============================================================================

alter table incidentes
  add column if not exists alertado_em   timestamptz,
  add column if not exists alerta_estado text;

/**
 * Reivindica o direito de alertar sobre este incidente.
 *
 * `true` só para quem gravou `alertado_em` — uma vez por incidente, por todo o
 * sistema. É `update ... where alertado_em is null returning`, então a corrida
 * entre as duas réplicas da API (`numInstances: 2` no `render.yaml`) é
 * resolvida pelo Postgres e não por um marcador em memória de processo, que
 * alertaria uma vez por réplica.
 *
 * Substitui o `select ... maybeSingle()` que o vigia fazia antes de chamar
 * `abrir_incidente`: aquele era uma leitura seguida de escrita, e entre as
 * duas cabia a outra réplica inteira.
 */
create or replace function reivindicar_alerta_incidente(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update incidentes
     set alertado_em = now(), alerta_estado = 'enviando'
   where id = p_id and alertado_em is null
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

/**
 * Grava o desfecho da tentativa.
 *
 * `p_estado = 'falhou'` LIBERA a reivindicação (`alertado_em` volta a nulo)
 * para a rodada seguinte do vigia tentar outra vez — é o que conserta o
 * buraco 1. As demais tentativas ficam limitadas pelo próprio incidente: ele
 * é fechado assim que o worker volta, e a partir daí não há mais o que
 * realertar.
 *
 * `desabilitado` NÃO libera: sem `ALERTA_WEBHOOK_URL` não há para onde tentar,
 * e reivindicar de minuto em minuto só encheria o log com a mesma linha. O
 * estado fica gravado, visível em `select * from incidentes`, que é o oposto
 * de fingir que o alerta saiu.
 */
create or replace function registrar_alerta_incidente(p_id bigint, p_estado text)
returns void
language sql
security definer
set search_path = public
as $$
  update incidentes
     set alerta_estado = p_estado,
         alertado_em = case when p_estado = 'falhou' then null else alertado_em end
   where id = p_id;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function reivindicar_alerta_incidente(bigint) from anon, authenticated';
    execute 'revoke execute on function registrar_alerta_incidente(bigint, text) from anon, authenticated';
  end if;
end;
$$;
