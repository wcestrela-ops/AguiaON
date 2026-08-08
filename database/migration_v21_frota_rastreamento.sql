-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v21 — Módulo Rastreamento: sync GPSWOX + cobrança
-- (referência — o schema real é aplicado via ensureTables() em
--  src/routes/agenda/index.ts, mesmo padrão idempotente das demais
--  tabelas do módulo agenda; este arquivo documenta e serve para o
--  deploy_bootstrap.sql)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE agenda_frota
  ADD COLUMN IF NOT EXISTS gpswox_device_id   TEXT,
  ADD COLUMN IF NOT EXISTS tracker_model       TEXT,
  ADD COLUMN IF NOT EXISTS tracker_synced_at   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agenda_frota_charges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
  establishment_id  UUID NOT NULL,
  competencia       TEXT NOT NULL,
  valor             NUMERIC(10,2) NOT NULL,
  pix_code          TEXT,
  pix_provider      TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agenda_frota_id, competencia)
);

CREATE INDEX IF NOT EXISTS idx_frota_charges_estab ON agenda_frota_charges(establishment_id);
CREATE INDEX IF NOT EXISTS idx_frota_gpswox_device ON agenda_frota(gpswox_device_id);
