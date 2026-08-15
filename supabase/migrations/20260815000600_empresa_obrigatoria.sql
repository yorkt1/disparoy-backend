-- ============================================================================
-- `empresa_id` vira obrigatório. É o fecho do isolamento entre empresas.
--
-- A migration de empresas deixou a coluna com DEFAULT apontando para a empresa
-- padrão, de propósito: enquanto a API não informasse o dono em toda escrita,
-- o default mantinha o sistema funcionando e um deploy pela metade não
-- derrubava a criação de campanha.
--
-- Agora a API informa. Manter o default a partir daqui seria pior que inútil —
-- ele transformaria "esqueci de passar a empresa" em "gravou na empresa
-- errada, em silêncio". Sem ele, o mesmo esquecimento vira erro na primeira
-- tentativa.
--
-- A ordem importa: aplique DEPOIS de o código novo estar no ar. Antes disso,
-- toda escrita que ainda dependa do default passa a falhar.
--
-- Idempotente.
-- ============================================================================

do $$
declare
  t text;
  v_orfas integer;
begin
  foreach t in array array['contatos', 'listas', 'templates', 'spintax', 'campanhas', 'canais']
  loop
    -- Cinto de segurança: se alguma linha escapou do backfill, a migration
    -- para com uma mensagem que diz ONDE, em vez de estourar num `not null`
    -- genérico que não ajuda ninguém a consertar.
    execute format('select count(*) from %I where empresa_id is null', t) into v_orfas;
    if v_orfas > 0 then
      raise exception
        'A tabela % ainda tem % linha(s) sem empresa. Rode o backfill da migration 20260815000200 antes desta.',
        t, v_orfas;
    end if;

    execute format('alter table %I alter column empresa_id drop default', t);
    execute format('alter table %I alter column empresa_id set not null', t);
  end loop;
end;
$$;

/*
 * `perfis.empresa_id` continua ANULÁVEL, e isto não é esquecimento.
 *
 * Nulo ali significa acesso global — a conta de administração, que atravessa
 * todas as empresas. É um estado legítimo, não um dado faltando, e é o que
 * `noEscopo()` lê para decidir se filtra ou não.
 */
