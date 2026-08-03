-- =============================================
-- MIGRATION v2 — Sistema de senhas
-- Execute este script UMA VEZ no banco existente
-- =============================================

-- Usuários: senha + confirmação + email único + whatsapp opcional
ALTER TABLE users
  ALTER COLUMN whatsapp DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash  TEXT,
  ADD COLUMN IF NOT EXISTS is_confirmed   BOOLEAN NOT NULL DEFAULT true;

-- Garante unicidade de email (ignorando NULLs — PostgreSQL trata NULL como distinto)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'users' AND indexname = 'idx_users_email_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_users_email_unique ON users(email) WHERE email IS NOT NULL;
  END IF;
END$$;

-- Estabelecimentos: senha do lojista
ALTER TABLE establishments
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Índice parcial para email único nos usuários
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(email) WHERE email IS NOT NULL;

-- Módulos: URL administrativa interna (abre em nova aba para o SuperAdmin)
ALTER TABLE modules ADD COLUMN IF NOT EXISTS admin_url TEXT;
