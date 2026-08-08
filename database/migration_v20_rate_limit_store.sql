-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v20 — rate_limit_store
-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela usada por src/shared/rateLimitStore.ts (store do express-rate-limit
-- pros endpoints sensíveis de auth.ts). Nunca teve migration própria no
-- repositório — só existia manualmente no banco de produção original do
-- AG-ON-SAAS — o que quebrava login/OTP/etc. em qualquer banco novo com
-- "relation \"rate_limit_store\" does not exist". Também criada de forma
-- idempotente em runtime (init() do PostgresRateLimitStore); este arquivo é
-- só a referência/aplicação manual.

CREATE TABLE IF NOT EXISTS rate_limit_store (
  key       TEXT PRIMARY KEY,
  hits      INTEGER NOT NULL DEFAULT 0,
  reset_at  TIMESTAMPTZ NOT NULL
);
