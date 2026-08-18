-- ============================================================================
-- Retenção de `mensagens_enviadas`.
--
-- É a tabela que mais cresce no sistema (uma linha por contato por passo da
-- sequência) e, ao contrário de `logs_auditoria`, não guarda ação de operador
-- — guarda `corpo_renderizado`, o texto que o CONTATO recebeu, e o vínculo até
-- o telefone dele via `campanha_contato_id`. Sem expurgo, dado pessoal de
-- terceiro que nunca teve relação com o sistema depois da campanha se acumula
-- para sempre, sem que exista onde atender um pedido de exclusão.
--
-- `logs_auditoria` FICA DE FORA de propósito, e não por esquecimento: aquela
-- tabela é ação de QUEM OPERA o sistema (nossos usuários, não os contatos
-- deles), e o próprio `limpar_avisos_antigos` já documenta que ela "precisa
-- durar para sempre" — é a peça que sustenta "quem fez o quê" numa disputa. As
-- duas tabelas têm o mesmo formato e motivos opostos para o prazo.
--
-- Só campanha em estado TERMINAL (`concluida`, `falhou`) perde mensagem. Uma
-- campanha `pausada`/`pausada_por_canal` pode retomar, e o worker decide onde
-- retomar lendo `mensagens_enviadas.passo` (ver `ROBUSTEZ.md`) — apagar essas
-- linhas destruiria o proprio estado que permite a retomada sem reenviar.
--
-- 365 dias por padrão: generoso o bastante para cobrir qualquer janela de
-- disputa razoável sobre uma campanha, e ajustável por quem operar sem
-- precisar de nova migration.
-- ============================================================================

create or replace function purgar_mensagens_antigas(p_dias integer default 365)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_apagadas integer;
begin
  delete from mensagens_enviadas m
   using campanhas c
   where c.id = m.campanha_id
     and c.status in ('concluida', 'falhou')
     and m.enviada_em < now() - make_interval(days => p_dias);

  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
