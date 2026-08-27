-- ============================================================================
-- A situação de cada contato dentro da campanha.
--
-- O painel sabia dizer quantas pessoas responderam e não sabia dizer QUEM.
-- A tela de campanha mostrava uma "amostra de contatos" com telefone e uma
-- variável — nada de entrega, nada de leitura, nada de resposta. Quem mandava
-- um disparo e recebia resposta não via nada acontecer.
--
-- Esta migration resolve três coisas, nesta ordem de importância:
--
--  1. Corrige um defeito REAL: resposta que chega antes de a sequência do
--     contato terminar era descartada em silêncio.
--  2. Traz leitura e contagem de resposta para `campanha_contatos`, para a
--     tela poder filtrar e contar sem varrer a campanha inteira.
--  3. Cria a `situacao` como coluna gerada — uma regra só, no banco, servindo
--     ao filtro, à contagem e ao relatório.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Índice que faltava.
--
-- `mensagens_enviadas` só tinha índice por (campanha_id, status) e por
-- `id_externo`. Toda busca "as mensagens DESTE contato" — o backfill abaixo, a
-- nova `registrar_resposta`, a exportação — varria a tabela inteira, que é a
-- que mais cresce no sistema.
-- ---------------------------------------------------------------------------
create index if not exists mensagens_do_contato_idx
  on mensagens_enviadas (campanha_contato_id);

-- ---------------------------------------------------------------------------
-- 2. Leitura e resposta ao lado do contato.
--
-- Denormalização deliberada: os dois fatos já são conhecidos no instante em
-- que o webhook chega, e a alternativa é a tela dobrar `mensagens_enviadas` e
-- `respostas_recebidas` a cada abertura — numa campanha de 20 mil contatos com
-- sequência de 5 passos, 100 mil linhas para preencher uma tabela de 25.
--
-- `lida_em` guarda a PRIMEIRA leitura, não a última: quem leu a primeira
-- mensagem leu a campanha. Exigir leitura do passo final marcaria como não
-- lida toda campanha que o contato interrompeu respondendo — que é justamente
-- o caso de sucesso.
-- ---------------------------------------------------------------------------
alter table campanha_contatos
  add column if not exists lida_em timestamptz,
  add column if not exists respostas integer not null default 0;

-- Backfill ANTES da coluna gerada: ela é calculada na escrita, e uma linha
-- preenchida depois não recalcula sozinha.
update campanha_contatos cc
set lida_em = m.primeira
from (
  select campanha_contato_id, min(lida_em) as primeira
  from mensagens_enviadas
  where lida_em is not null
  group by campanha_contato_id
) m
where m.campanha_contato_id = cc.id
  and cc.lida_em is null;

update campanha_contatos cc
set respostas = r.total
from (
  select campanha_contato_id, count(*)::integer as total
  from respostas_recebidas
  group by campanha_contato_id
) r
where r.campanha_contato_id = cc.id
  and cc.respostas <> r.total;

-- ---------------------------------------------------------------------------
-- 3. `situacao`: coluna GERADA, e não calculada no TypeScript.
--
-- A tela precisa filtrar por situação e contar por situação, e as duas coisas
-- só acontecem no banco — filtrar 20 mil linhas no navegador não é opção. Se a
-- regra vivesse no TypeScript, ela teria de ser reescrita em SQL para o filtro
-- e de novo para a contagem: três cópias da mesma decisão, e a que divergir
-- mostra um total que não bate com a lista logo abaixo dele.
--
-- É uma ESCADA, e a ordem dos ramos é a regra: cada degrau vence os de baixo,
-- porque o que interessa é o ponto mais avançado que aquele contato alcançou.
-- Responder vence ler — dá para responder sem o recibo de leitura chegar, e
-- nesse caso classificar como "não lido" seria absurdo diante de uma resposta
-- na tela.
--
-- `pendente` engloba `validando` e `enviando` de propósito: para quem olha a
-- tela, os três significam "ainda não saiu".
-- ---------------------------------------------------------------------------
alter table campanha_contatos
  add column if not exists situacao text generated always as (
    case
      when respostas > 0                              then 'respondeu'
      when lida_em is not null                        then 'lido'
      when status = 'concluido'                       then 'enviado'
      when status in ('falhou', 'invalido', 'bloqueado') then 'falhou'
      else 'pendente'
    end
  ) stored;

-- O índice do filtro da tela: "os contatos desta campanha nesta situação".
create index if not exists campanha_contatos_situacao_idx
  on campanha_contatos (campanha_id, situacao, id);

-- ---------------------------------------------------------------------------
-- 4. `registrar_resposta` — a correção que motivou esta migration.
--
-- O DEFEITO: a busca exigia `cc.processado_em is not null`, que só é
-- preenchido quando a sequência INTEIRA daquele contato termina. Numa
-- sequência de vários passos, a pessoa que responde a primeira mensagem
-- enquanto as outras ainda estão na fila não casava com contato nenhum — e a
-- resposta era descartada sem erro, sem log, sem linha em lugar nenhum. O
-- disparo funcionava, a pessoa respondia, e o sistema não registrava.
--
-- A intenção original do filtro estava certa: não creditar resposta a um
-- contato que ainda não recebeu nada, porque aí a resposta não pode ser a
-- ele. Errado era o campo escolhido para expressá-la. O que significa "já
-- recebeu algo" é existir mensagem enviada, e é isso que o `lateral` abaixo
-- pergunta — servindo também para ordenar pelo contato mais recentemente
-- alcançado, que é o desempate certo quando o mesmo telefone está em duas
-- campanhas.
--
-- Assinatura idêntica à da 20260826000100, então `create or replace` basta e
-- nenhuma sobrecarga nova aparece.
-- ---------------------------------------------------------------------------
create or replace function registrar_resposta(
  p_telefone    text,
  p_empresa_id  uuid        default null,
  p_texto       text        default '',
  p_tipo        text        default 'texto',
  p_id_externo  text        default null,
  p_recebida_em timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contato  bigint;
  v_campanha uuid;
  v_canal    uuid;
  v_inserida bigint;
begin
  select cc.id, cc.campanha_id, cc.canal_id
    into v_contato, v_campanha, v_canal
  from campanha_contatos cc
  join campanhas c on c.id = cc.campanha_id
  join lateral (
    select max(m.enviada_em) as ultima
    from mensagens_enviadas m
    where m.campanha_contato_id = cc.id
  ) envio on true
  where cc.telefone = p_telefone
    and envio.ultima is not null
    and (p_empresa_id is null or c.empresa_id = p_empresa_id)
  order by envio.ultima desc
  limit 1;

  if v_contato is null then
    return false;
  end if;

  insert into respostas_recebidas
    (campanha_id, campanha_contato_id, canal_id, telefone, texto, tipo, id_externo, recebida_em)
  values
    (v_campanha, v_contato, v_canal, p_telefone,
     coalesce(p_texto, ''), coalesce(p_tipo, 'texto'), p_id_externo,
     coalesce(p_recebida_em, now()))
  on conflict (id_externo) where id_externo is not null do nothing
  returning id into v_inserida;

  -- Reentrega do mesmo `key.id`: a linha já existe e os contadores já subiram
  -- por ela.
  if v_inserida is null and p_id_externo is not null then
    return false;
  end if;

  -- O contador do contato é o que a tela lê para dizer "respondeu". Sobe na
  -- mesma transação da linha da resposta: separá-los é como a lista e o selo
  -- passam a discordar.
  update campanha_contatos
  set respostas = respostas + 1
  where id = v_contato;

  -- Incremento relativo à coluna, e não SELECT seguido de UPDATE: duas
  -- respostas simultâneas leriam o mesmo total e gravariam o mesmo número, e
  -- uma delas sumiria do relatório (ver ROBUSTEZ.md, item 5).
  update campanhas
  set total_respostas = total_respostas + 1
  where id = v_campanha;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Contagem por situação, para os filtros da tela.
--
-- NÃO é `security definer`, e isso é a decisão: uma função de leitura que
-- ignorasse RLS devolveria a contagem de qualquer campanha para quem soubesse
-- o id, inclusive de outra empresa. Sem `definer`, a service role da API lê
-- tudo (como já lê) e qualquer outro acesso passa pelo RLS da tabela — mesmo
-- arranjo já usado na 20260822000400.
--
-- Um `jsonb` e não cinco `count`: são cinco viagens ao banco para preencher
-- cinco números que aparecem juntos, na mesma linha de filtros.
-- ---------------------------------------------------------------------------
create or replace function resumo_situacao_campanha(p_campanha_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(s.situacao, s.total), '{}'::jsonb)
  from (
    select situacao, count(*)::integer as total
    from campanha_contatos
    where campanha_id = p_campanha_id
    group by situacao
  ) s;
$$;
