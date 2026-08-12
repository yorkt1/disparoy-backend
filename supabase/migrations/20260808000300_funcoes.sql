-- ============================================================================
-- Onboarding, contadores e regras de execução.
-- ============================================================================

/**
 * Perfil automático para todo usuário criado no Supabase Auth.
 *
 * O PRIMEIRO usuário do sistema vira admin — senão ninguém conseguiria criar
 * os demais e a instalação nasceria travada. Os seguintes entram como
 * operator, e o admin promove quem precisar.
 *
 * SUBSTITUÍDA em 20260809000100_acesso_interno.sql: confiar no papel vindo de
 * `raw_user_meta_data` deixava qualquer um se cadastrar como admin.
 */
create or replace function tratar_novo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  papel_novo papel_usuario;
begin
  select case when exists (select 1 from perfis) then 'operator' else 'admin' end
  into papel_novo;

  insert into perfis (id, nome, email, papel)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'nome'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'papel', '')::papel_usuario,
      papel_novo
    )
  );

  return new;
end;
$$;

create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute function tratar_novo_usuario();

/**
 * Recalcula os contadores da campanha a partir de mensagens_enviadas.
 *
 * Chamado em lote pelo worker, não por mensagem: numa campanha de 20 mil
 * contatos, um UPDATE por mensagem seria dezenas de milhares de escritas na
 * mesma linha, com contenção garantida.
 */
create or replace function recalcular_metricas_campanha(p_campanha_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update campanhas c
  set
    total_enviadas = m.enviadas,
    total_entregues = m.entregues,
    total_lidas = m.lidas,
    total_falhas = m.falhas
  from (
    select
      count(*) filter (where status in ('enviada', 'entregue', 'lida')) as enviadas,
      count(*) filter (where status in ('entregue', 'lida')) as entregues,
      count(*) filter (where status = 'lida') as lidas,
      count(*) filter (where status = 'falhou') as falhas
    from mensagens_enviadas
    where campanha_id = p_campanha_id
  ) m
  where c.id = p_campanha_id;
$$;

/**
 * Fecha a campanha quando não sobra contato pendente.
 * Devolve true só na transição, para o worker registrar auditoria uma vez só.
 */
create or replace function concluir_campanha_se_terminou(p_campanha_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  restantes integer;
begin
  select count(*) into restantes
  from campanha_contatos
  where campanha_id = p_campanha_id
    and status in ('pendente', 'validando', 'enviando');

  if restantes > 0 then
    return false;
  end if;

  update campanhas
  set status = 'concluida', concluida_em = now()
  where id = p_campanha_id and status = 'em_andamento';

  return found;
end;
$$;

/**
 * Consome cota diária do canal e devolve se o envio pode prosseguir.
 *
 * O contador zera sozinho na virada do dia — sem isso seria preciso um cron
 * só para resetar, e um cron atrasado bloquearia disparos legítimos.
 * O `for update` serializa workers concorrentes no mesmo canal.
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

  if atual.enviadas_hoje + p_quantidade > atual.limite_diario then
    return false;
  end if;

  update canais
  set enviadas_hoje = enviadas_hoje + p_quantidade
  where id = p_canal_id;

  return true;
end;
$$;

/**
 * Registra o opt-out do contato e o remove das campanhas ainda não enviadas.
 *
 * Marcar o contato sem limpar a fila deixaria mensagens já enfileiradas
 * saírem depois do pedido de saída — que é exatamente o que a LGPD proíbe.
 */
create or replace function registrar_opt_out(p_telefone text, p_motivo text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  id_contato uuid;
begin
  update contatos
  set opt_out_em = now(), opt_out_motivo = p_motivo, atualizado_em = now()
  where telefone = p_telefone and opt_out_em is null
  returning id into id_contato;

  if id_contato is null then
    return null;
  end if;

  update campanha_contatos
  set status = 'bloqueado', motivo = 'Contato pediu para sair', processado_em = now()
  where contato_id = id_contato and status = 'pendente';

  return id_contato;
end;
$$;

/**
 * Materializa os contatos elegíveis de uma lista dentro da campanha.
 *
 * O filtro de consentimento acontece AQUI, no banco, e não na aplicação: é a
 * última barreira antes de a mensagem existir, e nenhum caminho de código
 * consegue contorná-la.
 */
create or replace function popular_contatos_da_campanha(p_campanha_id uuid, p_lista_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inseridos integer;
begin
  insert into campanha_contatos (campanha_id, contato_id, telefone, variaveis)
  select p_campanha_id, c.id, c.telefone, c.variaveis
  from lista_contatos lc
  join contatos c on c.id = lc.contato_id
  where lc.lista_id = p_lista_id
    and c.opt_in
    and c.opt_out_em is null
  on conflict (campanha_id, contato_id) do nothing;

  get diagnostics inseridos = row_count;

  update campanhas set total_contatos = inseridos where id = p_campanha_id;
  return inseridos;
end;
$$;
