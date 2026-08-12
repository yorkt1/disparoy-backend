-- ============================================================================
-- Acesso interno: sem auto-cadastro, o admin cria cada login com senha.
--
-- Idempotente de propósito — o banco de desenvolvimento já tinha as migrations
-- anteriores aplicadas quando esta nasceu, então ela precisa rodar tanto sobre
-- um banco novo quanto sobre um que já está no ar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- E-mail único em perfis
--
-- É por ele que a API reencontra o admin de ADMIN_EMAIL no boot. O Auth já
-- garante e-mail único em auth.users; aqui é para o SELECT nunca voltar duas
-- linhas e o bootstrap não criar um segundo admin em cima de um homônimo.
-- ---------------------------------------------------------------------------
create unique index if not exists perfis_email_unico on perfis (email);

-- ---------------------------------------------------------------------------
-- O trigger de onboarding deixa de confiar no cliente
--
-- Antes o papel saía de `raw_user_meta_data ->> 'papel'`. Esses campos são
-- escolhidos por quem chama `signUp({ options: { data } })`, e a anon key está
-- no bundle do frontend: qualquer um se cadastrava como admin.
--
-- Agora todo perfil nasce operator INATIVO. Quem libera papel e `ativo` é a
-- API, com a service role, logo depois de criar o usuário pela Admin API — o
-- único caminho que exige um admin autenticado do outro lado. O primeiro admin
-- sai de ADMIN_EMAIL/ADMIN_SENHA, garantido no boot da API.
--
-- O efeito colateral é a rede de segurança: se o auto-cadastro for reaberto por
-- engano no painel do Supabase, a conta nasce trancada — o AuthGuard barra
-- perfil inativo — em vez de virar um acesso válido.
-- ---------------------------------------------------------------------------
create or replace function tratar_novo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into perfis (id, nome, email, papel, ativo)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'nome'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    'operator',
    false
  );

  return new;
end;
$$;
