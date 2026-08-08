-- Migração para Módulo de Catálogo Universal Refinado
-- Tabelas baseadas na lógica solicitada

-- 1. Tabela de Categorias
CREATE TABLE IF NOT EXISTS categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    active      BOOLEAN DEFAULT true,
    sort_order  INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabela de Produtos (Catalog Items)
CREATE TABLE IF NOT EXISTS products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    price           NUMERIC(10,2) NOT NULL DEFAULT 0,
    type            TEXT NOT NULL CHECK (type IN ('product', 'service', 'plan')),
    image_base64    TEXT, -- WebP/400px
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb, -- duration, recurrence, stock
    active          BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_store ON categories(store_id);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
