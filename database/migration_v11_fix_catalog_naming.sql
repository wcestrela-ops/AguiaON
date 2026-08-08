-- Correção de nomenclatura: store_id -> establishment_id
-- Para manter consistência com o restante do sistema

DO $$ 
BEGIN
    -- Categorias
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='categories' AND column_name='store_id') THEN
        ALTER TABLE categories RENAME COLUMN store_id TO establishment_id;
    END IF;

    -- Produtos
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='store_id') THEN
        ALTER TABLE products RENAME COLUMN store_id TO establishment_id;
    END IF;
END $$;

-- Garantir que as tabelas existem com o nome correto caso a migração v10 ainda não tenha rodado totalmente
CREATE TABLE IF NOT EXISTS categories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    active              BOOLEAN DEFAULT true,
    sort_order          INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    price               NUMERIC(10,2) NOT NULL DEFAULT 0,
    type                TEXT NOT NULL CHECK (type IN ('product', 'service', 'plan')),
    image_base64        TEXT,
    settings            JSONB NOT NULL DEFAULT '{}'::jsonb,
    active              BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_establishment ON categories(establishment_id);
CREATE INDEX IF NOT EXISTS idx_products_establishment ON products(establishment_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
