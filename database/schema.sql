-- =============================================
-- AG-ON SAAS CORE - Schema Completo do Banco
-- =============================================

-- Extensão para geração de UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================
-- ESTABELECIMENTOS (lojistas/clientes do SaaS)
-- =============================================
CREATE TABLE IF NOT EXISTS establishments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    description     TEXT,
    category        TEXT,
    logo_url        TEXT,
    cover_url       TEXT,
    city            TEXT,
    state           TEXT,
    phone           TEXT,
    address         TEXT,
    whatsapp_link   TEXT,
    instagram_url   TEXT,
    module_id       UUID,                               -- módulo principal (FK adicionada abaixo)
    owner_whatsapp  TEXT,                               -- WhatsApp do lojista (usado no login)
    owner_email     TEXT,                               -- Email do lojista (recebe OTP)
    password_hash   TEXT,                               -- senha do lojista
    plan            TEXT NOT NULL DEFAULT 'FREE',       -- FREE | PRO | PREMIUM
    
    -- Configurações Dinâmicas (Nicho e Customizações)
    setup_done      BOOLEAN NOT NULL DEFAULT false,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    is_public       BOOLEAN NOT NULL DEFAULT true,      -- aparece na vitrine pública
    active_features JSONB NOT NULL DEFAULT '[]'::jsonb,
    business_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    cor_primaria    TEXT,
    cor_destaque    TEXT,
    vertical_slug   TEXT NOT NULL DEFAULT 'generico',
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
    niche_data      JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FK adicionada após criação de modules para evitar dependência circular
-- ALTER TABLE establishments ADD CONSTRAINT fk_est_module FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE SET NULL;


-- =============================================
-- SOLICITAÇÕES DE PARCERIA (lojistas querendo entrar)
-- =============================================
CREATE TABLE IF NOT EXISTS partner_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name   TEXT NOT NULL,
    owner_name      TEXT NOT NULL,
    email           TEXT NOT NULL,
    whatsapp        TEXT NOT NULL,
    city            TEXT,
    state           TEXT,
    module_id       UUID,                               -- módulo de interesse
    vertical_slug   TEXT,                               -- segmento de interesse
    message         TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING | APPROVED | REJECTED
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =============================================
-- USUÁRIOS (clientes finais dos lojistas)
-- =============================================
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp            TEXT UNIQUE,                    -- pode ser NULL se entrou só por email
    full_name           TEXT,
    email               TEXT UNIQUE,
    password_hash       TEXT,                           -- NULL = primeiro acesso (usar forgot-password)
    is_confirmed        BOOLEAN NOT NULL DEFAULT true,  -- false até confirmar código de cadastro
    auth_level          TEXT NOT NULL DEFAULT 'LEAD',   -- LEAD | REGISTERED | ADMIN | LOJISTA | SUPERADMIN
    establishment_id    UUID REFERENCES establishments(id) ON DELETE SET NULL,
    employee_role       TEXT,                           -- ex: 'Instrutor', 'Barbeiro' se atrelado a um lojista
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_whatsapp ON users(whatsapp);
CREATE INDEX IF NOT EXISTS idx_users_establishment ON users(establishment_id);


-- =============================================
-- CONFIGURAÇÕES GLOBAIS (chaves de API, infra)
-- =============================================
CREATE TABLE IF NOT EXISTS global_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'GENERAL',  -- GENERAL | AI | PAYMENT | WHATSAPP
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Valores padrão para o painel funcionar já na primeira abertura
INSERT INTO global_settings (key, value, category) VALUES
    ('mp_public_key',        '', 'PAYMENT'),
    ('mp_access_token',      '', 'PAYMENT'),
    ('platform_fee_percent', '0', 'PAYMENT'),
    ('asaas_api_key',        '', 'PAYMENT'),
    ('asaas_wallet_id',      '', 'PAYMENT'),
    ('bank_details',         '', 'PAYMENT'),
    ('ai_gemini_key',        '', 'AI'),
    ('ai_openai_key',        '', 'AI'),
    ('ai_groq_key',          '', 'AI'),
    ('ai_atmos_key',         '', 'AI'),
    ('ai_local_url',         '', 'AI'),
    ('agata_system_prompt',  '', 'AI'),
    ('evolution_url',        '', 'WHATSAPP'),
    ('evolution_token',      '', 'WHATSAPP'),
    ('smtp_host',            '', 'GENERAL'),
    ('smtp_user',            '', 'GENERAL'),
    ('smtp_pass',            '', 'GENERAL'),
    ('smtp_from',            '', 'GENERAL'),
    ('pwa_name',             'AG-ON', 'GENERAL'),
    ('pwa_theme_color',      '#6366f1', 'GENERAL'),
    ('mp_client_id',         '', 'PAYMENT')
ON CONFLICT (key) DO NOTHING;


-- =============================================
-- PERSONALIDADE DA ÁGATA (DNA da IA)
-- =============================================
CREATE TABLE IF NOT EXISTS agata_personality (
    id                  UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001',
    name                TEXT NOT NULL DEFAULT 'Ágata',
    mood                TEXT NOT NULL DEFAULT 'Amigável',
    forbidden_topics    TEXT NOT NULL DEFAULT '',
    photo_url           TEXT,
    plus_price          NUMERIC(10,2) DEFAULT 0,
    plus_trial_days     INTEGER DEFAULT 7,
    plus_prompt         TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garante que o registro padrão existe
INSERT INTO agata_personality (id, name, mood, forbidden_topics)
VALUES ('00000000-0000-0000-0000-000000000001', 'Ágata', 'Amigável', '')
ON CONFLICT (id) DO NOTHING;


-- =============================================
-- PROVEDORES DE IA (qual motor está ativo)
-- =============================================
CREATE TABLE IF NOT EXISTS ai_providers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_name   TEXT NOT NULL,   -- openai | groq | gemini | local
    api_key         TEXT NOT NULL DEFAULT '',
    api_url         TEXT NOT NULL DEFAULT '',
    model_name      TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =============================================
-- FERRAMENTAS DA IA (whitelist de ações)
-- =============================================
CREATE TABLE IF NOT EXISTS ai_tools (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT UNIQUE NOT NULL,   -- create_appointment, send_message, etc.
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ferramenta padrão para testes
INSERT INTO ai_tools (name, description, is_active) VALUES
    ('create_appointment', 'Cria um agendamento para o usuário', true)
ON CONFLICT (name) DO NOTHING;


-- =============================================
-- LOGS DE AÇÕES DA IA (conversas e execuções)
-- =============================================
CREATE TABLE IF NOT EXISTS ai_action_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    user_name       TEXT,
    tool_name       TEXT,
    prompt_used     TEXT,
    response_text   TEXT,
    params          JSONB,
    status          TEXT NOT NULL DEFAULT 'SUCCESS',   -- SUCCESS | ERROR
    response_data   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_logs_created ON ai_action_logs(created_at DESC);


-- =============================================
-- TABELA DE SEGMENTOS MODULARES
-- =============================================
CREATE TABLE IF NOT EXISTS segments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_slug         TEXT NOT NULL,
    module_label        TEXT NOT NULL,
    module_icon         TEXT NOT NULL DEFAULT '📦',
    slug                TEXT NOT NULL UNIQUE,
    label               TEXT NOT NULL,
    descricao           TEXT,
    icon                TEXT NOT NULL DEFAULT '⚙️',
    cor_primaria        TEXT NOT NULL DEFAULT '#0f172a',
    cor_destaque        TEXT NOT NULL DEFAULT '#6366f1',
    features            JSONB NOT NULL DEFAULT '[]'::jsonb,
    servicos_padrao     JSONB NOT NULL DEFAULT '[]'::jsonb,
    tipos_profissionais JSONB NOT NULL DEFAULT '[]'::jsonb,
    business_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    ativo               BOOLEAN NOT NULL DEFAULT true,
    ordem               INTEGER DEFAULT 0,
    plano_1             JSONB NOT NULL DEFAULT '{"nome": "Básico", "preco": 49.90, "trial_days": 15}'::jsonb,
    plano_2             JSONB NOT NULL DEFAULT '{"nome": "Pro", "preco": 99.90, "trial_days": 15}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================
-- SERVIÇOS (Agendamentos e Planos Base do Lojista)
-- =============================================
CREATE TABLE IF NOT EXISTS agenda_servicos (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    nome                TEXT NOT NULL,
    descricao           TEXT,
    categoria           TEXT,
    duracao_minutos     INTEGER NOT NULL DEFAULT 30,
    preco               NUMERIC(10,2) NOT NULL DEFAULT 0,
    comissao_percentual NUMERIC(5,2),
    ordem               INTEGER DEFAULT 0,
    ativo               BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =============================================
-- LOGS DE AUDITORIA DO ADMIN
-- =============================================
CREATE TABLE IF NOT EXISTS system_audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action      TEXT NOT NULL,    -- UPDATE_SETTING | ADD_MODULE | etc.
    target      TEXT,
    old_value   TEXT,
    new_value   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON system_audit_logs(created_at DESC);


-- =============================================
-- MÓDULOS / APP STORE
-- =============================================
CREATE TABLE IF NOT EXISTS modules (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    slug             TEXT UNIQUE NOT NULL,
    config_url       TEXT NOT NULL,
    admin_url        TEXT,                               -- URL interna para SuperAdmin (abre em nova aba)
    profissional_url TEXT,                               -- URL para app de profissionais
    icon             TEXT NOT NULL DEFAULT 'fa-puzzle-piece',
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =============================================
-- ACESSO DE USUÁRIOS AOS MÓDULOS
-- =============================================
CREATE TABLE IF NOT EXISTS user_modules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_id       UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,                        -- NULL = acesso permanente
    is_active       BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (user_id, module_id)
);

CREATE INDEX IF NOT EXISTS idx_user_modules_user ON user_modules(user_id);


-- =============================================
-- HISTÓRICO DE TRANSAÇÕES / PAGAMENTOS
-- =============================================
CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    module_id       UUID REFERENCES modules(id) ON DELETE SET NULL,
    establishment_id UUID REFERENCES establishments(id) ON DELETE SET NULL,
    amount          NUMERIC(10, 2) NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'BRL',
    status          TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING | PAID | FAILED | REFUNDED
    description     TEXT,
    gateway         TEXT,                               -- mercadopago | asaas | pix | manual
    gateway_ref     TEXT,                               -- ID da transação no gateway
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);


-- =============================================
-- ANÚNCIOS (banners configurados pelo SuperAdmin)
-- =============================================
CREATE TABLE IF NOT EXISTS announcements (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    description TEXT,
    image_url   TEXT,
    link_url    TEXT,                                   -- link do produto/loja ao clicar
    is_active   BOOLEAN NOT NULL DEFAULT true,
    display_order INT NOT NULL DEFAULT 0,
    starts_at   TIMESTAMPTZ,                            -- NULL = sempre visível
    ends_at     TIMESTAMPTZ,                            -- NULL = sem expiração
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =============================================
-- CÓDIGOS OTP (verificação de identidade)
-- =============================================
CREATE TABLE IF NOT EXISTS otp_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- actor_id é TEXT para suportar UUID de users/establishments E 'superadmin'
    actor_id    TEXT NOT NULL,
    code        TEXT NOT NULL,
    purpose     TEXT NOT NULL DEFAULT 'PROFILE_EDIT',  -- PROFILE_EDIT | LOGIN | etc.
    used        BOOLEAN NOT NULL DEFAULT false,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_actor ON otp_codes(actor_id, used, expires_at);
