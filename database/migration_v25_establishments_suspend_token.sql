-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v25 — Colunas de suspensão/ativação/token da loja
-- (referência — o schema real é aplicado via a IIFE de migração no
--  topo de src/routes/admin.ts, mesmo padrão idempotente já usado
--  no resto do projeto)
--
-- Contexto: is_suspended, suspension_reason, suspended_at,
-- activated_until e store_token eram usadas em src/routes/admin.ts
-- (listagem de lojas, suspender/ativar loja, criar loja pelo painel,
-- seed de lojas demo) desde antes deste projeto, mas nenhuma tinha
-- CREATE/ALTER em lugar nenhum do código. Em banco novo isso quebra
-- GET /admin/establishments (erro "column is_suspended does not
-- exist") e POST /admin/establishments — ou seja, a lista de lojas
-- não carrega e criar loja nova falha.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE establishments ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS activated_until DATE;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS store_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_establishments_store_token
  ON establishments(store_token) WHERE store_token IS NOT NULL;
