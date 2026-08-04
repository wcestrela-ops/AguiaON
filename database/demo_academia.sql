-- ==============================================================================
-- SCRIPT DEMO: ACADEMIA & USUÁRIO
-- Rode este arquivo no seu banco de dados PostgreSQL
-- ==============================================================================

-- 0) GARANTIR QUE AS TABELAS E COLUNAS EXISTEM ANTES DE INSERIR
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS whatsapp_link TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS setup_done BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS active_features JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS business_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_primaria TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_destaque TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS vertical_slug TEXT NOT NULL DEFAULT 'generico';
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS niche_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_slug TEXT NOT NULL, module_label TEXT NOT NULL, module_icon TEXT NOT NULL DEFAULT '📦',
    slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, descricao TEXT, icon TEXT NOT NULL DEFAULT '⚙️',
    cor_primaria TEXT NOT NULL DEFAULT '#0f172a', cor_destaque TEXT NOT NULL DEFAULT '#6366f1',
    features JSONB NOT NULL DEFAULT '[]', servicos_padrao JSONB NOT NULL DEFAULT '[]',
    tipos_profissionais JSONB NOT NULL DEFAULT '[]', business_config JSONB NOT NULL DEFAULT '{}',
    ativo BOOLEAN NOT NULL DEFAULT true, ordem INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    plano_1 JSONB NOT NULL DEFAULT '{"nome": "Básico", "preco": 49.90, "trial_days": 15}',
    plano_2 JSONB NOT NULL DEFAULT '{"nome": "Pro", "preco": 99.90, "trial_days": 15}'
);

CREATE TABLE IF NOT EXISTS agenda_servicos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id UUID NOT NULL,
    nome TEXT NOT NULL, descricao TEXT, categoria TEXT,
    duracao_minutos INTEGER NOT NULL DEFAULT 30,
    preco NUMERIC(10,2) NOT NULL DEFAULT 0,
    comissao_percentual NUMERIC(5,2), ordem INTEGER DEFAULT 0,
    ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1) Garantir que o segmento "academia" existe na tabela 'segments'
INSERT INTO segments (
    id, module_slug, module_label, module_icon, slug, label, descricao, icon, 
    cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, 
    business_config, ativo, ordem, plano_1, plano_2
) VALUES (
    '11111111-1111-1111-1111-111111111111', 
    'agendamento', 'Agendamento e Planos', '📅', 
    'academia', 'Academia', 'Planos de mensalidade, musculação, crossfit, etc.', '🏋️', 
    '#0f172a', '#ef4444', 
    '["agenda", "profissionais", "servicos", "produtos", "vendas"]'::jsonb, 
    '[{"nome": "Plano Mensal - Musculação", "categoria": "Planos", "duracao_minutos": 0, "preco": 120, "ordem": 1}, 
      {"nome": "Plano Trimestral", "categoria": "Planos", "duracao_minutos": 0, "preco": 300, "ordem": 2}]'::jsonb, 
    '["Instrutor", "Personal Trainer", "Recepcionista"]'::jsonb, 
    '{"aceita_agendamento": true}'::jsonb, 
    true, 
    1, 
    '{"nome": "Básico", "preco": 49.90, "trial_days": 15}'::jsonb, 
    '{"nome": "Pro", "preco": 99.90, "trial_days": 15}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

-- 2) Criar o estabelecimento (Academia Demo)
-- ATENÇÃO: As colunas settings e niche_data foram recém injetadas na estrutura e vão carregar os dados específicos!
INSERT INTO establishments (
    id, name, slug, city, vertical_slug, setup_done, is_active, is_public, 
    active_features, business_config, cor_primaria, cor_destaque, 
    settings, niche_data
) VALUES (
    '22222222-2222-2222-2222-222222222222', 
    'Academia Corpo & Vida (DEMO)', 
    'academia-demo', 
    'São Paulo', 
    'academia', 
    true, true, true, 
    '["agenda", "profissionais", "servicos", "produtos", "vendas"]'::jsonb, 
    '{"aceita_agendamento": true}'::jsonb, 
    '#0f172a', '#ef4444', 
    '{
      "theme": {"primary_color": "#ef4444"},
      "finance": {"gateway": "asaas", "pix_key": "11988887777"},
      "contact": {"whatsapp": "11988887777", "email": "contato@academiademo.com"},
      "business_hours": {
        "1": {"active": true, "start": "06:00", "end": "22:00"},
        "2": {"active": true, "start": "06:00", "end": "22:00"},
        "3": {"active": true, "start": "06:00", "end": "22:00"},
        "4": {"active": true, "start": "06:00", "end": "22:00"},
        "5": {"active": true, "start": "06:00", "end": "22:00"},
        "6": {"active": true, "start": "08:00", "end": "14:00"},
        "0": {"active": false, "start": "08:00", "end": "18:00"}
      },
      "is_open": true
    }'::jsonb,
    '{
      "registration_fee": 99.90,
      "requires_evaluation": true,
      "cancellation_penalty": 15
    }'::jsonb
) ON CONFLICT (slug) DO NOTHING;

-- 3) Criar o usuário Lojista
-- O password_hash foi gerado com bcrypt.hash('123456', 10)
INSERT INTO users (
    id, full_name, whatsapp, email, password_hash, auth_level, establishment_id, is_confirmed
) VALUES (
    '33333333-3333-3333-3333-333333333333', 
    'João Academia', 
    '11988887777', 
    'admin@academiademo.com', 
    '$2a$10$P2N58LqjIq.vM4QJ6O1DceC7/JzUqH8X8O3WqS6l6X1LwK6zN5FqG', 
    'LOJISTA', 
    '22222222-2222-2222-2222-222222222222', 
    true
) ON CONFLICT (whatsapp) DO NOTHING;

-- 4) Criar uns serviços básicos (Planos) para a Academia
DELETE FROM agenda_servicos WHERE establishment_id = '22222222-2222-2222-2222-222222222222';
INSERT INTO agenda_servicos (establishment_id, nome, categoria, duracao_minutos, preco, ordem, ativo)
VALUES 
    ('22222222-2222-2222-2222-222222222222', 'Plano Mensal - Musculação', 'Planos', 0, 120.00, 1, true),
    ('22222222-2222-2222-2222-222222222222', 'Plano Trimestral', 'Planos', 0, 300.00, 2, true),
    ('22222222-2222-2222-2222-222222222222', 'Avaliação Física', 'Serviços Extras', 30, 80.00, 3, true);

-- FIM! 
-- Acesse a tela de Login do Águia-ON com:
-- WhatsApp: 11988887777 ou E-mail: admin@academiademo.com
-- Senha:  123456