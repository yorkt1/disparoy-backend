-- ============================================================================
-- Respostas recebidas: o texto, e não só a contagem.
--
-- Até aqui a resposta do contato era um número. `tratarMensagemRecebida` lia o
-- texto, usava para detectar pedido de saída e DESCARTAVA — o painel sabia que
-- 40 pessoas responderam e não sabia o que nenhuma delas disse. O relatório
-- por contato (`resposta_1..5`) precisa do texto, e é isso que esta tabela
-- passa a guardar.
--
-- Nada aqui marca mensagem como lida. Ler o webhook é passivo: o read receipt
-- só sai se alguém chamar `chat/markMessageAsRead` na Evolution, e ninguém
-- chama. É a diferença entre o operador ver a resposta no painel e o celular
-- do cliente perder a notificação daquela conversa.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A tabela.
--
-- `campanha_contato_id` é NOT NULL de propósito: resposta de um telefone que
-- não está em campanha nenhuma não tem onde ser mostrada, e guardar texto
-- pessoal de terceiro sem uso é o oposto do que a retenção existe para
-- resolver. Quem não tem alvo continua sendo apenas contado (e, se for pedido
-- de saída, registrado em `opt_outs` — que é obrigação legal, não relatório).
--
-- `campanha_id` denormalizado pelo mesmo motivo de `mensagens_enviadas`: a
-- exportação lê "todas as respostas desta campanha", e sem a coluna isso vira
-- join com a lista inteira de contatos a cada página.
-- ---------------------------------------------------------------------------
create table if not exists respostas_recebidas (
  id                  bigserial primary key,
  campanha_id         uuid   not null references campanhas (id) on delete cascade,
  campanha_contato_id bigint not null references campanha_contatos (id) on delete cascade,
  canal_id            uuid references canais (id) on delete set null,
  telefone            text   not null,

  -- Texto puro. Vazio quando a resposta é mídia: aí o que informa é o `tipo`,
  -- e o relatório mostra "[imagem]" em vez de uma célula em branco que o
  -- operador leria como "não respondeu".
  texto               text   not null default '',
  tipo                text   not null default 'texto'
    check (tipo in ('texto', 'imagem', 'audio', 'video', 'documento', 'figurinha', 'outro')),

  -- `key.id` da Evolution. Único para que a reentrega do MESMO evento não
  -- vire duas respostas na planilha — o `eventos_webhook` já filtra a maior
  -- parte, mas ele desiste quando o payload chega sem id de mensagem.
  id_externo          text,
  recebida_em         timestamptz not null default now()
);

create unique index if not exists respostas_id_externo_idx
  on respostas_recebidas (id_externo) where id_externo is not null;

-- Índice da exportação: "as respostas desta campanha, na ordem em que
-- chegaram", que é exatamente como as colunas resposta_1..5 são preenchidas.
create index if not exists respostas_da_campanha_idx
  on respostas_recebidas (campanha_id, campanha_contato_id, recebida_em);

-- Como todas as tabelas do sistema: RLS ligada e nenhuma policy. A API usa a
-- service role e filtra por empresa em `noEscopo`; o que isso barra é acesso
-- direto com a anon key, que não deve existir.
alter table respostas_recebidas enable row level security;

-- ---------------------------------------------------------------------------
-- 2. `registrar_resposta` passa a gravar o texto junto com a contagem.
--
-- Uma função só, e não INSERT no serviço + RPC para contar: as duas coisas
-- respondem à mesma pergunta ("de que contato de campanha é este telefone?") e
-- resolvê-la duas vezes, em dois lugares, é como o contador e a lista
-- divergem. Aqui a busca acontece uma vez e as duas escritas saem dela.
--
-- Assinatura nova exige DROP, não `create or replace`: acrescentar parâmetro
-- cria uma SEGUNDA função sobrecarregada, e o PostgREST escolhe pela lista de
-- argumentos do corpo — a antiga continuaria alcançável, contando resposta sem
-- guardar texto. É o mesmo motivo documentado na migration 20260822000100.
--
-- `p_id_externo` repetido não conta de novo: o `on conflict` não insere, e sem
-- linha nova o total da campanha não sobe pela reentrega.
-- ---------------------------------------------------------------------------
drop function if exists registrar_resposta(text, uuid);

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
  where cc.telefone = p_telefone
    and cc.processado_em is not null
    and (p_empresa_id is null or c.empresa_id = p_empresa_id)
  order by cc.processado_em desc
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

  -- Reentrega do mesmo `key.id`: a linha já existe e o total já subiu por ela.
  if v_inserida is null and p_id_externo is not null then
    return false;
  end if;

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
-- 3. A retenção alcança o que passou a ser guardado.
--
-- `respostas_recebidas` guarda texto escrito PELO contato — dado pessoal de
-- terceiro, com o mesmo peso que `corpo_renderizado` tem em
-- `mensagens_enviadas`. Deixá-la fora do expurgo criaria exatamente o acúmulo
-- que a migration 20260817000400 existe para impedir.
--
-- Mesma regra dela, e pelo mesmo motivo: só campanha em estado TERMINAL perde
-- linha. Campanha pausada pode retomar.
--
-- O retorno continua sendo "quantas linhas saíram", agora somando as duas
-- tabelas — quem chama (`disparo.service.ts`) usa o número para registrar o
-- expurgo, não para distinguir origem.
-- ---------------------------------------------------------------------------
create or replace function purgar_mensagens_antigas(p_dias integer default 365)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_mensagens integer;
  v_respostas integer;
begin
  delete from mensagens_enviadas m
   using campanhas c
   where c.id = m.campanha_id
     and c.status in ('concluida', 'falhou')
     and m.enviada_em < now() - make_interval(days => p_dias);
  get diagnostics v_mensagens = row_count;

  delete from respostas_recebidas r
   using campanhas c
   where c.id = r.campanha_id
     and c.status in ('concluida', 'falhou')
     and r.recebida_em < now() - make_interval(days => p_dias);
  get diagnostics v_respostas = row_count;

  return v_mensagens + v_respostas;
end;
$$;
