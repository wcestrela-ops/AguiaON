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
