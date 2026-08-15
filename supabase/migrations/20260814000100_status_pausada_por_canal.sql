-- ============================================================================
-- Novo estado de campanha: pausa causada pelo sistema, não pelo operador.
--
-- Precisa ser distinta de `pausada` porque só ela pode ser retomada
-- automaticamente. Retomar sozinho o que uma pessoa pausou de propósito seria
-- a pior surpresa possível num sistema que dispara para gente de verdade.
--
-- Sozinha num arquivo de propósito: em Postgres, um valor de enum adicionado
-- não fica visível para funções `language sql` criadas na MESMA transação, e a
-- migration seguinte cria justamente uma que o referencia. Separar é mais
-- simples do que desligar `check_function_bodies`.
-- ============================================================================

alter type status_campanha add value if not exists 'pausada_por_canal';
