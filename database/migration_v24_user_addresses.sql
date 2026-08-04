-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v24 — Tabela user_addresses (fix de bug de produção)
-- (referência — o schema real é aplicado via a IIFE de migração no
--  topo de src/routes/delivery.ts, mesmo padrão idempotente de
--  CREATE TABLE IF NOT EXISTS já usado no resto do projeto)
--
-- Contexto: user_addresses era referenciada em delivery.ts e client.ts
-- (SELECT/INSERT/UPDATE/DELETE de endereços salvos do cliente final)
-- desde antes deste projeto, mas nunca teve um CREATE TABLE em lugar
-- nenhum do código — presumivelmente existia manualmente no banco
-- antigo. Em um banco novo isso derruba o boot do módulo de delivery
-- inteiro com "relation user_addresses does not exist".
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_addresses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'Casa',
  address       TEXT,
  street        TEXT,
  number        TEXT,
  neighborhood  TEXT,
  city          TEXT,
  reference     TEXT,
  lat           DECIMAL(10,7),
  lng           DECIMAL(10,7),
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, label)
);

CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);
