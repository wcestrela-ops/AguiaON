-- =========================================================================
-- SCRIPT DE MIGRAÇÃO: CATÁLOGO UNIVERSAL (RODAR NO GERENCIADOR SQL WEB)
-- =========================================================================

-- 1. Criação da Tabela de Categorias
CREATE TABLE IF NOT EXISTS categories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    active              BOOLEAN DEFAULT true,
    sort_order          INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Criação da Tabela de Produtos (Catálogo Universal)
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

-- 3. Criação de Índices para Performance
CREATE INDEX IF NOT EXISTS idx_categories_establishment ON categories(establishment_id);
CREATE INDEX IF NOT EXISTS idx_products_establishment ON products(establishment_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);

-- =========================================================================
-- SCRIPT DE VERIFICAÇÃO (PARA VOCÊ ME ENVIAR O RESULTADO DE VOLTA)
-- =========================================================================
-- Cole o código abaixo para ver se as tabelas foram criadas corretamente:

SELECT table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name IN ('establishments', 'categories', 'products') 
ORDER BY table_name, ordinal_position;
