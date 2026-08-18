-- ============================================================================
-- Escopo de empresa na trilha de auditoria.
--
-- `logs_auditoria` nasceu antes de `empresas` existir e nunca ganhou a coluna
-- quando o resto do sistema ganhou. O efeito prático: `AuditoriaService.listar`
-- não tinha o que filtrar, então admin da Empresa A lia o histórico completo da
-- Empresa B — quem fez o quê, IP, nome de campanha e de canal. A API ignora RLS
-- de propósito (ver `comum/escopo.ts`); sem a coluna, não existia sequer a
-- POSSIBILIDADE de filtrar.
--
-- `empresa_id` fica ANULÁVEL. Duas razões, não uma:
--
--  1. Ação da conta global (`usuario_id` de um admin com `empresas.id = null`)
--     não pertence a empresa nenhuma — é o mesmo `null` que atravessa tudo em
--     `UsuarioAutenticado.empresaId`, e forçar um valor aqui inventaria um dono
--     que não existe.
--  2. Evento do WORKER (`usuario_id is null`, `usuario_nome = 'Sistema'`) não
--     tem perfil para derivar a empresa por join — precisa que quem registra
--     informe explicitamente, e nem todo call site vai ser tocado nesta
--     entrega.
--
-- O backfill deriva de `perfis.empresa_id` pelo autor do evento (`usuario_id`).
-- É uma aproximação deliberada, não um bug: um admin GLOBAL que cria um usuário
-- DENTRO de uma empresa específica gera um log com `empresa_id = null` (porque
-- o autor é global), mesmo a ação dizendo respeito a uma empresa — o alvo já
-- fica registrado em `detalhes`. Errar nessa direção é seguro: o log fica
-- visível a menos gente (só à conta global), nunca a mais.
--
-- Idempotente: o backfill deriva sempre de `perfis`, nunca de um valor
-- inventado — rodar de novo só recalcula o mesmo resultado, ao contrário do
-- `sem_limite_diario` que apagava escolha feita depois da primeira execução.
-- ============================================================================

alter table logs_auditoria
  add column if not exists empresa_id uuid references empresas (id) on delete set null;

update logs_auditoria l
   set empresa_id = p.empresa_id
  from perfis p
 where p.id = l.usuario_id
   and l.usuario_id is not null
   and l.empresa_id is distinct from p.empresa_id;

create index if not exists logs_auditoria_empresa_idx on logs_auditoria (empresa_id);
