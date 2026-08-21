-- ============================================================================
-- Reentrega do mesmo evento da Evolution deixa de ser processada duas vezes.
--
-- O controller responde 200 antes de processar, justamente para a Evolution não
-- reenviar o evento por lentidão. Isso não elimina a reentrega — ela também
-- acontece quando a resposta se perde na rede, quando o Render reinicia a
-- réplica no meio do deploy, ou quando alguém reenvia o payload à mão.
--
-- A maioria dos handlers aguenta repetição: `avancaStatus` nunca regride e
-- `registrarOptOut` é idempotente. `contarResposta` NÃO é: ela chama
-- `registrar_resposta`, que faz `total_respostas + 1` relativo à coluna. Um
-- `MESSAGES_UPSERT` reentregue conta a mesma resposta do contato duas vezes, e
-- a taxa de resposta exibida no painel — que é o número por onde o operador
-- julga se a campanha funcionou — sobe sozinha.
--
-- A chave só existe para evento que carrega id de mensagem. `CONNECTION_UPDATE`
-- não tem id nenhum e fica de fora: os efeitos dele (abrir incidente, pausar
-- campanha em andamento) já são idempotentes por construção.
-- ============================================================================

alter table eventos_webhook
  add column if not exists chave_evento text;

/**
 * Parcial porque a maioria dos eventos não tem chave, e `null` não conflita com
 * `null` em índice único — mas varrer essas linhas à toa em cada insert é
 * desperdício numa tabela que é de longe a maior do banco.
 *
 * O índice vale só enquanto a linha existe: `limpar_eventos_webhook` apaga o
 * que passou da retenção, e depois disso um replay muito antigo voltaria a ser
 * processado. Catorze dias é ordens de grandeza acima da janela de reentrega da
 * Evolution, que é de segundos.
 */
create unique index if not exists eventos_webhook_chave_idx
  on eventos_webhook (chave_evento)
  where chave_evento is not null;

-- ---------------------------------------------------------------------------
-- Retenção: evento com erro também precisa de prazo.
--
-- A versão anterior desta função apagava apenas `processado and erro is null`,
-- de propósito — evento que falhou é o que alguém vai querer ler ao
-- investigar. O efeito colateral é que a exceção virou permanente: uma
-- instabilidade que faça mil eventos falharem deixa mil payloads crus no banco
-- para sempre, e payload cru de `MESSAGES_UPSERT` contém o telefone e o TEXTO
-- que o contato escreveu.
--
-- Isso contradiz o motivo declarado de `purgar_mensagens_antigas`
-- (`20260817000400`): dado pessoal de terceiro que nunca teve relação com o
-- sistema não pode se acumular sem prazo nem lugar onde atender um pedido de
-- exclusão. Noventa dias é tempo de sobra para investigar uma falha e curto o
-- bastante para não virar arquivo permanente.
--
-- A assinatura não muda: o worker continua chamando `limpar_eventos_webhook(14)`.
-- ---------------------------------------------------------------------------
create or replace function limpar_eventos_webhook(p_dias integer default 14)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  apagados     integer;
  com_erro     integer;
begin
  delete from eventos_webhook
  where recebido_em < now() - make_interval(days => p_dias)
    and processado
    and erro is null;

  get diagnostics apagados = row_count;

  delete from eventos_webhook
  where recebido_em < now() - interval '90 days';

  get diagnostics com_erro = row_count;
  return apagados + com_erro;
end;
$$;
