-- ============================================================================
-- Diagnóstico de falhas: a volta do ciclo de aprendizado.
--
-- A entrega anterior passou a CLASSIFICAR toda falha (`erro_codigo`,
-- `erro_categoria`) e a avisar o operador. Ficou faltando o outro lado: olhar o
-- acumulado e corrigir a própria classificação. Até aqui a única forma de fazer
-- isso era abrir o SQL Editor do Supabase e escrever a query na mão — o que
-- significa, na prática, que ninguém faz.
--
-- Isso importa mais aqui do que importaria numa API oficial. Baileys/Evolution
-- não publicam catálogo de erro: o texto muda de versão para versão, e a única
-- fonte de verdade sobre o que o gateway responde é o que ele já respondeu
-- neste banco. Cada regra em `classificarEvolution` só pode ser escrita depois
-- de ver o texto bruto agrupado.
--
-- Por isso as duas funções aqui são de leitura e agregam sobre o texto bruto,
-- que nunca foi descartado.
--
-- Idempotente: roda sobre o banco que já está no ar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Índice para a janela de tempo.
--
-- As duas funções varrem `mensagens_enviadas` por data filtrando falha. Sem
-- isto, cada abertura da tela vira um seq scan sobre a tabela que mais cresce
-- no sistema — é a única tabela que ganha uma linha por contato por passo.
-- ---------------------------------------------------------------------------
create index if not exists mensagens_diagnostico_idx
  on mensagens_enviadas (enviada_em desc)
  where status = 'falhou';

-- ---------------------------------------------------------------------------
-- Contagem por código, a visão de cima.
--
-- `coalesce(erro_codigo, 'nao_registrado')` existe por causa das linhas
-- gravadas ANTES da coluna existir. Some-las seria esconder justamente o
-- período que mais interessa reprocessar; aparecendo como um código próprio,
-- fica claro que são falhas antigas sem classificação, não um código novo.
-- ---------------------------------------------------------------------------
create or replace function diagnostico_falhas(p_desde timestamptz)
returns table (
  codigo      text,
  categoria   categoria_falha,
  total       bigint,
  canais      bigint,
  campanhas   bigint,
  primeira_em timestamptz,
  ultima_em   timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    coalesce(m.erro_codigo, 'nao_registrado') as codigo,
    m.erro_categoria                          as categoria,
    count(*)                                  as total,
    count(distinct m.canal_id)                as canais,
    count(distinct m.campanha_id)             as campanhas,
    min(m.enviada_em)                         as primeira_em,
    max(m.enviada_em)                         as ultima_em
  from mensagens_enviadas m
  where m.status = 'falhou'
    and m.enviada_em >= p_desde
  group by 1, 2
  order by total desc;
$$;

-- ---------------------------------------------------------------------------
-- O texto bruto agrupado — a matéria-prima para escrever regra nova.
--
-- Agrupar pelo texto cru não funcionaria: a Evolution devolve o número do
-- destinatário e o id da instância dentro da mensagem, então cada falha viraria
-- um grupo de tamanho 1 e a tela mostraria mil linhas iguais. As duas
-- substituições abaixo (uuid primeiro, depois sequências longas de dígito)
-- transformam "não existe o número 5511998887766" e "não existe o número
-- 5511777776666" no mesmo padrão, que é a pergunta real: quantas vezes ISTO
-- aconteceu?
--
-- `exemplo` guarda uma ocorrência intacta porque o padrão normalizado não serve
-- para escrever o regex da regra nova — para isso é preciso o texto como o
-- gateway mandou.
-- ---------------------------------------------------------------------------
create or replace function diagnostico_amostras(
  p_desde   timestamptz,
  p_codigo  text default null,
  p_limite  integer default 30
)
returns table (
  padrao    text,
  exemplo   text,
  codigo    text,
  categoria categoria_falha,
  total     bigint,
  ultima_em timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    regexp_replace(
      regexp_replace(m.erro, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<id>', 'g'),
      '\d{4,}', '<num>', 'g'
    )                                          as padrao,
    (array_agg(m.erro order by m.enviada_em desc))[1] as exemplo,
    coalesce(m.erro_codigo, 'nao_registrado')  as codigo,
    m.erro_categoria                           as categoria,
    count(*)                                   as total,
    max(m.enviada_em)                          as ultima_em
  from mensagens_enviadas m
  where m.status = 'falhou'
    and m.enviada_em >= p_desde
    and m.erro is not null
    and m.erro <> ''
    and (p_codigo is null or coalesce(m.erro_codigo, 'nao_registrado') = p_codigo)
  group by 1, 3, 4
  order by total desc
  limit p_limite;
$$;
