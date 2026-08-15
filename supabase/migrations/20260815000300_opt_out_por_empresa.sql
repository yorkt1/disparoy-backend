-- ============================================================================
-- Opt-out depois de o telefone deixar de ser único global.
--
-- `registrar_opt_out` faz `update contatos where telefone = p_telefone` e
-- devolve o id com `returning ... into`. Isso era correto enquanto existia no
-- máximo uma linha por telefone. Com a unicidade agora por empresa, o mesmo
-- número pode existir em duas — e `into` pega UMA das linhas, sem ordem
-- definida. O pedido de saída marcaria a empresa errada, em silêncio, num
-- caminho que é justamente o de obrigação legal.
--
-- A função passa a receber a empresa e a devolver QUANTAS linhas marcou.
--
-- ---------------------------------------------------------------------------
-- `p_empresa_id => null` significa TODAS as empresas, não "nenhuma".
--
-- É a direção segura para este caminho específico: o webhook recebe "sair" pelo
-- WhatsApp e ainda não resolve de qual empresa era o canal. Entre marcar demais
-- e marcar de menos, marcar demais deixa alguém sem receber uma campanha que
-- talvez aceitasse; marcar de menos manda mensagem para quem pediu para parar.
-- Só o segundo é violação.
--
-- Quando o webhook passar a resolver o canal, passe a empresa e o
-- comportamento fica restrito sem mexer nesta função.
-- ---------------------------------------------------------------------------
-- ============================================================================

-- A assinatura antiga precisa sair: adicionar um parâmetro com default cria uma
-- SOBRECARGA, e a chamada com dois argumentos ficaria ambígua para o Postgres.
drop function if exists registrar_opt_out(text, text);

create or replace function registrar_opt_out(
  p_telefone   text,
  p_motivo     text,
  p_empresa_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids   uuid[];
  v_total integer;
begin
  -- O UPDATE vai dentro de uma CTE porque `returning ... into` em plpgsql lê
  -- UMA linha: com o mesmo telefone em duas empresas, a segunda seria marcada
  -- no banco e sumiria da contagem devolvida. O `array_agg` sobre a CTE é o que
  -- captura todas.
  with marcados as (
    update contatos
       set opt_out_em     = now(),
           opt_out_motivo = p_motivo,
           atualizado_em  = now()
     where telefone = p_telefone
       and opt_out_em is null
       and (p_empresa_id is null or empresa_id = p_empresa_id)
    returning id
  )
  select array_agg(id) into v_ids from marcados;

  v_total := coalesce(array_length(v_ids, 1), 0);
  if v_total = 0 then
    return 0;
  end if;

  update campanha_contatos
     set status       = 'bloqueado',
         motivo       = 'Contato pediu para sair',
         processado_em = now()
   where contato_id = any (v_ids)
     and status = 'pendente';

  return v_total;
end;
$$;
