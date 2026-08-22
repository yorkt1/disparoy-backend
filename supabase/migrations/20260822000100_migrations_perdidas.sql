-- ============================================================================
-- Reposição do que dois arquivos de migration perderam.
--
-- `20260817000100_empresa_em_auditoria.sql` e
-- `20260818000100_resposta_por_empresa_e_falha_reconciliada.sql` estão no
-- repositório com 62 e 59 bytes: o conteúdo virou uma LINHA DE CAMINHO nos
-- commits 5f2f0cd ("swap migration files") e 2e0ec0f. Os dois rodam sem erro
-- e não criam nada — o `supabase db push` os marca como aplicados e segue.
--
-- O código, porém, continua contando com o que eles faziam. Num banco criado
-- do zero hoje:
--
--  - `AuditoriaService.registrar` grava `empresa_id` numa coluna que não
--    existe. TODA escrita de auditoria falha. Como `registrar` não relança de
--    propósito ("auditoria é observabilidade"), o sistema segue funcionando
--    com a trilha inteira vazia — e é a trilha que responde "quem apagou o
--    canal do cliente".
--  - `contarResposta` chama `registrar_resposta(p_telefone, p_empresa_id)`, e
--    a assinatura que existe no banco só aceita `p_telefone`. O PostgREST não
--    encontra a função e devolve erro, que vira `logger.warn` — as respostas
--    param de ser contadas em silêncio.
--
-- O segundo é isolamento entre empresas, não contabilidade: sem
-- `p_empresa_id`, a busca por `telefone` acha a linha de QUALQUER empresa que
-- tenha disparado para aquele número, e a resposta recebida por um cliente é
-- somada à campanha de outro.
--
-- Repõe só o que o código de fato usa. `falha_reconciliada`, citada no nome do
-- arquivo perdido, não aparece em lugar nenhum do backend — inventar uma
-- coluna a partir de um nome de arquivo seria adivinhação.
--
-- Idempotente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. `logs_auditoria` ganha dono.
--
-- Anulável, e não `not null`: evento de sistema (worker concluindo campanha,
-- webhook) legitimamente não tem empresa quando a campanha some, e a conta
-- global age sem empresa nenhuma. `AuditoriaService` já trata os dois casos.
-- ---------------------------------------------------------------------------
alter table logs_auditoria
  add column if not exists empresa_id uuid references empresas (id) on delete set null;

-- O filtro por empresa é o único acesso do admin de cliente à trilha; sem
-- índice ele varre uma tabela que nunca é expurgada (ver 20260817000400).
create index if not exists logs_empresa_idx on logs_auditoria (empresa_id, ocorrido_em desc);

/*
 * Backfill pelo autor.
 *
 * Log antigo sem `empresa_id` ficaria invisível para o admin da empresa que o
 * gerou — o filtro `empresa_id = <empresa>` não casa com NULL. Derivar de
 * `perfis` recupera todo evento com autor humano; os de sistema seguem nulos,
 * que é o valor certo para eles.
 */
update logs_auditoria l
   set empresa_id = p.empresa_id
  from perfis p
 where l.usuario_id = p.id
   and l.empresa_id is null
   and p.empresa_id is not null;

-- ---------------------------------------------------------------------------
-- 2. `registrar_resposta` volta a aceitar a empresa.
--
-- `create or replace` NÃO serve aqui: acrescentar parâmetro muda a assinatura,
-- e o Postgres passaria a ter DUAS funções sobrecarregadas com o mesmo nome. O
-- PostgREST escolhe pela lista de argumentos nomeados do corpo, então a de um
-- argumento ficaria acessível e continuaria contando resposta na empresa
-- errada — exatamente o defeito que esta migration corrige. Derruba a antiga.
--
-- `p_empresa_id` nulo continua significando "não sei de qual empresa é", que é
-- o estado do webhook quando o evento não traz canal: nesse caso a busca volta
-- a ser global, como era. É menos correto do que filtrar, e é de propósito —
-- deixar de contar uma resposta real seria pior, e o chamador em
-- `evolution.service.ts` já resolve a empresa pelo canal sempre que consegue.
-- ---------------------------------------------------------------------------
drop function if exists registrar_resposta(text);

create or replace function registrar_resposta(
  p_telefone   text,
  p_empresa_id uuid default null
)
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
  join campanhas c on c.id = cc.campanha_id
  where cc.telefone = p_telefone
    and cc.processado_em is not null
    and (p_empresa_id is null or c.empresa_id = p_empresa_id)
  order by cc.processado_em desc
  limit 1;

  if alvo is null then
    return false;
  end if;

  -- Incremento relativo à coluna, e não SELECT seguido de UPDATE: duas
  -- respostas simultâneas leriam o mesmo total e gravariam o mesmo número, e
  -- uma delas sumiria do relatório (ver ROBUSTEZ.md, item 5).
  update campanhas
  set total_respostas = total_respostas + 1
  where id = alvo;

  return true;
end;
$$;
