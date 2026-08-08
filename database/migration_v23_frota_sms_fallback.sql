-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v23 — Fallback SMS pros comandos de rastreamento
-- (referência — o schema real é aplicado via ensureTables() em
--  src/routes/agenda/index.ts)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE agenda_frota ADD COLUMN IF NOT EXISTS tracker_phone TEXT;

ALTER TABLE agenda_frota_commands
  ADD COLUMN IF NOT EXISTS channel  TEXT NOT NULL DEFAULT '4g' CHECK (channel IN ('4g','sms')),
  ADD COLUMN IF NOT EXISTS failover BOOLEAN NOT NULL DEFAULT false;
