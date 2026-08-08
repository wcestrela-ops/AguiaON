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
