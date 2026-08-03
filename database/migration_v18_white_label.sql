-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v18 — White-label por empresa (domínio customizado)
-- ─────────────────────────────────────────────────────────────────────────────
-- Subdomínio (slug.PLATFORM_BASE_DOMAIN) já funciona sem coluna nova, via
-- establishments.slug existente. Esta migration só adiciona o suporte a
-- domínio 100% próprio da empresa (ex: www.loja1.com.br).

ALTER TABLE establishments ADD COLUMN IF NOT EXISTS custom_domain TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_establishments_custom_domain
  ON establishments(custom_domain) WHERE custom_domain IS NOT NULL;
