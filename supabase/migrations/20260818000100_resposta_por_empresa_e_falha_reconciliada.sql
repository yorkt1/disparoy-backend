-- ============================================================================
-- Dois furos que sobraram das migrations anteriores, cada um por ter sido
-- escrito ANTES da peça que o completaria.
--
--  1. `reconciliar_disparos` desiste de um contato marcando `falhou` sem
--     código nem categoria — as colunas nasceram na migration seguinte
--     (`20260814000200_atribuicao_falha`) e este caminho nunca foi revisitado.
--
--  2. `registrar_resposta` acha a campanha só pelo telefone, sem olhar
--     empresa — foi escrita antes de `20260815000200_empresas` existir.
--
-- Idempotente: roda sobre o banco que já está no ar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Desistência do reconciliador passa a ter origem atribuída.
--
-- `CLAUDE.md` e `docs/ARQUITETURA-ATRIBUICAO-DE-FALHA.md` são explícitos: toda
-- falha carrega um código, e o que separa "o WhatsApp do cliente caiu" de
-- "nossa infraestrutura caiu" é justamente a CATEGORIA. Este caminho gravava
-- `falhou` com um texto e mais nada, então o contato interrompido três vezes
-- por reinício do worker — falha NOSSA, categoria `infra` — chegava na tela da
-- campanha sem categoria alguma, indistinguível de erro do destinatário.
--
-- O código é `desconhecido` porque é a verdade: o worker foi interrompido e
-- ninguém sabe em que ponto o envio travou. O que importa aqui é a categoria
-- `infra`, que impede o sistema de acusar o cliente por um problema nosso, e é
-- ela que `desconhecido` carrega em `shared/src/whatsapp/falhas.ts`.
--
-- Nada mais muda: o limite de tentativas, o texto do motivo e a devolução dos
-- que ainda têm tentativa sobrando continuam exatamente como estavam.
-- ---------------------------------------------------------------------------
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
        -- A parte nova: sem estas duas colunas a falha ficava sem dono.
        falha_codigo = 'desconhecido',
        falha_categoria = 'infra',
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

-- ---------------------------------------------------------------------------
-- 2. A resposta é creditada dentro da EMPRESA que falou com aquele número.
--
-- A versão anterior procurava em `campanha_contatos` só por telefone e pegava
-- a campanha processada mais recentemente, de qualquer empresa. Um número que
-- é cliente de duas — o que não tem nada de exótico, é o caso comum de uma
-- lista comprada ou de uma revenda — fazia a resposta que chegou pelo canal de
-- uma empresa subir o `total_respostas` da campanha da OUTRA. Não é vazamento
-- de conteúdo, mas é métrica de um cliente mexida por evento de outro: a taxa
-- de resposta que o painel mostra deixa de ser dele.
--
-- `p_empresa_id` entra com default `null` para o comportamento antigo continuar
-- disponível a quem não sabe a empresa. Quem chama pelo webhook SABE: a
-- instância identifica o canal, e o canal tem dono.
--
-- O DROP antes é necessário: `create or replace` com uma assinatura diferente
-- criaria uma SOBRECARGA em vez de substituir, e as duas conviveriam — a
-- chamada de um argumento continuaria caindo na versão sem filtro, que é
-- exatamente o defeito que se está corrigindo.
-- ---------------------------------------------------------------------------
drop function if exists registrar_resposta(text);
drop function if exists registrar_resposta(text, uuid);

create function registrar_resposta(p_telefone text, p_empresa_id uuid default null)
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
    -- `null` mantém o comportamento antigo (qualquer empresa), para não
    -- quebrar chamador que ainda não informe a origem.
    and (p_empresa_id is null or c.empresa_id = p_empresa_id)
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
