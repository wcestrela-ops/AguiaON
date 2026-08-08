-- Migração para Logo Otimizada e Social Links Consolidado
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS logo_base64 TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'::jsonb;

-- Comentário: Manteremos logo_url e as colunas sociais antigas por compatibilidade temporária, 
-- mas a prioridade de leitura será logo_base64 e social_links.
