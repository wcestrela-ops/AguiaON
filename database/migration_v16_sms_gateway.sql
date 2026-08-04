-- Migração: Gateway de SMS (plataforma compartilhada + override por lojista)
-- Mesmo padrão de whatsapp_configs/evolution: cada provider pode ser
-- compartilhado (establishment_id NULL) ou próprio de um lojista (SHARED vs OWN).
-- Nota: o módulo src/shared/smsSender.ts também cria essas tabelas de forma
-- idempotente em runtime (CREATE TABLE IF NOT EXISTS), então rodar este
-- arquivo manualmente é opcional — serve como referência/documentação.

CREATE TABLE IF NOT EXISTS sms_providers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID REFERENCES establishments(id) ON DELETE CASCADE, -- NULL = compartilhado (plataforma)
    provider            TEXT NOT NULL,          -- fake | android | http_gateway | smsmarket
    label               TEXT,
    config              JSONB NOT NULL DEFAULT '{}', -- campos do provider; segredos já vêm criptografados
    is_primary          BOOLEAN NOT NULL DEFAULT false,
    priority            INTEGER NOT NULL DEFAULT 100,  -- menor = tentado primeiro na cadeia de failover
    status              TEXT NOT NULL DEFAULT 'unknown', -- connected | error | unknown
    active              BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_providers_est ON sms_providers(establishment_id);
CREATE INDEX IF NOT EXISTS idx_sms_providers_priority ON sms_providers(establishment_id, priority);

CREATE TABLE IF NOT EXISTS sms_dispatches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID REFERENCES establishments(id) ON DELETE CASCADE,
    provider_id         UUID REFERENCES sms_providers(id) ON DELETE SET NULL,
    provider_type       TEXT,
    phone               TEXT NOT NULL,
    message             TEXT NOT NULL,
    action              TEXT DEFAULT 'notification', -- notification | billing.reminder | vehicle.alert | tracker.command
    status              TEXT NOT NULL DEFAULT 'processing', -- queued | processing | sent | failed
    external_id         TEXT,
    error_message       TEXT,
    used_failover       BOOLEAN NOT NULL DEFAULT false,
    idempotency_key     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_dispatch_idem ON sms_dispatches(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_dispatch_est ON sms_dispatches(establishment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_logs (
    id                  SERIAL PRIMARY KEY,
    provider_id         UUID REFERENCES sms_providers(id) ON DELETE SET NULL,
    provider_type       TEXT,
    action              TEXT,
    recipient           TEXT,
    success             BOOLEAN NOT NULL,
    response_time_ms    INTEGER,
    error_message       TEXT,
    used_failover       BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_logs_created ON sms_logs(created_at DESC);
