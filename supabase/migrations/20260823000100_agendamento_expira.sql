-- ============================================================================
-- Agendamento que perdeu a hora FALHA. Não sai atrasado.
--
-- O defeito, visto em produção: uma campanha `agendada` para T não saiu em T
-- (deploy no Render reiniciando o worker, processo fora do ar, fila parada).
-- Quando o worker voltou, o job do pg-boss estava com o `startAfter` VENCIDO e
-- foi entregue na hora — e `reivindicar_agendamentos_vencidos` (20260822000300)
-- só filtra `agendada_para <= now()`, sem teto nenhum. Os dois caminhos
-- disparam a campanha inteira em T + horas.
--
-- Mensagem de WhatsApp não é job de processamento: ela chega no celular de uma
-- pessoa, com hora na tela. "Bom dia, promoção só hoje" entregue às 3h da
-- manhã do dia seguinte é pior do que não entregue — é o cliente respondendo
-- que quer sair, e o número ficando mais perto do bloqueio. Atrasar não é uma
-- degradação aceitável deste sistema; não enviar é.
--
-- A partir daqui, agendamento tem PRAZO. Passada a tolerância, a campanha vira
-- `falhou`, com o motivo em linguagem de operador em `pausada_motivo`, e nada
-- é enviado. `falhou` é terminal de propósito: `retomar` não a aceita
-- (`campanhas.service.ts`) e `campanhas_a_replanejar` só olha `em_andamento` —
-- então não existe caminho por onde ela volte a andar sozinha depois.
--
-- Os contatos ficam `pendente`, e isso é intencional: marcá-los `falhou`
-- inflaria `total_falhas` e diria na tela que a mensagem foi tentada. Não foi.
--
-- A tolerância é do CHAMADOR (`AGENDAMENTO_TOLERANCIA_MINUTOS`, padrão 30 min)
-- porque é decisão de produto, não de schema. Precisa ficar acima da carência
-- de `reivindicar_agendamentos_vencidos` (5 min), senão a segunda tentativa de
-- reenfileirar nunca acontece: a campanha expiraria antes de ser retentada.
--
-- Idempotente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O atraso em texto de gente, para caber na faixa da tela.
--
-- Existe como função e não inline nas duas de baixo porque as duas escrevem a
-- MESMA frase, e duas cópias de um `case` de formatação divergem no primeiro
-- ajuste — a campanha expirada pelo caminho da manutenção passaria a explicar
-- diferente da expirada pelo caminho do planejamento, sem nada justificando.
--
-- Sem hora absoluta de propósito: o banco é UTC e o operador lê em horário de
-- Brasília. "às 14:00" numa faixa que o cliente vê às 11:00 dele levanta um
-- chamado de suporte que "há 3 h" não levanta.
-- ---------------------------------------------------------------------------
create or replace function descrever_atraso(p_segundos integer)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_segundos, 0) < 3600 then greatest(p_segundos / 60, 0)::text || ' min'
    when p_segundos < 86400 then
      (p_segundos / 3600)::text || ' h ' || ((p_segundos % 3600) / 60)::text || ' min'
    else (p_segundos / 86400)::text || ' d ' || ((p_segundos % 86400) / 3600)::text || ' h'
  end;
$$;

/**
 * O texto que o operador lê na campanha expirada.
 *
 * Diz as três coisas que ele precisa saber e que o status sozinho não diz:
 * quanto passou, que NADA foi enviado, e o que fazer agora. Sem a segunda, a
 * leitura natural de `falhou` é "falhou no meio" — e o operador vai procurar
 * quantas mensagens saíram antes de parar.
 */
create or replace function motivo_agendamento_expirado(
  p_atraso_segundos    integer,
  p_tolerancia_minutos integer
)
returns text
language sql
immutable
-- Chama `descrever_atraso`: sem o search_path fixo, a resolução dependeria do
-- que o chamador tiver configurado.
set search_path = public
as $$
  select 'O horário agendado passou há ' || descrever_atraso(p_atraso_segundos)
      || ' e o disparo não começou (tolerância de ' || greatest(p_tolerancia_minutos, 1)::text
      || ' min). Nenhuma mensagem foi enviada. Crie a campanha de novo com um horário novo.';
$$;

/**
 * Expira UMA campanha, se ela ainda estiver `agendada` e fora da tolerância.
 *
 * Devolve UMA linha quando expirou e NENHUMA quando não havia o que expirar —
 * dentro da tolerância, ou já não está mais `agendada`. Conjunto vazio como
 * resposta negativa, e não um NULL: com `returns integer` o chamador teria de
 * distinguir "não expirou" de "expirou com atraso desconhecido", e a diferença
 * entre as duas é enviar ou não enviar.
 *
 * O `motivo` vai junto para o worker não reescrever a frase. Ele precisa dela
 * no log e no incidente, e uma segunda cópia do formatador em TypeScript
 * divergiria da do banco no primeiro ajuste — a mesma campanha explicada de um
 * jeito na tela e de outro no log de quem está investigando.
 *
 * É o guarda do `planejarCampanha`, chamado antes de promover a campanha a
 * `em_andamento`. Esse é o caminho que de fato disparou atrasado em produção:
 * o job do pg-boss sobreviveu, o worker esteve fora, e a fila o entregou com o
 * `startAfter` já vencido — a manutenção nunca chegou a opinar.
 *
 * O `status = 'agendada'` dentro do WHERE é compare-and-swap, não conferência:
 * dois workers que cheguem juntos disputam a linha e só um recebe linha de
 * volta. O outro recebe vazio, e é por isso que quem chama TAMBÉM recusa
 * campanha que já esteja `falhou` — ver o guarda de status em
 * `DisparoService.planejarCampanha`.
 *
 * A decisão fica no banco, e não num `Date.now()` do processo, pelo mesmo
 * motivo de `reivindicar_agendamentos_vencidos`: com duas réplicas de worker,
 * o relógio de uma delas atrasado decidiria enviar o que a outra expiraria.
 */
-- `drop` antes: `create or replace` recusa mudança de tipo de retorno, e um
-- banco que tenha recebido uma versão anterior desta função abortaria a
-- migration inteira em vez de atualizá-la.
drop function if exists expirar_agendamento_se_vencido(uuid, integer);

create or replace function expirar_agendamento_se_vencido(
  p_campanha_id        uuid,
  p_tolerancia_minutos integer default 30
)
returns table (atraso_segundos integer, motivo text)
language sql
security definer
set search_path = public
as $$
  update campanhas c
     set status = 'falhou',
         pausada_motivo = motivo_agendamento_expirado(
           extract(epoch from (now() - c.agendada_para))::integer,
           p_tolerancia_minutos
         )
   where c.id = p_campanha_id
     and c.status = 'agendada'
     and c.agendada_para is not null
     and c.agendada_para < now() - make_interval(mins => greatest(p_tolerancia_minutos, 1))
  returning extract(epoch from (now() - c.agendada_para))::integer, c.pausada_motivo;
$$;

/**
 * Varre e expira em lote. Chamada pela manutenção, um minuto sim, outro
 * também.
 *
 * Cobre o modo de falha que o guarda do planejamento NÃO cobre: o job do
 * pg-boss sumiu (retenção, fila recriada, banco de jobs limpo) e ninguém vai
 * chamar `planejarCampanha` para aquela campanha nunca mais. Sem esta função a
 * campanha ficaria `agendada` para sempre — exatamente o silêncio que
 * 20260822000300 foi escrita para acabar, só que agora do outro lado.
 *
 * Devolve o que expirou para o worker registrar incidente e auditoria. Sem o
 * RETURNING, a campanha mudaria de status sem nada em lugar nenhum dizendo por
 * quê — e o operador acharia que ela falhou no meio do envio.
 */
-- Mesmo motivo do `drop` acima.
drop function if exists expirar_agendamentos_vencidos(integer, integer);

create or replace function expirar_agendamentos_vencidos(
  p_tolerancia_minutos integer default 30,
  p_limite             integer default 50
)
returns table (
  campanha_id     uuid,
  empresa_id      uuid,
  nome            text,
  atraso_segundos integer,
  motivo          text
)
language sql
security definer
set search_path = public
as $$
  with vencidas as (
    select c.id
      from campanhas c
     where c.status = 'agendada'
       and c.agendada_para is not null
       and c.agendada_para < now() - make_interval(mins => greatest(p_tolerancia_minutos, 1))
     -- Mais antiga primeiro: se houver mais que o teto, quem está esperando há
     -- mais tempo é quem o operador precisa ver primeiro.
     order by c.agendada_para
     limit greatest(p_limite, 1)
     -- Duas réplicas de worker não expiram a mesma campanha duas vezes: a
     -- segunda nem enxerga a linha que a primeira travou.
     for update skip locked
  )
  update campanhas c
     set status = 'falhou',
         pausada_motivo = motivo_agendamento_expirado(
           extract(epoch from (now() - c.agendada_para))::integer,
           p_tolerancia_minutos
         )
    from vencidas v
   where c.id = v.id
  returning c.id, c.empresa_id, c.nome,
            extract(epoch from (now() - c.agendada_para))::integer,
            c.pausada_motivo;
$$;

-- ---------------------------------------------------------------------------
-- A reivindicação ganha teto.
--
-- `drop` antes do `create`: acrescentar um terceiro parâmetro NÃO substitui a
-- função de dois — cria uma sobrecarga, e o Postgres passa a ter duas
-- candidatas para a mesma chamada por nome. Deixar as duas de pé é como o
-- reenfileiramento SEM teto continuaria vivo em produção depois desta
-- migration, atendendo por acaso a chamada errada.
--
-- Um worker da versão anterior, que chama só com dois argumentos, continua
-- funcionando: `p_tolerancia_minutos` tem default. Ele passa a NÃO reivindicar
-- o que está fora da tolerância — que é o comportamento certo mesmo antes do
-- deploy do código novo.
-- ---------------------------------------------------------------------------
drop function if exists reivindicar_agendamentos_vencidos(integer, integer);

/**
 * Campanhas agendadas cuja hora passou HÁ POUCO, reivindicadas para
 * reenfileirar. O que passou de muito é assunto de
 * `expirar_agendamentos_vencidos`, e a manutenção a chama ANTES desta.
 *
 * O resto do contrato é o de 20260822000300, sem mudança:
 *
 *  - o UPDATE ... RETURNING é a reivindicação, e dois workers não levam a
 *    mesma campanha;
 *  - `p_carencia_minutos` permite uma SEGUNDA tentativa quando o worker morreu
 *    entre reivindicar e enfileirar. Ela só acontece se a carência couber
 *    dentro da tolerância — com 5 e 30, cabem cinco tentativas;
 *  - não dispara campanha futura (`agendada_para <= now()`), não muda `status`
 *    (quem promove a `em_andamento` é `planejarCampanha`, depois de conferir
 *    que existe canal conectado) e não fala com o pg-boss.
 */
create or replace function reivindicar_agendamentos_vencidos(
  p_limite             integer default 50,
  p_carencia_minutos   integer default 5,
  p_tolerancia_minutos integer default 30
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
       -- O teto. Sem ele, uma campanha marcada para a semana passada era
       -- reenfileirada hoje e saía inteira, com a hora na tela do destinatário
       -- dizendo o quanto atrasou.
       and c.agendada_para >= now() - make_interval(mins => greatest(p_tolerancia_minutos, 1))
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

-- ---------------------------------------------------------------------------
-- Só a API e o worker chamam isto. Nenhuma delas é `security definer` por
-- capricho: `expirar_agendamentos_vencidos` marca campanha como `falhou`, e
-- exposta ao `anon` seria um jeito de qualquer um na internet matar o disparo
-- de outra empresa.
--
-- Guardado por `pg_roles` para a migration continuar rodando fora do Supabase,
-- onde `anon`/`authenticated` não existem (ver 20260820000100).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function expirar_agendamento_se_vencido(uuid, integer) from anon, authenticated';
    execute 'revoke execute on function expirar_agendamentos_vencidos(integer, integer) from anon, authenticated';
    execute 'revoke execute on function reivindicar_agendamentos_vencidos(integer, integer, integer) from anon, authenticated';
  end if;
end;
$$;
