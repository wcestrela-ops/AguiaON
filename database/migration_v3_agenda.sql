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