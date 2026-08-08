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
