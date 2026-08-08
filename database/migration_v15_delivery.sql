-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v15 — Segmento Restaurante / Delivery
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Configurações de entrega no estabelecimento
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS delivery_tax         NUMERIC(10,2) DEFAULT 0;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS free_delivery_over   NUMERIC(10,2) DEFAULT 0;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS estimated_time       TEXT          DEFAULT '30-45 min';
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS delivery_type        TEXT          DEFAULT 'both'
    CHECK (delivery_type IN ('delivery','pickup','both'));
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS min_order            NUMERIC(10,2) DEFAULT 0;

-- 2. Zonas de entrega por bairro/região
CREATE TABLE IF NOT EXISTS delivery_zones (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,        -- ex: "Centro", "Zona Sul"
    delivery_tax     NUMERIC(10,2) NOT NULL DEFAULT 0,
    estimated_time   TEXT,                 -- ex: "20-30 min"
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_zones_est ON delivery_zones(establishment_id);

-- 3. Opcionais / Grupos de complementos (vinculados ao produto)
CREATE TABLE IF NOT EXISTS product_options (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,          -- ex: "Escolha a carne", "Adicionais"
    min_options INTEGER NOT NULL DEFAULT 0,
    max_options INTEGER NOT NULL DEFAULT 1,
    is_required BOOLEAN NOT NULL DEFAULT false,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_options_product ON product_options(product_id);

-- 4. Itens dentro de cada grupo de opcional
CREATE TABLE IF NOT EXISTS product_option_items (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    option_id        UUID NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,             -- ex: "Bem passada", "Bacon extra"
    additional_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    order_index      INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_option_items_option ON product_option_items(option_id);

-- 5. Pedidos de delivery
CREATE TABLE IF NOT EXISTS delivery_orders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    customer_name    TEXT NOT NULL,
    customer_phone   TEXT,
    customer_address TEXT,
    delivery_type    TEXT NOT NULL DEFAULT 'delivery' CHECK (delivery_type IN ('delivery','pickup')),
    items            JSONB NOT NULL DEFAULT '[]',   -- snapshot dos itens + opcionais
    subtotal         NUMERIC(10,2) NOT NULL DEFAULT 0,
    delivery_tax     NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount         NUMERIC(10,2) NOT NULL DEFAULT 0,
    total            NUMERIC(10,2) NOT NULL DEFAULT 0,
    notes            TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','preparing','delivering','delivered','cancelled')),
    zone_id          UUID REFERENCES delivery_zones(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_est    ON delivery_orders(establishment_id);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_status ON delivery_orders(status);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_date   ON delivery_orders(created_at DESC);

-- 6. Segmento no banco de dados
INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
('delivery', 'Delivery', '🛵', 'delivery', 'Restaurante / Delivery',
 'Cardápio digital com complementos, pedidos online e gestão de entregas', '🍔',
 '#1a0800', '#f97316',
 '["cardapio","pedidos","vendas"]',
 '[]',
 '["Atendente","Entregador","Cozinheiro","Gerente"]',
 '{
   "delivery_tax":5.00,
   "free_delivery_over":50.00,
   "estimated_time":"30-45 min",
   "delivery_type":"both",
   "min_order":20.00,
   "agata_knowledge":"Sou um restaurante com delivery. Atendo pedidos online e presencial. Tenho cardápio com diversas opções e entrego na região.",
   "agata_mood":"Simpática, ágil e focada em confirmar pedidos rapidamente. Sempre confirma os itens, o endereço e o tempo estimado de entrega."
 }',
 1)
ON CONFLICT (slug) DO UPDATE SET
  label           = EXCLUDED.label,
  descricao       = EXCLUDED.descricao,
  features        = EXCLUDED.features,
  business_config = EXCLUDED.business_config,
  ativo           = true;
