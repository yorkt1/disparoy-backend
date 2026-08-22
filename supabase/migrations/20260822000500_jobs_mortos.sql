-- ============================================================================
-- Job morto deixa de virar uma linha só.
--
-- `registrarJobMorto` hoje faz duas coisas: escreve o payload no log do Render
-- e chama `abrir_incidente` com o código `desconhecido`. As duas perdem
-- informação, e a segunda perde de um jeito que ninguém percebe.
--
-- `abrir_incidente` é upsert sobre `(categoria, codigo, canal_id)`. Todos os
-- jobs mortos SEM canal caem na mesma chave: o primeiro cria a linha, e do
-- segundo em diante só `ocorrencias` sobe e `detalhe` é sobrescrito pelo mais
-- recente. Quinhentos contatos perdidos viram um incidente que diz
-- "ocorrencias: 500" e o id do último. Não há como saber QUAIS contatos
-- ficaram para trás, e portanto não há como recuperá-los.
--
-- Aqui cada job morto vira uma LINHA, com o payload inteiro. O incidente
-- continua existindo, com código próprio (`job_morto`), no papel que ele faz
-- bem: avisar que aconteceu. Quem responde "o quê, exatamente" é a tabela.
--
-- REPROCESSAMENTO É MANUAL, e isso é decisão, não falta de tempo. Reprocessar
-- automaticamente um job que já esgotou 2 retries é insistir num caminho que o
-- sistema já provou não funcionar — e no caso mais provável (mídia que a
-- Evolution recusa, número que trava a instância) o resultado é um laço que
-- consome a fila. A operação existe, é segura, e é acionada por gente.
--
-- Idempotente.
-- ============================================================================

create table if not exists jobs_mortos (
  id          bigserial primary key,
  fila        text        not null,

  /**
   * Id do job no pg-boss.
   *
   * Único: o handler da dead letter roda com `batchSize: 10` e, se o próprio
   * handler falhar no meio do lote, o pg-boss reentrega o que não completou.
   * Sem esta constraint o mesmo job morto viraria duas linhas e o operador
   * reprocessaria duas vezes — que é como um "mecanismo de recuperação" vira
   * a origem de mensagem duplicada.
   *
   * Anulável porque o payload de um job antigo pode não trazer o id; nesse
   * caso a deduplicação não acontece, e uma linha a mais é melhor que perder
   * o registro.
   */
  job_id      uuid,

  campanha_id uuid   references campanhas (id) on delete cascade,
  canal_id    uuid   references canais    (id) on delete set null,
  -- Id da LINHA em `campanha_contatos`, não do contato global — é o mesmo
  -- `contatoId` que `JobContato` carrega.
  contato_id  bigint,

  -- O payload cru, como estava na fila. É o que permite entender depois um
  -- formato de job que nem existe mais no código.
  payload     jsonb  not null default '{}'::jsonb,
  motivo      text,

  morto_em        timestamptz not null default now(),
  reprocessado_em timestamptz,
  reprocessado_por uuid references perfis (id) on delete set null,
  resultado       text
);

create unique index if not exists jobs_mortos_job_idx on jobs_mortos (job_id)
  where job_id is not null;

-- A tela/consulta útil é sempre "o que morreu e ainda não foi tratado".
create index if not exists jobs_mortos_pendentes_idx on jobs_mortos (morto_em desc)
  where reprocessado_em is null;

create index if not exists jobs_mortos_campanha_idx on jobs_mortos (campanha_id);

alter table jobs_mortos enable row level security;

drop policy if exists jobs_mortos_por_empresa on jobs_mortos;
/*
 * Herda o dono da campanha. Job morto sem campanha é infraestrutura pura
 * (manutenção, retenção) e fica com a conta global — o payload dele fala de
 * processo nosso, não de dado de cliente.
 */
create policy jobs_mortos_por_empresa on jobs_mortos
  for select using (
    eh_global()
    or (campanha_id is not null
        and exists (select 1 from campanhas c where c.id = campanha_id and empresa_visivel(c.empresa_id)))
  );

/**
 * Registra um job morto. Devolve o id da linha (ou da que já existia).
 *
 * `on conflict do nothing` + `coalesce` com o SELECT: reentrega do mesmo job
 * não duplica e ainda devolve o id certo para o chamador logar.
 */
create or replace function registrar_job_morto(
  p_fila        text,
  p_job_id      uuid    default null,
  p_payload     jsonb   default '{}'::jsonb,
  p_motivo      text    default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        bigint;
  v_campanha  uuid;
  v_canal     uuid;
  v_contato   bigint;
begin
  /*
   * Os três campos saem do payload por conversão TOLERANTE.
   *
   * O payload é jsonb vindo da fila e não tem esquema garantido: um job de
   * versão anterior, um `data` vazio, um id que não é uuid. Um cast direto
   * estouraria aqui — e falhar ao REGISTRAR a falha é perder exatamente a
   * informação que esta tabela existe para não perder.
   */
  begin
    v_campanha := nullif(p_payload ->> 'campanhaId', '')::uuid;
  exception when others then v_campanha := null;
  end;

  begin
    v_canal := nullif(p_payload ->> 'canalId', '')::uuid;
  exception when others then v_canal := null;
  end;

  begin
    v_contato := nullif(p_payload ->> 'contatoId', '')::bigint;
  exception when others then v_contato := null;
  end;

  -- FK com `on delete cascade`: campanha já apagada faria o insert falhar.
  if v_campanha is not null and not exists (select 1 from campanhas where id = v_campanha) then
    v_campanha := null;
  end if;
  if v_canal is not null and not exists (select 1 from canais where id = v_canal) then
    v_canal := null;
  end if;

  insert into jobs_mortos (fila, job_id, campanha_id, canal_id, contato_id, payload, motivo)
  values (p_fila, p_job_id, v_campanha, v_canal, v_contato, coalesce(p_payload, '{}'::jsonb), p_motivo)
  on conflict (job_id) where job_id is not null do nothing
  returning id into v_id;

  if v_id is null and p_job_id is not null then
    select id into v_id from jobs_mortos where job_id = p_job_id;
  end if;

  return v_id;
end;
$$;

/**
 * Devolve o contato do job morto à fila. Operação MANUAL.
 *
 * Não fala com o pg-boss — e é isso que a torna segura. Ela só recoloca a
 * linha em `campanha_contatos` no estado `pendente` com `enfileirado_em`
 * nulo; quem reenfileira é `campanhas_a_replanejar` + `planejarCampanha`, no
 * minuto seguinte, pelo mesmo caminho que já recupera contato travado desde a
 * migration 20260813000100. Um caminho de recuperação, não dois.
 *
 * POR QUE NÃO DUPLICA MENSAGEM
 * ----------------------------
 * Três travas, todas anteriores a esta função:
 *
 *  1. `enfileirado_em` — o contato volta a ser candidato UMA vez;
 *     `reservar_contatos_pendentes` é `update ... where enfileirado_em is
 *     null`, então dois planejamentos concorrentes disputam a linha e só um
 *     leva.
 *  2. `mensagens_enviadas.passo` — o worker lê os passos já entregues
 *     (`passosJaEnviados`) e os pula. Um contato que morreu no passo 3 de 3
 *     não recebe os passos 1 e 2 de novo.
 *  3. `rodada` — o job novo nasce na rodada atual; qualquer job antigo do
 *     mesmo contato que ainda acorde é descartado como rodada vencida.
 *
 * `reprocessado_em` marcado ANTES do trabalho, com `where reprocessado_em is
 * null`: dois operadores clicando junto, ou dois cliques no mesmo botão,
 * fazem só o primeiro entrar.
 *
 * Devolve um texto legível com o que aconteceu — inclusive quando não fez
 * nada. "Nada a fazer" precisa ser dito; um `void` silencioso faria o operador
 * achar que reprocessou.
 */
create or replace function reprocessar_job_morto(
  p_id      bigint,
  p_perfil  uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job        jobs_mortos%rowtype;
  v_status     text;
  v_campanha   text;
  v_resultado  text;
begin
  -- Reivindicação atômica: quem consegue gravar a marca leva o trabalho.
  update jobs_mortos
     set reprocessado_em = now(), reprocessado_por = p_perfil
   where id = p_id and reprocessado_em is null
  returning * into v_job;

  if not found then
    return 'Nada feito: job inexistente ou já reprocessado.';
  end if;

  if v_job.contato_id is null then
    v_resultado := 'Nada a devolver: o job não aponta para um contato '
                || '(era planejamento, manutenção ou retenção). O registro fica como evidência.';
    update jobs_mortos set resultado = v_resultado where id = p_id;
    return v_resultado;
  end if;

  select cc.status::text into v_status
    from campanha_contatos cc
   where cc.id = v_job.contato_id;

  if v_status is null then
    v_resultado := format('Nada feito: o contato %s não existe mais.', v_job.contato_id);
    update jobs_mortos set resultado = v_resultado where id = p_id;
    return v_resultado;
  end if;

  /*
   * `concluido` e `invalido` não voltam.
   *
   * `concluido` já recebeu a sequência inteira — reenviar seria a duplicidade
   * que tudo isto evita. `invalido` é número que não existe no WhatsApp:
   * insistir não muda o resultado e queima cota do canal.
   */
  if v_status in ('concluido', 'invalido') then
    v_resultado := format('Nada feito: o contato já está %s.', v_status);
    update jobs_mortos set resultado = v_resultado where id = p_id;
    return v_resultado;
  end if;

  /*
   * Campanha `concluida` precisa reabrir, senão o contato volta a `pendente` e
   * fica lá: `campanhas_a_replanejar` só olha campanha `em_andamento`.
   *
   * `pausada`/`pausada_por_canal` NÃO reabrem de propósito — pausa é decisão
   * (do operador ou do watchdog de canal), e desfazê-la por causa de um job
   * morto retomaria o disparo pelas costas de quem pausou. O contato fica
   * pendente e sai quando a campanha for retomada, que é o comportamento certo.
   */
  select c.status::text into v_campanha
    from campanhas c
    join campanha_contatos cc on cc.campanha_id = c.id
   where cc.id = v_job.contato_id;

  update campanha_contatos
     set status = 'pendente',
         enfileirado_em = null,
         enviando_desde = null,
         processado_em = null,
         motivo = null,
         -- Zera o contador para a reconciliação não desistir na primeira
         -- rodada: `reconciliar_disparos` marca `falhou` em `tentativas >= 3`,
         -- e um contato que chegou aqui já tem tentativas gastas.
         tentativas = 0
   where id = v_job.contato_id;

  if v_campanha = 'concluida' then
    update campanhas
       set status = 'em_andamento', concluida_em = null
     where id = v_job.campanha_id;
    v_resultado := 'Contato devolvido à fila e campanha reaberta; sai no próximo replanejamento.';
  elsif v_campanha in ('pausada', 'pausada_por_canal') then
    v_resultado := format(
      'Contato devolvido à fila, mas a campanha está %s: ele só sai quando ela for retomada.',
      v_campanha
    );
  else
    v_resultado := 'Contato devolvido à fila; sai no próximo replanejamento (até 1 min).';
  end if;

  update jobs_mortos set resultado = v_resultado where id = p_id;
  return v_resultado;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function registrar_job_morto(text, uuid, jsonb, text) from anon, authenticated';
    execute 'revoke execute on function reprocessar_job_morto(bigint, uuid) from anon, authenticated';
  end if;
end;
$$;
