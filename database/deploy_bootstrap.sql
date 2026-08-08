-- =========================================================================
-- AguiaON — Bootstrap completo do banco (schema.sql + migrations v2..v20)
-- Gerado automaticamente para aplicar tudo de uma vez num banco novo/vazio.
-- Todas as instruções são idempotentes (IF NOT EXISTS), então rodar de novo
-- num banco que já tem os dados não apaga nada.
-- =========================================================================

-- ─────────────────────────────────────────────────────────────
-- >>> schema.sql
-- ─────────────────────────────────────────────────────────────
-- =============================================
-- Águia-ON SAAS CORE - Schema Completo do Banco
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
-- Fix de produção 40 — ver nota equivalente em schema.sql.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));


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
    ('pwa_name',             'Águia-ON', 'GENERAL'),
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

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v2_passwords.sql
-- ─────────────────────────────────────────────────────────────
-- =============================================
-- MIGRATION v2 — Sistema de senhas
-- Execute este script UMA VEZ no banco existente
-- =============================================

-- Usuários: senha + confirmação + email único + whatsapp opcional
ALTER TABLE users
  ALTER COLUMN whatsapp DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash  TEXT,
  ADD COLUMN IF NOT EXISTS is_confirmed   BOOLEAN NOT NULL DEFAULT true;

-- Garante unicidade de email (ignorando NULLs — PostgreSQL trata NULL como distinto)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'users' AND indexname = 'idx_users_email_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_users_email_unique ON users(email) WHERE email IS NOT NULL;
  END IF;
END$$;

-- Estabelecimentos: senha do lojista
ALTER TABLE establishments
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Índice parcial para email único nos usuários
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(email) WHERE email IS NOT NULL;

-- Módulos: URL administrativa interna (abre em nova aba para o SuperAdmin)
ALTER TABLE modules ADD COLUMN IF NOT EXISTS admin_url TEXT;

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v3_agenda.sql
-- ─────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION V3 — Nichos / Verticais + Módulo Agenda Integrado
-- Rodar UMA vez no banco de produção
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. ATUALIZA TABELA DE ESTABELECIMENTOS ──────────────────
ALTER TABLE establishments
  ADD COLUMN IF NOT EXISTS vertical_slug      TEXT NOT NULL DEFAULT 'generico',
  ADD COLUMN IF NOT EXISTS active_features    JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS business_config    JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS setup_done         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cor_primaria       TEXT,
  ADD COLUMN IF NOT EXISTS cor_destaque       TEXT;

-- ─── 2. PROFISSIONAIS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_profissionais (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id),          -- se for usuário cadastrado
  nome              TEXT NOT NULL,
  especialidade     TEXT,
  tipo_contrato     TEXT DEFAULT 'CLT',                 -- CLT | Freelance | PJ
  email             TEXT,
  telefone          TEXT,
  foto_url          TEXT,
  comissao_percentual NUMERIC(5,2) DEFAULT 0,
  horario_trabalho  JSONB DEFAULT '{}',
  ativo             BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agenda_prof_estab ON agenda_profissionais(establishment_id);

-- ─── 3. SERVIÇOS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_servicos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  nome              TEXT NOT NULL,
  descricao         TEXT,
  categoria         TEXT,
  duracao_minutos   INTEGER NOT NULL DEFAULT 30,
  preco             NUMERIC(10,2) NOT NULL DEFAULT 0,
  comissao_percentual NUMERIC(5,2),                      -- override por serviço
  ordem             INTEGER DEFAULT 0,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agenda_serv_estab ON agenda_servicos(establishment_id);

-- ─── 4. AGENDAMENTOS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_agendamentos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  profissional_id   UUID REFERENCES agenda_profissionais(id),
  servico_id        UUID REFERENCES agenda_servicos(id),
  user_id           UUID REFERENCES users(id),           -- cliente cadastrado
  cliente_nome      TEXT NOT NULL,
  cliente_telefone  TEXT,
  cliente_email     TEXT,
  data              DATE NOT NULL,
  hora_inicio       TIME NOT NULL,
  hora_fim          TIME,
  status            TEXT NOT NULL DEFAULT 'pendente',    -- pendente | confirmado | concluido | cancelado | faltou
  observacoes       TEXT,
  valor_total       NUMERIC(10,2) DEFAULT 0,
  valor_pago        NUMERIC(10,2) DEFAULT 0,
  metodo_pagamento  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agenda_agend_estab ON agenda_agendamentos(establishment_id);
CREATE INDEX IF NOT EXISTS idx_agenda_agend_data  ON agenda_agendamentos(data);
CREATE INDEX IF NOT EXISTS idx_agenda_agend_status ON agenda_agendamentos(status);

-- ─── 5. BLOQUEIOS DE AGENDA ──────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_bloqueios (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  profissional_id   UUID REFERENCES agenda_profissionais(id),
  data_inicio       DATE NOT NULL,
  data_fim          DATE,
  hora_inicio       TIME,
  hora_fim          TIME,
  dia_inteiro       BOOLEAN NOT NULL DEFAULT false,
  motivo            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 6. PRODUTOS / ESTOQUE ───────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_produtos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  nome              TEXT NOT NULL,
  descricao         TEXT,
  categoria         TEXT,
  preco             NUMERIC(10,2) NOT NULL DEFAULT 0,
  custo             NUMERIC(10,2) DEFAULT 0,
  estoque           INTEGER DEFAULT 0,
  estoque_minimo    INTEGER DEFAULT 0,
  unidade           TEXT DEFAULT 'un',
  imagem_url        TEXT,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agenda_prod_estab ON agenda_produtos(establishment_id);

-- ─── 7. VENDAS / CAIXA ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_vendas (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  agendamento_id    UUID REFERENCES agenda_agendamentos(id),
  profissional_id   UUID REFERENCES agenda_profissionais(id),
  user_id           UUID REFERENCES users(id),
  cliente_nome      TEXT,
  itens             JSONB NOT NULL DEFAULT '[]',          -- [{tipo, id, nome, qtd, preco}]
  subtotal          NUMERIC(10,2) NOT NULL DEFAULT 0,
  desconto          NUMERIC(10,2) NOT NULL DEFAULT 0,
  total             NUMERIC(10,2) NOT NULL DEFAULT 0,
  comissao_calculada NUMERIC(10,2) DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pendente',    -- pendente | pago | cancelado
  metodo_pagamento  TEXT,
  observacoes       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agenda_vendas_estab ON agenda_vendas(establishment_id);

-- ─── 8. AVALIAÇÕES ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_avaliacoes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  agendamento_id    UUID REFERENCES agenda_agendamentos(id),
  profissional_id   UUID REFERENCES agenda_profissionais(id),
  user_id           UUID REFERENCES users(id),
  cliente_nome      TEXT,
  nota              SMALLINT NOT NULL CHECK (nota BETWEEN 1 AND 5),
  comentario        TEXT,
  aprovado          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 9. FROTA (nicho Rastreamento) ───────────────────────────
CREATE TABLE IF NOT EXISTS agenda_frota (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id),           -- proprietário do veículo
  cliente_nome      TEXT,
  cliente_telefone  TEXT,
  placa             TEXT,
  modelo            TEXT,
  ano               INTEGER,
  cor               TEXT,
  imei_rastreador   TEXT,
  data_instalacao   DATE,
  plano_id          UUID REFERENCES agenda_servicos(id),
  status            TEXT DEFAULT 'ativo',               -- ativo | inativo | inadimplente
  observacoes       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agenda_frota_estab ON agenda_frota(establishment_id);

-- ═══════════════════════════════════════════════════════════════
-- FIM DA MIGRATION V3
-- ═══════════════════════════════════════════════════════════════
-- ─────────────────────────────────────────────────────────────
-- >>> migration_v4_segments.sql
-- ─────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION V4 — Módulos & Segmentos via banco de dados
-- Substitui blueprints.ts por tabela gerenciável pelo admin
-- Rodar UMA vez no banco de produção
-- ═══════════════════════════════════════════════════════════════

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
  features            JSONB NOT NULL DEFAULT '[]',
  servicos_padrao     JSONB NOT NULL DEFAULT '[]',
  tipos_profissionais JSONB NOT NULL DEFAULT '[]',
  business_config     JSONB NOT NULL DEFAULT '{}',
  ativo               BOOLEAN NOT NULL DEFAULT true,
  ordem               INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segments_module ON segments(module_slug);
CREATE INDEX IF NOT EXISTS idx_segments_slug   ON segments(slug);

-- ─── MÓDULO: AGENDAMENTO ─────────────────────────────────────

INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
-- Barbearia
('agendamento', 'Agendamento', '📅', 'barbearia', 'Barbearia', 'Cortes, barba e estética masculina', '💈',
 '#1a1a1a', '#d4af37',
 '["agenda","profissionais","servicos","produtos","vendas","bloqueios","avaliacoes"]',
 '[
   {"nome":"Corte Masculino",    "categoria":"Cabelo",    "duracao_minutos":30,"preco":45.00,"ordem":1},
   {"nome":"Barba Completa",     "categoria":"Barba",     "duracao_minutos":30,"preco":35.00,"ordem":2},
   {"nome":"Combo Corte + Barba","categoria":"Combo",     "duracao_minutos":60,"preco":70.00,"ordem":3},
   {"nome":"Sobrancelha",        "categoria":"Estética",  "duracao_minutos":15,"preco":20.00,"ordem":4},
   {"nome":"Hidratação Capilar", "categoria":"Tratamento","duracao_minutos":30,"preco":30.00,"ordem":5}
 ]',
 '["Barbeiro","Barbeiro Sênior","Esteticista"]',
 '{"aceita_agendamento":true,"permite_cancelamento":true,"horas_antecedencia_cancelamento":2,"intervalo_agenda_minutos":30}',
 1)

ON CONFLICT (slug) DO NOTHING;

INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
-- Studio de Beleza
('agendamento', 'Agendamento', '📅', 'studio_beleza', 'Studio de Beleza',
 'Unhas, cílios, make, depilação e sobrancelhas', '💄',
 '#1a0a1a', '#e91e8c',
 '["agenda","profissionais","servicos","produtos","vendas","comissao","bloqueios","avaliacoes"]',
 '[
   {"nome":"Manicure",                     "categoria":"Unhas",       "duracao_minutos":45, "preco":40.00, "ordem":1},
   {"nome":"Pedicure",                     "categoria":"Unhas",       "duracao_minutos":60, "preco":50.00, "ordem":2},
   {"nome":"Manicure + Pedicure",          "categoria":"Unhas",       "duracao_minutos":90, "preco":80.00, "ordem":3},
   {"nome":"Alongamento de Unhas (Gel)",   "categoria":"Unhas",       "duracao_minutos":120,"preco":150.00,"ordem":4},
   {"nome":"Design de Cílios (Classic)",   "categoria":"Cílios",      "duracao_minutos":90, "preco":120.00,"ordem":5},
   {"nome":"Volume Russo",                 "categoria":"Cílios",      "duracao_minutos":120,"preco":180.00,"ordem":6},
   {"nome":"Maquiagem Social",             "categoria":"Make",        "duracao_minutos":60, "preco":120.00,"ordem":7},
   {"nome":"Depilação Perna Inteira",      "categoria":"Depilação",   "duracao_minutos":40, "preco":60.00, "ordem":8},
   {"nome":"Depilação Buço",               "categoria":"Depilação",   "duracao_minutos":15, "preco":20.00, "ordem":9},
   {"nome":"Design de Sobrancelha",        "categoria":"Sobrancelha", "duracao_minutos":30, "preco":35.00, "ordem":10},
   {"nome":"Micropigmentação Sobrancelha", "categoria":"Sobrancelha", "duracao_minutos":120,"preco":350.00,"ordem":11}
 ]',
 '["Manicure","Designer de Cílios","Maquiadora","Depiladora","Sobrancelhista","Esteticista"]',
 '{"aceita_agendamento":true,"permite_cancelamento":true,"horas_antecedencia_cancelamento":2,"comissao_padrao_percentual":40,"intervalo_agenda_minutos":30}',
 2)

ON CONFLICT (slug) DO NOTHING;

-- ─── MÓDULO: ACADEMIAS ───────────────────────────────────────

INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
-- Academia
('academias', 'Academias', '💪', 'academia', 'Academia',
 'Gestão de alunos, planos, instrutores CLT e freelancers', '🏋️',
 '#0d1117', '#f97316',
 '["agenda","profissionais","servicos","planos","checkin","vendas","avaliacoes"]',
 '[
   {"nome":"Plano Mensal",           "categoria":"Plano",    "duracao_minutos":0, "preco":89.90, "ordem":1},
   {"nome":"Plano Trimestral",       "categoria":"Plano",    "duracao_minutos":0, "preco":239.90,"ordem":2},
   {"nome":"Plano Semestral",        "categoria":"Plano",    "duracao_minutos":0, "preco":419.90,"ordem":3},
   {"nome":"Plano Anual",            "categoria":"Plano",    "duracao_minutos":0, "preco":779.90,"ordem":4},
   {"nome":"Avaliação Física",       "categoria":"Avaliação","duracao_minutos":60,"preco":80.00, "ordem":5},
   {"nome":"Personal Trainer (1h)",  "categoria":"Personal", "duracao_minutos":60,"preco":120.00,"ordem":6},
   {"nome":"Aula de Musculação",     "categoria":"Aula",     "duracao_minutos":60,"preco":0,     "ordem":7},
   {"nome":"Aula de Spinning",       "categoria":"Aula",     "duracao_minutos":50,"preco":0,     "ordem":8}
 ]',
 '["Professor CLT","Instrutor Freelance","Personal Trainer","Recepcionista"]',
 '{"aceita_agendamento":true,"permite_cancelamento":true,"horas_antecedencia_cancelamento":4,"tipos_contrato_profissional":["CLT","Freelance","PJ"],"intervalo_agenda_minutos":60,"checkin_habilitado":true}',
 1)

ON CONFLICT (slug) DO NOTHING;

INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
-- Personal Trainer
('academias', 'Academias', '💪', 'personal_trainer', 'Personal Trainer',
 'Agenda de treinos, planos mensais e controle de alunos', '🏃',
 '#0d1117', '#10b981',
 '["agenda","servicos","planos","vendas","avaliacoes"]',
 '[
   {"nome":"Sessão Personal (1h)",       "categoria":"Treino","duracao_minutos":60, "preco":120.00,"ordem":1},
   {"nome":"Plano Mensal (3x/semana)",   "categoria":"Plano", "duracao_minutos":0,  "preco":480.00,"ordem":2},
   {"nome":"Plano Mensal (5x/semana)",   "categoria":"Plano", "duracao_minutos":0,  "preco":700.00,"ordem":3},
   {"nome":"Avaliação Física Completa",  "categoria":"Avaliação","duracao_minutos":60,"preco":150.00,"ordem":4},
   {"nome":"Programa Online (mensal)",   "categoria":"Online","duracao_minutos":0,  "preco":200.00,"ordem":5}
 ]',
 '["Personal Trainer","Nutricionista Parceiro"]',
 '{"aceita_agendamento":true,"permite_cancelamento":true,"horas_antecedencia_cancelamento":4,"intervalo_agenda_minutos":60,"pode_vincular_academia":true}',
 2)

ON CONFLICT (slug) DO NOTHING;

-- ─── MÓDULO: DELIVERY / RESTAURANTES ─────────────────────────

INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
('delivery', 'Restaurantes & Delivery', '🍔', 'delivery', 'Restaurante / Delivery',
 'Cardápio digital, pedidos online e gestão de entregas', '🍽️',
 '#1a0800', '#f97316',
 '["cardapio","pedidos","cozinha","vendas"]',
 '[]',
 '["Atendente","Entregador","Cozinheiro","Gerente"]',
 '{"aceita_agendamento":false,"taxa_entrega_padrao":5.00,"tempo_preparo_minutos":30,"aceita_retirada":true,"aceita_entrega":true,"pedido_minimo":0}',
 1)

ON CONFLICT (slug) DO NOTHING;

-- ─── MÓDULO: RASTREAMENTO ─────────────────────────────────────

INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
('rastreamento', 'Rastreamento', '📡', 'rastreamento', 'Rastreamento de Veículos',
 'Gestão de frota, contratos e cobranças mensais de clientes', '🚗',
 '#0a0a1a', '#3b82f6',
 '["frota","cobranca","crm","vendas"]',
 '[
   {"nome":"Mensalidade Básica",       "categoria":"Plano",  "duracao_minutos":0,"preco":49.90, "ordem":1},
   {"nome":"Mensalidade Premium",      "categoria":"Plano",  "duracao_minutos":0,"preco":89.90, "ordem":2},
   {"nome":"Instalação do Rastreador", "categoria":"Serviço","duracao_minutos":60,"preco":150.00,"ordem":3}
 ]',
 '["Técnico Instalador","Atendente","Supervisor"]',
 '{"aceita_agendamento":false,"show_mapa":false,"dia_cobranca":10,"campos_veiculo":["placa","modelo","ano","cor","data_instalacao","imei_rastreador"]}',
 1)

ON CONFLICT (slug) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- FIM DA MIGRATION V4
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v5_triple_play.sql
-- ─────────────────────────────────────────────────────────────
-- Migração para Módulo Financeiro Triple-Play
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS asaas_api_key TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS asaas_wallet_id TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS pix_key_type TEXT; -- email, cpf, cnpj, phone, random
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS pix_key_value TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS pix_receiver_name TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS preferred_payment_method TEXT DEFAULT 'manual_pix'; -- mp, asaas, manual_pix

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v6_whatsapp_automation.sql
-- ─────────────────────────────────────────────────────────────
-- Migração para Módulo de Automação de WhatsApp (Bot & IA)

CREATE TABLE IF NOT EXISTS whatsapp_configs (
    establishment_id    UUID PRIMARY KEY REFERENCES establishments(id) ON DELETE CASCADE,
    welcome_message     TEXT DEFAULT 'Olá! Seja bem-vindo à nossa loja. Como podemos te ajudar hoje?',
    delay_min           INTEGER DEFAULT 2, -- segundos
    delay_max           INTEGER DEFAULT 5, -- segundos
    typing_effect       BOOLEAN DEFAULT true,
    enable_ai           BOOLEAN DEFAULT true,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_flows (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    trigger_keyword     TEXT NOT NULL,
    response_text       TEXT NOT NULL,
    action_type         TEXT DEFAULT 'text', -- text, menu, transfer
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_flows_est ON whatsapp_flows(establishment_id);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v7_social_profile.sql
-- ─────────────────────────────────────────────────────────────
-- Migração para Perfil Social e Redes
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS facebook_url TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS website_url TEXT;
-- logo_url, instagram_url e whatsapp_link já existem no schema base

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v8_optimized_logo.sql
-- ─────────────────────────────────────────────────────────────
-- Migração para Logo Otimizada e Social Links Consolidado
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS logo_base64 TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'::jsonb;

-- Comentário: Manteremos logo_url e as colunas sociais antigas por compatibilidade temporária, 
-- mas a prioridade de leitura será logo_base64 e social_links.

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v9_universal_catalog.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v10_refined_catalog.sql
-- ─────────────────────────────────────────────────────────────
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

-- NOTA: idx_categories_store removido do bootstrap. A tabela "categories" já
-- foi criada antes (migration_v9_universal_catalog.sql) com a coluna
-- "establishment_id", então este CREATE TABLE é um no-op e "store_id" nunca
-- chega a existir em categories — só em "products" (tabela nova aqui). O
-- índice equivalente (establishment_id) já existe via idx_cat_est (v9) e
-- idx_categories_establishment (v11, mais abaixo).
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v11_fix_catalog_naming.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v12_ai_memory.sql
-- ─────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v12 — Memória de Longo Prazo da Ágatha
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_memory (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        REFERENCES users(id) ON DELETE CASCADE,
  whatsapp         TEXT,                          -- fallback para usuários só WhatsApp
  establishment_id UUID        REFERENCES establishments(id) ON DELETE CASCADE,
  summary          TEXT,                          -- resumo de longo prazo (atualizado pela IA)
  messages         JSONB       NOT NULL DEFAULT '[]', -- últimas N mensagens [{role,content,ts}]
  context_json     JSONB       NOT NULL DEFAULT '{}', -- fatos extraídos: preferências, alergias, etc.
  last_interaction TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Um registro por usuário × estabelecimento (NULL = portal Águia-ON geral)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_user_est
  ON ai_memory (user_id, establishment_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_wa_est
  ON ai_memory (whatsapp, establishment_id)
  WHERE whatsapp IS NOT NULL AND user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_memory_user   ON ai_memory (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_memory_est    ON ai_memory (establishment_id);
CREATE INDEX IF NOT EXISTS idx_ai_memory_last   ON ai_memory (last_interaction DESC);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v13_video_url.sql
-- ─────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v13 — Suporte a vídeos do YouTube
-- ─────────────────────────────────────────────────────────────────────────────

-- Catálogo de itens (tabela real usada pelo catalog.ts é 'products')
ALTER TABLE products     ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS video_url TEXT;

-- Anúncios do SuperAdmin
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS video_url TEXT;

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v14_personal_trainer.sql
-- ─────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v14 — Segmento Personal Trainer
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO segments
  (module_slug, module_label, module_icon, slug, label, descricao, icon,
   cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem)
VALUES
('agendamento', 'Agendamento', '📅', 'personal_trainer', 'Personal Trainer',
 'Aulas particulares, planos de consultoria online e biblioteca de treinos em vídeo', '🏃',
 '#050f1a', '#22d3ee',
 '["agenda","profissionais","servicos","planos","vendas","avaliacoes"]',
 '[
   {"nome":"Aula Particular (1h)",    "categoria":"Treino Avulso","duracao_minutos":60,"preco":120.00,"ordem":1},
   {"nome":"Avaliação Física",        "categoria":"Avaliação",    "duracao_minutos":60,"preco":90.00, "ordem":2},
   {"nome":"Consultoria Online (1h)", "categoria":"Online",       "duracao_minutos":60,"preco":80.00, "ordem":3}
 ]',
 '["Personal Trainer","Nutricionista Parceiro","Assistente"]',
 '{
   "aceita_agendamento":true,
   "permite_cancelamento":true,
   "horas_antecedencia_cancelamento":4,
   "intervalo_agenda_minutos":60,
   "modalidade_atendimento":"hibrido",
   "plataforma_online":"",
   "agata_knowledge":"Sou personal trainer e ofereço aulas presenciais, online e consultoria. Foco em evolução progressiva, saúde e bem-estar. Ajudo os alunos com dúvidas sobre treinos, frequência de sessões e planos disponíveis.",
   "agata_mood":"Motivadora, enérgica e focada em resultados. Usa linguagem positiva e encoraja o aluno a manter a consistência. Lembra que evolução leva tempo e que cada treino conta."
 }',
 3)
ON CONFLICT (slug) DO UPDATE SET
  label        = EXCLUDED.label,
  descricao    = EXCLUDED.descricao,
  features     = EXCLUDED.features,
  servicos_padrao = EXCLUDED.servicos_padrao,
  business_config = EXCLUDED.business_config,
  ativo        = true;

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v15_delivery.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v16_sms_gateway.sql
-- ─────────────────────────────────────────────────────────────
-- Migração: Gateway de SMS (plataforma compartilhada + override por lojista)
-- Mesmo padrão de whatsapp_configs/evolution: cada provider pode ser
-- compartilhado (establishment_id NULL) ou próprio de um lojista (SHARED vs OWN).
-- Nota: o módulo src/shared/smsSender.ts também cria essas tabelas de forma
-- idempotente em runtime (CREATE TABLE IF NOT EXISTS), então rodar este
-- arquivo manualmente é opcional — serve como referência/documentação.

CREATE TABLE IF NOT EXISTS sms_providers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID REFERENCES establishments(id) ON DELETE CASCADE, -- NULL = compartilhado (plataforma)
    provider            TEXT NOT NULL,          -- fake | android | http_gateway | smsmarket
    label               TEXT,
    config              JSONB NOT NULL DEFAULT '{}', -- campos do provider; segredos já vêm criptografados
    is_primary          BOOLEAN NOT NULL DEFAULT false,
    priority            INTEGER NOT NULL DEFAULT 100,  -- menor = tentado primeiro na cadeia de failover
    status              TEXT NOT NULL DEFAULT 'unknown', -- connected | error | unknown
    active              BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_providers_est ON sms_providers(establishment_id);
CREATE INDEX IF NOT EXISTS idx_sms_providers_priority ON sms_providers(establishment_id, priority);

CREATE TABLE IF NOT EXISTS sms_dispatches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID REFERENCES establishments(id) ON DELETE CASCADE,
    provider_id         UUID REFERENCES sms_providers(id) ON DELETE SET NULL,
    provider_type       TEXT,
    phone               TEXT NOT NULL,
    message             TEXT NOT NULL,
    action              TEXT DEFAULT 'notification', -- notification | billing.reminder | vehicle.alert | tracker.command
    status              TEXT NOT NULL DEFAULT 'processing', -- queued | processing | sent | failed
    external_id         TEXT,
    error_message       TEXT,
    used_failover       BOOLEAN NOT NULL DEFAULT false,
    idempotency_key     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_dispatch_idem ON sms_dispatches(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_dispatch_est ON sms_dispatches(establishment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_logs (
    id                  SERIAL PRIMARY KEY,
    provider_id         UUID REFERENCES sms_providers(id) ON DELETE SET NULL,
    provider_type       TEXT,
    action              TEXT,
    recipient           TEXT,
    success             BOOLEAN NOT NULL,
    response_time_ms    INTEGER,
    error_message       TEXT,
    used_failover       BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_logs_created ON sms_logs(created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v17_veiculos.sql
-- ─────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v17 — Rastreamento veicular (primeira fatia: veículos + GPSWOX)
-- ─────────────────────────────────────────────────────────────────────────────
-- Cada empresa (establishment) traz a própria conta GPSWOX (decisão: federado,
-- não compartilhado — diferente do SMS/WhatsApp que são SHARED por padrão).
-- Nota: src/shared/gpswoxClient.ts também cria essas tabelas de forma
-- idempotente em runtime; rodar este arquivo manualmente é opcional.

-- 1. Credenciais GPSWOX por estabelecimento (uma conta por empresa)
CREATE TABLE IF NOT EXISTS gpswox_configs (
    establishment_id    UUID PRIMARY KEY REFERENCES establishments(id) ON DELETE CASCADE,
    url                 TEXT,
    api_hash            TEXT,   -- criptografado (cryptoUtil.encrypt) antes de salvar
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Veículos
CREATE TABLE IF NOT EXISTS vehicles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL, -- cliente dono (opcional, pode ficar sem vínculo)
    plate               TEXT,          -- opcional (veículo novo sem emplacamento)
    brand               TEXT,
    model               TEXT,
    color               TEXT,
    gpswox_device_id    TEXT,          -- id do dispositivo no GPSWOX da empresa (sync manual por enquanto)
    status              TEXT NOT NULL DEFAULT 'pending_installation'
                          CHECK (status IN ('pending_installation','active','inactive')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_establishment ON vehicles(establishment_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v18_white_label.sql
-- ─────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v18 — White-label por empresa (domínio customizado)
-- ─────────────────────────────────────────────────────────────────────────────
-- Subdomínio (slug.PLATFORM_BASE_DOMAIN) já funciona sem coluna nova, via
-- establishments.slug existente. Esta migration só adiciona o suporte a
-- domínio 100% próprio da empresa (ex: www.loja1.com.br).

ALTER TABLE establishments ADD COLUMN IF NOT EXISTS custom_domain TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_establishments_custom_domain
  ON establishments(custom_domain) WHERE custom_domain IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v19_billing.sql
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v20_rate_limit_store.sql
-- ─────────────────────────────────────────────────────────────
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


-- ─────────────────────────────────────────────────────────────
-- >>> migration_v21_frota_rastreamento.sql
-- ─────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v21 — Módulo Rastreamento: sync GPSWOX + cobrança
-- (referência — o schema real é aplicado via ensureTables() em
--  src/routes/agenda/index.ts, mesmo padrão idempotente das demais
--  tabelas do módulo agenda; este arquivo documenta e serve para o
--  deploy_bootstrap.sql)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE agenda_frota
  ADD COLUMN IF NOT EXISTS gpswox_device_id   TEXT,
  ADD COLUMN IF NOT EXISTS tracker_model       TEXT,
  ADD COLUMN IF NOT EXISTS tracker_synced_at   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agenda_frota_charges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
  establishment_id  UUID NOT NULL,
  competencia       TEXT NOT NULL,
  valor             NUMERIC(10,2) NOT NULL,
  pix_code          TEXT,
  pix_provider      TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agenda_frota_id, competencia)
);

CREATE INDEX IF NOT EXISTS idx_frota_charges_estab ON agenda_frota_charges(establishment_id);
CREATE INDEX IF NOT EXISTS idx_frota_gpswox_device ON agenda_frota(gpswox_device_id);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v22_frota_comandos.sql
-- ─────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v22 — Módulo Rastreamento: comandos, histórico e
-- compartilhamento (Fase 8)
-- (referência — o schema real é aplicado via ensureTables() em
--  src/routes/agenda/index.ts, mesmo padrão idempotente das demais
--  tabelas do módulo agenda)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agenda_frota_commands (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
  establishment_id  UUID NOT NULL,
  action            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agenda_frota_shares (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
  establishment_id  UUID NOT NULL,
  link              TEXT,
  duration_minutes  INTEGER NOT NULL DEFAULT 60,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_frota_commands_veiculo ON agenda_frota_commands(agenda_frota_id);
CREATE INDEX IF NOT EXISTS idx_frota_shares_veiculo ON agenda_frota_shares(agenda_frota_id);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v23_frota_sms_fallback.sql
-- ─────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v23 — Fallback SMS pros comandos de rastreamento
-- (referência — o schema real é aplicado via ensureTables() em
--  src/routes/agenda/index.ts)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE agenda_frota ADD COLUMN IF NOT EXISTS tracker_phone TEXT;

ALTER TABLE agenda_frota_commands
  ADD COLUMN IF NOT EXISTS channel  TEXT NOT NULL DEFAULT '4g' CHECK (channel IN ('4g','sms')),
  ADD COLUMN IF NOT EXISTS failover BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v24_user_addresses.sql
-- ─────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v24 — Tabela user_addresses (fix de bug de produção)
-- (referência — o schema real é aplicado via a IIFE de migração no
--  topo de src/routes/delivery.ts, mesmo padrão idempotente de
--  CREATE TABLE IF NOT EXISTS já usado no resto do projeto)
--
-- Contexto: user_addresses era referenciada em delivery.ts e client.ts
-- desde antes deste projeto, mas nunca teve um CREATE TABLE em lugar
-- nenhum do código. Em um banco novo isso derruba o boot do módulo de
-- delivery inteiro com "relation user_addresses does not exist".
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_addresses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'Casa',
  address       TEXT,
  street        TEXT,
  number        TEXT,
  neighborhood  TEXT,
  city          TEXT,
  reference     TEXT,
  lat           DECIMAL(10,7),
  lng           DECIMAL(10,7),
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, label)
);

CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);

-- ─────────────────────────────────────────────────────────────
-- >>> migration_v25_establishments_suspend_token.sql
-- ─────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION v25 — Colunas de suspensão/ativação/token da loja
-- (referência — o schema real é aplicado via a IIFE de migração no
--  topo de src/routes/admin.ts, mesmo padrão idempotente já usado
--  no resto do projeto)
--
-- Contexto: is_suspended, suspension_reason, suspended_at,
-- activated_until e store_token eram usadas em src/routes/admin.ts
-- desde antes deste projeto, mas nenhuma tinha CREATE/ALTER em
-- lugar nenhum do código. Em banco novo isso quebra
-- GET /admin/establishments (lista de lojas não carrega) e
-- POST /admin/establishments (criar loja falha).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE establishments ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS activated_until DATE;
ALTER TABLE establishments ADD COLUMN IF NOT EXISTS store_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_establishments_store_token
  ON establishments(store_token) WHERE store_token IS NOT NULL;
