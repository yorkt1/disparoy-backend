-- ============================================================================
-- Escopo de empresa no diagnóstico de falhas.
--
-- `diagnostico_falhas` e `diagnostico_amostras` agregam `mensagens_enviadas`
-- inteira, sem filtro nenhum de empresa — e o texto bruto que elas devolvem
-- carrega o número do destinatário no meio, às vezes (ver comentário do
-- controller). Admin da Empresa A abria a tela e via o padrão de falha, os
-- canais e os números de destinatário da Empresa B inteira.
--
-- `mensagens_enviadas` não tem `empresa_id` própria — nunca precisou, porque
-- só era lida via estas duas funções, sempre sem filtro algum. A empresa vem
-- por JOIN em `campanhas`, que já é `not null` desde `empresa_obrigatoria`.
--
-- `p_empresa_id default null` no FINAL da assinatura: quem já chama estas
-- funções sem o parâmetro continua funcionando, e `null` preserva o
-- comportamento antigo — "vê tudo" — que é exatamente o que a conta global
-- precisa continuar tendo.
--
-- Idempotente: `create or replace function` só acrescenta parâmetro com
-- default; a assinatura anterior continua compatível com posicional e nomeado.
-- ============================================================================

create or replace function diagnostico_falhas(p_desde timestamptz, p_empresa_id uuid default null)
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
  join campanhas c on c.id = m.campanha_id
  where m.status = 'falhou'
    and m.enviada_em >= p_desde
    and (p_empresa_id is null or c.empresa_id = p_empresa_id)
  group by 1, 2
  order by total desc;
$$;

create or replace function diagnostico_amostras(
  p_desde       timestamptz,
  p_codigo      text default null,
  p_limite      integer default 30,
  p_empresa_id  uuid default null
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
  join campanhas c on c.id = m.campanha_id
  where m.status = 'falhou'
    and m.enviada_em >= p_desde
    and m.erro is not null
    and m.erro <> ''
    and (p_codigo is null or coalesce(m.erro_codigo, 'nao_registrado') = p_codigo)
    and (p_empresa_id is null or c.empresa_id = p_empresa_id)
  group by 1, 3, 4
  order by total desc
  limit p_limite;
$$;
