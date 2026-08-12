-- ============================================================================
-- Row Level Security.
--
-- Camada de defesa para quem acessar o Postgres direto com a anon key. A API
-- usa a service role (que IGNORA RLS) e filtra por conta própria — então
-- nenhuma política aqui substitui a checagem de papel feita no NestJS.
--
-- Regra geral do single-tenant: usuário ativo LÊ a base compartilhada
-- (contatos, listas, templates, variações, campanhas). ESCRITA passa sempre
-- pela API, que valida limites e registra auditoria — por isso não há política
-- de insert/update/delete para o cliente, exceto onde indicado.
-- ============================================================================

alter table perfis enable row level security;
alter table canais enable row level security;
alter table canal_membros enable row level security;
alter table contatos enable row level security;
alter table listas enable row level security;
alter table lista_contatos enable row level security;
alter table templates enable row level security;
alter table spintax enable row level security;
alter table campanhas enable row level security;
alter table campanha_canais enable row level security;
alter table campanha_contatos enable row level security;
alter table mensagens_enviadas enable row level security;
alter table eventos_webhook enable row level security;
alter table logs_auditoria enable row level security;

-- --- Perfis -----------------------------------------------------------------
-- Cada um vê o próprio perfil; admin vê todos (precisa, para gerenciar acessos).
create policy perfil_proprio on perfis
  for select using (id = auth.uid() or eh_admin());

-- --- Canais -----------------------------------------------------------------
-- Operador só enxerga canal ao qual foi vinculado.
create policy canais_visiveis on canais
  for select using (pode_operar_canal(id));

create policy canal_membros_visiveis on canal_membros
  for select using (perfil_id = auth.uid() or eh_admin());

-- --- Base compartilhada do negócio ------------------------------------------
create policy contatos_visiveis on contatos
  for select using (eh_ativo());

create policy listas_visiveis on listas
  for select using (eh_ativo());

create policy lista_contatos_visiveis on lista_contatos
  for select using (eh_ativo());

create policy templates_visiveis on templates
  for select using (eh_ativo());

create policy spintax_visivel on spintax
  for select using (eh_ativo());

create policy campanhas_visiveis on campanhas
  for select using (eh_ativo());

create policy campanha_canais_visiveis on campanha_canais
  for select using (eh_ativo());

create policy campanha_contatos_visiveis on campanha_contatos
  for select using (eh_ativo());

create policy mensagens_visiveis on mensagens_enviadas
  for select using (eh_ativo());

-- --- Somente admin ----------------------------------------------------------
-- Payload bruto de webhook e trilha de auditoria são material de investigação:
-- operador não precisa, e o payload pode conter conteúdo de mensagem.
create policy eventos_webhook_admin on eventos_webhook
  for select using (eh_admin());

create policy logs_admin on logs_auditoria
  for select using (eh_admin());
