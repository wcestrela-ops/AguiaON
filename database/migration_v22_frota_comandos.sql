-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v22 — Módulo Rastreamento: comandos, histórico e
-- compartilhamento (Fase 8)
-- (referência — o schema real é aplicado via ensureTables() em
--  src/routes/agenda/index.ts, mesmo padrão idempotente das demais
--  tabelas do módulo agenda)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agenda_frota_commands (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
  establishment_id  UUID NOT NULL,
  action            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agenda_frota_shares (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
  establishment_id  UUID NOT NULL,
  link              TEXT,
  duration_minutes  INTEGER NOT NULL DEFAULT 60,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_frota_commands_veiculo ON agenda_frota_commands(agenda_frota_id);
CREATE INDEX IF NOT EXISTS idx_frota_shares_veiculo ON agenda_frota_shares(agenda_frota_id);
