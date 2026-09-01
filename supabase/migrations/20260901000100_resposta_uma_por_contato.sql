-- ============================================================================
-- Resposta é UMA por contato: a primeira. O resto é conversa.
--
-- O DEFEITO: `registrar_resposta` creditava à campanha TODA mensagem vinda
-- daquele telefone, para sempre. A busca não tem janela de tempo nem teto — o
-- critério é "a campanha mais recente que alcançou este número" —, então
-- depois que o disparo passou por ali o bate-papo inteiro dos meses seguintes
-- virava resposta de campanha: linha em `respostas_recebidas`, `+1` em
-- `campanha_contatos.respostas` e `+1` em `campanhas.total_respostas`.
--
-- Como apareceu: um contato com 34 "respostas" cujo texto era `[figurinha]`,
-- `primeiro dia`, `jkkkk`. Outro com `vou comer` e `entao espera dps vejo
-- isso`. Nenhuma delas responde a disparo nenhum — é o WhatsApp sendo usado
-- como WhatsApp, contado como métrica de campanha.
--
-- O estrago não é só a lista feia. `total_respostas` alimenta "Respostas
-- recebidas" no dashboard e a taxa de resposta da campanha, e as duas subiam
-- sozinhas com o tempo: quanto mais antiga a campanha, melhor o número dela
-- parecia. Métrica que melhora sem ninguém fazer nada é métrica que ninguém
-- pode usar para decidir.
--
-- A REGRA NOVA: um contato respondeu ou não respondeu. Vale a primeira
-- mensagem depois do disparo; as seguintes não contam e não são guardadas.
-- É o que "taxa de resposta" já significava para quem lê o painel, e é a
-- definição que não apodrece — sem janela para calibrar, sem número que se
-- mexe sozinho depois que a campanha terminou.
--
-- O que esta migration NÃO faz é mexer no que já está gravado. As campanhas
-- antigas seguem com os totais inflados: decisão de quem opera, para não
-- reescrever histórico que já foi lido e comparado. Vale daqui para frente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- O opt-out não passa por aqui, e é o que torna este corte seguro.
--
-- `tratarMensagemRecebida` chama `ehPedidoDeSaida(texto)` em TODA mensagem
-- recebida, antes e independente desta função. Um "PARE" que chegue como
-- quinta mensagem do contato continua registrando opt-out normalmente — o que
-- esta função decide é só o que vira métrica e o que aparece na tela, nunca o
-- que a lei exige guardar.
--
-- Assinatura idêntica à da 20260826000200: `create or replace` basta, e
-- nenhuma sobrecarga nova aparece para o PostgREST escolher.
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

  /*
   * Serializa por contato antes de perguntar se ele já respondeu.
   *
   * Sem o lock, duas mensagens que chegam juntas — "oi" e "tudo bem?" mandados
   * em sequência, que é como as pessoas escrevem no WhatsApp — leem as duas o
   * mesmo "ainda não respondeu" e as duas gravam. O contato terminaria com as
   * duas linhas e o contador em 2, que é exatamente o que esta migration
   * existe para impedir.
   *
   * Advisory lock e não índice único em `campanha_contato_id`: o índice seria
   * a garantia mais forte, e não pode ser criado — a tabela já tem os
   * duplicados do histórico, que ficam por decisão de quem opera, e o
   * `create unique index` falharia neste banco. O lock é de transação, some no
   * commit e não deixa nada para limpar.
   */
  perform pg_advisory_xact_lock(v_contato);

  -- A primeira resposta é a que vale. Existindo linha para este contato, o
  -- que chegou agora é conversa: não conta, não é guardada.
  if exists (select 1 from respostas_recebidas where campanha_contato_id = v_contato) then
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

  -- Reentrega do mesmo `key.id` para um contato SEM resposta guardada: só
  -- acontece se a linha original tiver sido apagada pelo expurgo enquanto o
  -- evento voltava. O `exists` acima já cobre o caso normal de reentrega; este
  -- ramo continua aqui porque o `on conflict` ainda pode não inserir, e subir
  -- contador sem linha é como o total passa a discordar da lista.
  if v_inserida is null then
    return false;
  end if;

  -- O contador do contato é o que a tela lê para dizer "respondeu". Sobe na
  -- mesma transação da linha da resposta: separá-los é como a lista e o selo
  -- passam a discordar. Agora ele só vai de 0 para 1 — a coluna gerada
  -- `situacao` continua lendo `respostas > 0` e não muda de comportamento.
  update campanha_contatos
  set respostas = respostas + 1
  where id = v_contato;

  -- `total_respostas` passa a contar CONTATOS que responderam, não mensagens
  -- recebidas. É a mudança de sentido que conserta a métrica: dividido por
  -- quem foi alcançado, agora é taxa de resposta de verdade — antes podia
  -- passar de 100% e ninguém entendia por quê.
  update campanhas
  set total_respostas = total_respostas + 1
  where id = v_campanha;

  return true;
end;
$$;
