-- ============================================================================
-- O teto diário por canal deixa de existir por padrão.
--
-- Ele nasceu como proteção anti-bloqueio para número novo, com 50 mensagens no
-- primeiro estágio. Mas a operação real é de até ~1.000 contatos e o dono do
-- número decide o próprio risco — e um teto de 50 significa uma campanha de mil
-- levando VINTE dias, cortada todo dia pela cota, sem que ninguém tenha pedido
-- isso.
--
-- `limite_diario` vira ANULÁVEL, e nulo significa "sem teto". Some diferente de
-- zero de propósito: zero seria "não pode enviar nada", e confundir os dois
-- pararia o disparo inteiro em silêncio.
--
-- A coluna e a função continuam existindo: quem quiser voltar a limitar um
-- número novo é só gravar um valor. O que muda é o padrão.
--
-- Idempotente: os `alter` e o `create or replace` podem reexecutar à vontade, e
-- o `update` é preso ao estado que só existe ANTES desta migration rodar (veja
-- abaixo).
-- ============================================================================

/*
 * O `update` roda UMA vez só, e quem garante isso é o próprio schema.
 *
 * `update canais set limite_diario = null` solto é destrutivo na segunda
 * execução: migration roda sobre banco no ar e pode ser reaplicada, e a versão
 * larga apagaria, calada, todo teto que alguém tivesse religado DEPOIS. O
 * cliente configura 500, a migration passa de novo num deploy, o canal volta a
 * ilimitado sem registro nenhum — e o único sintoma é um número disparando
 * acima do que o dono mandou, o oposto do que a coluna existe para fazer.
 *
 * `is_nullable = 'NO'` só é verdade ANTES do `drop not null` logo abaixo, então
 * ele distingue a primeira execução das seguintes sem precisar de tabela de
 * controle nem de adivinhar quais valores foram automáticos.
 */
do $$
declare
  primeira_vez boolean;
begin
  select is_nullable = 'NO'
    into primeira_vez
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'canais'
     and column_name = 'limite_diario';

  alter table canais alter column limite_diario drop not null;
  alter table canais alter column limite_diario drop default;

  -- Os canais que já existiam passam a ser ilimitados: nenhum deles pediu teto.
  if coalesce(primeira_vez, false) then
    update canais set limite_diario = null where limite_diario is not null;
  end if;
end $$;

/**
 * Consome a cota do dia, respeitando "sem teto".
 *
 * `limite_diario` nulo pula a checagem — mas o contador do dia continua sendo
 * mantido, porque `enviadas_hoje` é o que a tela usa para mostrar o volume e o
 * que permitiria religar um teto depois sem perder o histórico do dia.
 *
 * O `for update` segue serializando workers concorrentes no mesmo canal.
 */
create or replace function consumir_cota_canal(p_canal_id uuid, p_quantidade integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  atual canais%rowtype;
begin
  select * into atual from canais where id = p_canal_id for update;
  if not found then
    return false;
  end if;

  if atual.contador_zerado_em < current_date then
    atual.enviadas_hoje := 0;
    update canais
       set enviadas_hoje = 0, contador_zerado_em = current_date
     where id = p_canal_id;
  end if;

  -- Sem teto: só contabiliza e libera.
  if atual.limite_diario is not null
     and atual.enviadas_hoje + p_quantidade > atual.limite_diario then
    return false;
  end if;

  update canais
     set enviadas_hoje = atual.enviadas_hoje + p_quantidade
   where id = p_canal_id;

  return true;
end;
$$;
