-- Migração para Módulo de Catálogo Universal

CREATE TABLE IF NOT EXISTS categories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    order_index         INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    type                TEXT NOT NULL DEFAULT 'product', -- 'product', 'service', 'plan'
    name                TEXT NOT NULL,
    description         TEXT,
    price               NUMERIC(10,2) NOT NULL DEFAULT 0,
    image_base64        TEXT, -- Imagem otimizada WebP
    is_active           BOOLEAN DEFAULT true,
    
    -- Específico para Planos
    recurrence          TEXT, -- 'weekly', 'monthly', 'yearly'
    billing_period      INTEGER,
    
    -- Específico para Serviços
    duration_minutes    INTEGER,
    
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cat_est ON categories(establishment_id);
CREATE INDEX IF NOT EXISTS idx_cat_items_est ON catalog_items(establishment_id);
CREATE INDEX IF NOT EXISTS idx_cat_items_cat ON catalog_items(category_id);
