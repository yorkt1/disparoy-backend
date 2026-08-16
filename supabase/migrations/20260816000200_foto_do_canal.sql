-- ============================================================================
-- Foto de perfil do canal.
--
-- Com vários números conectados, a lista mostrava o mesmo ícone genérico de QR
-- Code para todos — e "de qual WhatsApp estou disparando?" virava uma pergunta
-- respondida lendo o número dígito a dígito. A foto responde de relance.
--
-- Guardamos a IMAGEM, não o link do WhatsApp.
--
-- A URL que a Evolution devolve (`pps.whatsapp.net/...`) é temporária: expira
-- sozinha em algum momento, e a tela passaria a mostrar imagem quebrada sem
-- nada ter acontecido. É o mesmo tipo de mentira silenciosa que o `status` de
-- canal produzia — guardar o arquivo é o que torna o dado estável.
--
-- Idempotente.
-- ============================================================================

alter table canais
  -- URL pública no nosso Storage, não a do WhatsApp.
  add column if not exists foto_url text,
  -- Quando foi baixada. Permite reatualizar depois sem depender de adivinhar.
  add column if not exists foto_em timestamptz;
