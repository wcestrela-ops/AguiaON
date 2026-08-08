-- Migração para Módulo Financeiro Triple-Play
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS asaas_api_key TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS asaas_wallet_id TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS pix_key_type TEXT; -- email, cpf, cnpj, phone, random
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS pix_key_value TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS pix_receiver_name TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS preferred_payment_method TEXT DEFAULT 'manual_pix'; -- mp, asaas, manual_pix
