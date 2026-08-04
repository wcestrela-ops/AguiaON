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
