-- ============================================================================
-- Resolução de incidente sem canal.
--
-- `resolver_incidentes_do_canal(p_canal_id)` fecha tudo que está aberto PARA
-- aquele canal — é o caminho certo quando quem se recupera é um número de
-- WhatsApp. Não serve para um incidente de infraestrutura que não tem canal
-- nenhum (o worker inteiro parou de bater pulso, por exemplo): não existe
-- `p_canal_id` para passar, e `null` ali fecharia todo incidente sem canal de
-- QUALQUER código, não só o que se resolveu.
--
-- A chave de conflito é a MESMA de `abrir_incidente` — `categoria + codigo +
-- coalesce(canal_id, zero-uuid)` —, então esta função fecha exatamente o
-- incidente que aquele par teria reaberto, nem mais nem menos.
--
-- Idempotente:atualização condicional (`resolvido_em is null`), reexecutar
-- sobre um incidente já fechado não faz nada.
-- ============================================================================

create or replace function resolver_incidente(
  p_categoria  categoria_falha,
  p_codigo     text,
  p_canal_id   uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_fechados integer;
begin
  update incidentes
     set resolvido_em = now()
   where categoria = p_categoria
     and codigo = p_codigo
     and coalesce(canal_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(p_canal_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and resolvido_em is null;

  get diagnostics v_fechados = row_count;
  return v_fechados;
end;
$$;
