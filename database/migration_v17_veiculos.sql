-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v17 — Rastreamento veicular (primeira fatia: veículos + GPSWOX)
-- ─────────────────────────────────────────────────────────────────────────────
-- Cada empresa (establishment) traz a própria conta GPSWOX (decisão: federado,
-- não compartilhado — diferente do SMS/WhatsApp que são SHARED por padrão).
-- Nota: src/shared/gpswoxClient.ts também cria essas tabelas de forma
-- idempotente em runtime; rodar este arquivo manualmente é opcional.

-- 1. Credenciais GPSWOX por estabelecimento (uma conta por empresa)
CREATE TABLE IF NOT EXISTS gpswox_configs (
    establishment_id    UUID PRIMARY KEY REFERENCES establishments(id) ON DELETE CASCADE,
    url                 TEXT,
    api_hash            TEXT,   -- criptografado (cryptoUtil.encrypt) antes de salvar
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Veículos
CREATE TABLE IF NOT EXISTS vehicles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL, -- cliente dono (opcional, pode ficar sem vínculo)
    plate               TEXT,          -- opcional (veículo novo sem emplacamento)
    brand               TEXT,
    model               TEXT,
    color               TEXT,
    gpswox_device_id    TEXT,          -- id do dispositivo no GPSWOX da empresa (sync manual por enquanto)
    status              TEXT NOT NULL DEFAULT 'pending_installation'
                          CHECK (status IN ('pending_installation','active','inactive')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_establishment ON vehicles(establishment_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id);
