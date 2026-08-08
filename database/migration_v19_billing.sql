-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v19 — Billing da plataforma (Fase 5)
-- ─────────────────────────────────────────────────────────────────────────────
-- O que a EMPRESA paga a VOCÊS pra usar o AguiaON. Não confundir com
-- gym_subscriptions/products (o que o CLIENTE FINAL paga à empresa) nem com
-- pixService.ts (cobrança gerada na conta da própria empresa).
--
-- Criada também de forma idempotente em runtime por src/shared/platformBilling.ts
-- (ensureTables), seguindo o mesmo padrão do smsSender.ts/gpswoxClient.ts — este
-- arquivo existe como referência/aplicação manual.

CREATE TABLE IF NOT EXISTS platform_plans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  price               NUMERIC(10,2) NOT NULL DEFAULT 0,
  billing_cycle_days  INTEGER NOT NULL DEFAULT 30,
  limits              JSONB NOT NULL DEFAULT '{}'::jsonb,  -- ex: {"max_vehicles": 5, "max_products": 20}
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE establishments ADD COLUMN IF NOT EXISTS platform_plan_id UUID REFERENCES platform_plans(id);
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'active'; -- active | warning | blocked
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS billing_warning_since TIMESTAMPTZ;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS current_period_ends_at DATE;

CREATE TABLE IF NOT EXISTS platform_invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  plan_id             UUID REFERENCES platform_plans(id),
  amount              NUMERIC(10,2) NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | paid | cancelled
  provider            TEXT,       -- asaas | manual | none
  pix_code            TEXT,
  due_date            DATE,
  paid_at             TIMESTAMPTZ,
  period_start        DATE,
  period_end          DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_invoices_est_status ON platform_invoices(establishment_id, status);
