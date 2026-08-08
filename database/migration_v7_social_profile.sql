-- Migração para Perfil Social e Redes
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS facebook_url TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS website_url TEXT;
-- logo_url, instagram_url e whatsapp_link já existem no schema base
