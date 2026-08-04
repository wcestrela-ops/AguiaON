/**
 * BLUEPRINTS DE NICHOS — Águia-ON
 *
 * Cada nicho define:
 * - label / icon / cores
 * - features ativas (quais abas aparecem no painel)
 * - serviços padrão criados automaticamente no setup
 * - configuração de negócio (business_config)
 */

export type Feature =
  | 'agenda'
  | 'profissionais'
  | 'servicos'
  | 'produtos'
  | 'vendas'
  | 'bloqueios'
  | 'avaliacoes'
  | 'planos'
  | 'checkin'
  | 'comissao'
  | 'frota'
  | 'frota_clientes'
  | 'cobranca'
  | 'crm'
  | 'cardapio'
  | 'pedidos'
  | 'mesas'
  | 'cozinha'
  | 'clientes';

export interface ServicoBlueprint {
  nome: string;
  categoria: string;
  duracao_minutos: number;
  preco: number;
  ordem: number;
}

export interface Blueprint {
  slug: string;
  label: string;
  descricao: string;
  icon: string;         // emoji
  fa_icon: string;      // font-awesome class
  cor_primaria: string;
  cor_destaque: string;
  features: Feature[];
  servicos_padrao: ServicoBlueprint[];
  tipos_profissionais: string[];
  business_config: Record<string, any>;
  // 'marketplace' (padrão, implícito se omitido): várias lojas independentes
  // usam esse módulo, cada uma com o próprio catálogo/vitrine (Delivery,
  // Agenda, Academia...). 'servico_unico': só existe UMA loja desse módulo,
  // operada pela própria AguiaON, gerindo clientes finais direto (caso do
  // Rastreamento) — habilita a loja a editar a própria landing pelo painel
  // dela (em vez do Catálogo) e a conversão automática de lead em cliente.
  modelo_negocio?: 'marketplace' | 'servico_unico';
}

export const BLUEPRINTS: Record<string, Blueprint> = {

  barbearia: {
    slug: 'barbearia',
    label: 'Barbearia',
    descricao: 'Agendamento de cortes, barba e estética masculina',
    icon: '💈',
    fa_icon: 'fa-scissors',
    cor_primaria: '#1a1a1a',
    cor_destaque: '#d4af37',
    features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'bloqueios', 'avaliacoes'],
    tipos_profissionais: ['Barbeiro', 'Barbeiro Senior', 'Esteticista'],
    servicos_padrao: [
      { nome: 'Corte Masculino',     categoria: 'Cabelo',   duracao_minutos: 30, preco: 45.00, ordem: 1 },
      { nome: 'Barba Completa',      categoria: 'Barba',    duracao_minutos: 30, preco: 35.00, ordem: 2 },
      { nome: 'Combo Corte + Barba', categoria: 'Combo',    duracao_minutos: 60, preco: 70.00, ordem: 3 },
      { nome: 'Sobrancelha',         categoria: 'Estética', duracao_minutos: 15, preco: 20.00, ordem: 4 },
      { nome: 'Hidratação Capilar',  categoria: 'Tratamento', duracao_minutos: 30, preco: 30.00, ordem: 5 },
    ],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 2,
      aceita_pagamento_online: false,
      intervalo_agenda_minutos: 30,
    },
  },

  academia: {
    slug: 'academia',
    label: 'Academia',
    descricao: 'Gestão de alunos, planos, personal trainers e aulas',
    icon: '💪',
    fa_icon: 'fa-dumbbell',
    cor_primaria: '#0d1117',
    cor_destaque: '#f97316',
    features: ['agenda', 'profissionais', 'servicos', 'planos', 'checkin', 'vendas', 'avaliacoes', 'clientes'],
    tipos_profissionais: ['Professor CLT', 'Personal Trainer', 'Instrutor Freelance', 'Recepcionista'],
    servicos_padrao: [
      { nome: 'Avaliação Física',          categoria: 'Avaliação', duracao_minutos: 60,  preco: 80.00,  ordem: 1 },
      { nome: 'Personal Trainer (1h)',      categoria: 'Personal',  duracao_minutos: 60,  preco: 120.00, ordem: 2 },
      { nome: 'Aula de Musculação',         categoria: 'Aula',      duracao_minutos: 60,  preco: 0,      ordem: 3 },
      { nome: 'Aula de Spinning',           categoria: 'Aula',      duracao_minutos: 50,  preco: 0,      ordem: 4 },
      { nome: 'Pilates',                    categoria: 'Aula',      duracao_minutos: 50,  preco: 0,      ordem: 5 },
    ],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 4,
      tipos_contrato_profissional: ['CLT', 'Freelance', 'PJ'],
      intervalo_agenda_minutos: 60,
    },
  },

  studio_beleza: {
    slug: 'studio_beleza',
    label: 'Studio de Beleza',
    descricao: 'Unhas, sobrancelhas, depilação, maquiagem e mais',
    icon: '💄',
    fa_icon: 'fa-star',
    cor_primaria: '#1a0a1a',
    cor_destaque: '#e91e8c',
    features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'comissao', 'bloqueios', 'avaliacoes'],
    tipos_profissionais: ['Manicure', 'Depiladora', 'Maquiadora', 'Designer de Sobrancelha', 'Esteticista'],
    servicos_padrao: [
      { nome: 'Manicure',                  categoria: 'Unhas',       duracao_minutos: 45,  preco: 40.00,  ordem: 1 },
      { nome: 'Pedicure',                  categoria: 'Unhas',       duracao_minutos: 60,  preco: 50.00,  ordem: 2 },
      { nome: 'Manicure + Pedicure',       categoria: 'Unhas',       duracao_minutos: 90,  preco: 80.00,  ordem: 3 },
      { nome: 'Design de Sobrancelha',     categoria: 'Sobrancelha', duracao_minutos: 30,  preco: 35.00,  ordem: 4 },
      { nome: 'Micropigmentação Sobrancelha', categoria: 'Sobrancelha', duracao_minutos: 120, preco: 350.00, ordem: 5 },
      { nome: 'Depilação Perna Inteira',   categoria: 'Depilação',   duracao_minutos: 40,  preco: 60.00,  ordem: 6 },
      { nome: 'Depilação Buço',            categoria: 'Depilação',   duracao_minutos: 15,  preco: 20.00,  ordem: 7 },
      { nome: 'Maquiagem Social',          categoria: 'Maquiagem',   duracao_minutos: 60,  preco: 120.00, ordem: 8 },
    ],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 2,
      comissao_padrao_percentual: 40,
      intervalo_agenda_minutos: 30,
    },
  },

  rastreamento: {
    slug: 'rastreamento',
    label: 'Rastreamento (Gestão)',
    descricao: 'Gestão de frota, controle de mensalidades e CRM de clientes',
    icon: '📡',
    fa_icon: 'fa-satellite-dish',
    cor_primaria: '#0a0a1a',
    cor_destaque: '#3b82f6',
    features: ['frota', 'frota_clientes', 'cobranca', 'crm', 'vendas'],
    tipos_profissionais: ['Técnico Instalador', 'Atendente', 'Supervisor'],
    servicos_padrao: [
      { nome: 'Mensalidade Básica',    categoria: 'Plano', duracao_minutos: 0, preco: 49.90,  ordem: 1 },
      { nome: 'Mensalidade Premium',   categoria: 'Plano', duracao_minutos: 0, preco: 89.90,  ordem: 2 },
      { nome: 'Instalação do Rastreador', categoria: 'Serviço', duracao_minutos: 60, preco: 150.00, ordem: 3 },
    ],
    business_config: {
      show_mapa: true,
      dia_cobranca: 10,
      cobranca_automatica: false,
      aceita_agendamento: false,
      campos_veiculo: ['placa', 'modelo', 'ano', 'cor', 'data_instalacao', 'imei_rastreador'],
    },
    modelo_negocio: 'servico_unico',
  },

  personal_trainer: {
    slug: 'personal_trainer',
    label: 'Personal Trainer',
    descricao: 'Aulas particulares, planos de consultoria online e biblioteca de treinos em vídeo',
    icon: '🏃',
    fa_icon: 'fa-person-running',
    cor_primaria: '#050f1a',
    cor_destaque: '#22d3ee',
    features: ['agenda', 'profissionais', 'servicos', 'planos', 'vendas', 'avaliacoes'],
    tipos_profissionais: ['Personal Trainer', 'Nutricionista Parceiro', 'Assistente'],
    servicos_padrao: [
      { nome: 'Aula Particular (1h)',   categoria: 'Treino Avulso',  duracao_minutos: 60,  preco: 120.00, ordem: 1 },
      { nome: 'Avaliação Física',       categoria: 'Avaliação',      duracao_minutos: 60,  preco: 90.00,  ordem: 2 },
      { nome: 'Consultoria Online (1h)',categoria: 'Online',         duracao_minutos: 60,  preco: 80.00,  ordem: 3 },
    ],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 4,
      intervalo_agenda_minutos: 60,
      modalidade_atendimento: 'hibrido',
      plataforma_online: '',
      // Prompt da Ágata específico para personal trainers
      agata_knowledge: 'Sou personal trainer e ofereço aulas presenciais, online e consultoria. ' +
        'Foco em evolução progressiva, saúde e bem-estar. ' +
        'Ajudo os alunos com dúvidas sobre treinos, frequência de sessões e planos disponíveis.',
      agata_mood: 'Motivadora, enérgica e focada em resultados. Usa linguagem positiva e encoraja o aluno a manter a consistência. ' +
        'Lembra que evolução leva tempo e que cada treino conta.',
    },
  },

  delivery: {
    slug: 'delivery',
    label: 'Restaurante / Delivery',
    descricao: 'Cardápio digital com complementos, pedidos online e gestão de entregas',
    icon: '🍔',
    fa_icon: 'fa-burger',
    cor_primaria: '#1a0800',
    cor_destaque: '#f97316',
    features: ['cardapio', 'pedidos', 'mesas', 'vendas'],
    tipos_profissionais: ['Atendente', 'Entregador', 'Cozinheiro', 'Gerente'],
    servicos_padrao: [],
    business_config: {
      delivery_tax: 5.00,
      free_delivery_over: 50.00,
      estimated_time: '30-45 min',
      delivery_type: 'both',
      min_order: 20.00,
      agata_knowledge: 'Sou um restaurante com delivery. Atendo pedidos online e presencial. Tenho cardápio com diversas opções e entrego na região.',
      agata_mood: 'Simpática, ágil e focada em confirmar pedidos rapidamente. Sempre confirma os itens, o endereço e o tempo estimado de entrega.',
    },
  },

  salao: {
    slug: 'salao',
    label: 'Salão de Cabeleireiro',
    descricao: 'Cortes, coloração, tratamentos capilares e serviços de beleza feminina',
    icon: '✂️',
    fa_icon: 'fa-scissors',
    cor_primaria: '#1a0a0a',
    cor_destaque: '#c084fc',
    features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'comissao', 'bloqueios', 'avaliacoes'],
    tipos_profissionais: ['Cabeleireiro(a)', 'Colorista', 'Escovista', 'Auxiliar'],
    servicos_padrao: [
      { nome: 'Corte Feminino',            categoria: 'Cabelo',      duracao_minutos: 45,  preco: 60.00,  ordem: 1 },
      { nome: 'Escova Progressiva',        categoria: 'Tratamento',  duracao_minutos: 120, preco: 200.00, ordem: 2 },
      { nome: 'Coloração Completa',        categoria: 'Coloração',   duracao_minutos: 90,  preco: 150.00, ordem: 3 },
      { nome: 'Mechas / Luzes',            categoria: 'Coloração',   duracao_minutos: 120, preco: 250.00, ordem: 4 },
      { nome: 'Hidratação Profunda',       categoria: 'Tratamento',  duracao_minutos: 60,  preco: 80.00,  ordem: 5 },
      { nome: 'Escova Modeladora',         categoria: 'Cabelo',      duracao_minutos: 60,  preco: 70.00,  ordem: 6 },
      { nome: 'Cauterização',              categoria: 'Tratamento',  duracao_minutos: 90,  preco: 130.00, ordem: 7 },
      { nome: 'Corte Infantil',            categoria: 'Cabelo',      duracao_minutos: 30,  preco: 40.00,  ordem: 8 },
    ],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 2,
      comissao_padrao_percentual: 50,
      intervalo_agenda_minutos: 30,
      agata_knowledge: 'Sou um salão de cabeleireiro especializado em cabelos femininos. Oferecemos cortes, coloração, tratamentos, escova e muito mais.',
      agata_mood: 'Acolhedora, atenciosa e apaixonada por cabelos. Orienta as clientes sobre os serviços ideais para cada tipo de cabelo.',
    },
  },

  clinica: {
    slug: 'clinica',
    label: 'Clínica / Consultório',
    descricao: 'Agendamento de consultas médicas, psicológicas, nutricionais e procedimentos',
    icon: '🏥',
    fa_icon: 'fa-stethoscope',
    cor_primaria: '#030f1a',
    cor_destaque: '#0ea5e9',
    features: ['agenda', 'profissionais', 'servicos', 'vendas', 'bloqueios', 'avaliacoes'],
    tipos_profissionais: ['Médico(a)', 'Psicólogo(a)', 'Nutricionista', 'Fisioterapeuta', 'Recepcionista'],
    servicos_padrao: [
      { nome: 'Consulta Inicial',          categoria: 'Consulta',    duracao_minutos: 60,  preco: 200.00, ordem: 1 },
      { nome: 'Retorno',                   categoria: 'Consulta',    duracao_minutos: 30,  preco: 100.00, ordem: 2 },
      { nome: 'Sessão de Psicologia',      categoria: 'Psicologia',  duracao_minutos: 50,  preco: 180.00, ordem: 3 },
      { nome: 'Consulta Nutricional',      categoria: 'Nutrição',    duracao_minutos: 60,  preco: 160.00, ordem: 4 },
      { nome: 'Sessão de Fisioterapia',    categoria: 'Fisioterapia',duracao_minutos: 50,  preco: 130.00, ordem: 5 },
      { nome: 'Avaliação Postural',        categoria: 'Fisioterapia',duracao_minutos: 60,  preco: 150.00, ordem: 6 },
    ],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 24,
      intervalo_agenda_minutos: 60,
      confirmar_antes: true,
      agata_knowledge: 'Somos uma clínica multiprofissional. Atendemos consultas médicas, psicologia, nutrição e fisioterapia. Os agendamentos são sujeitos a confirmação.',
      agata_mood: 'Acolhedora, discreta e profissional. Prioriza o bem-estar do paciente e trata cada caso com empatia e sigilo.',
    },
  },

  petshop: {
    slug: 'petshop',
    label: 'Pet Shop & Veterinária',
    descricao: 'Banho, tosa, consultas veterinárias, hotel e produtos para pets',
    icon: '🐾',
    fa_icon: 'fa-paw',
    cor_primaria: '#051a0f',
    cor_destaque: '#22c55e',
    features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'bloqueios', 'avaliacoes'],
    tipos_profissionais: ['Tosador(a)', 'Banhista', 'Veterinário(a)', 'Atendente'],
    servicos_padrao: [
      { nome: 'Banho Pequeno Porte',       categoria: 'Banho & Tosa',  duracao_minutos: 60,  preco: 55.00,  ordem: 1 },
      { nome: 'Banho Médio Porte',         categoria: 'Banho & Tosa',  duracao_minutos: 90,  preco: 75.00,  ordem: 2 },
      { nome: 'Banho Grande Porte',        categoria: 'Banho & Tosa',  duracao_minutos: 120, preco: 110.00, ordem: 3 },
      { nome: 'Tosa Higiênica',            categoria: 'Banho & Tosa',  duracao_minutos: 30,  preco: 40.00,  ordem: 4 },
      { nome: 'Tosa Completa',             categoria: 'Banho & Tosa',  duracao_minutos: 60,  preco: 80.00,  ordem: 5 },
      { nome: 'Banho + Tosa Completa',     categoria: 'Banho & Tosa',  duracao_minutos: 120, preco: 130.00, ordem: 6 },
      { nome: 'Consulta Veterinária',      categoria: 'Veterinária',   duracao_minutos: 30,  preco: 150.00, ordem: 7 },
      { nome: 'Vacina Anual',              categoria: 'Veterinária',   duracao_minutos: 15,  preco: 120.00, ordem: 8 },
      { nome: 'Hotel Pet (diária)',        categoria: 'Hotel',         duracao_minutos: 0,   preco: 80.00,  ordem: 9 },
    ],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 2,
      intervalo_agenda_minutos: 30,
      especie_animais: ['Cão', 'Gato'],
      agata_knowledge: 'Somos um pet shop completo com banho, tosa, veterinária, hotel e produtos para seu pet. Cuidamos com amor de cães e gatos.',
      agata_mood: 'Carinhosa, animada e apaixonada por animais. Trata cada pet como família e orienta os tutores com paciência e afeto.',
    },
  },
};

/** Retorna blueprint ou lança erro se slug inválido */
export function getBlueprint(slug: string): Blueprint {
  const bp = BLUEPRINTS[slug];
  if (!bp) throw new Error(`Nicho desconhecido: ${slug}`);
  return bp;
}

/** Lista todos os blueprints disponíveis (para o frontend de seleção) */
export function listBlueprints() {
  return Object.values(BLUEPRINTS).map(bp => ({
    slug:        bp.slug,
    label:       bp.label,
    descricao:   bp.descricao,
    icon:        bp.icon,
    fa_icon:     bp.fa_icon,
    cor_destaque: bp.cor_destaque,
    modelo_negocio: bp.modelo_negocio || 'marketplace',
  }));
}

/**
 * Resincroniza `establishments.active_features` com a lista `features` de
 * cada blueprint deste arquivo, para toda empresa já configurada (`setup_done`).
 *
 * Por quê existe: `active_features` é gravado como uma cópia ("snapshot") do
 * blueprint no momento em que a empresa fez o setup (ou quando o SUPERADMIN
 * criou a loja/recriou as lojas demo) — não existe hoje nenhum toggle de
 * feature individual por empresa (sempre é 1:1 com o blueprint do nicho). Sem
 * essa sincronização, toda vez que a gente adiciona uma feature nova a um
 * blueprint (como `frota_clientes` na Fase 12), qualquer empresa criada
 * *antes* dessa mudança — inclusive as lojas demo do SUPERADMIN — fica presa
 * na lista antiga pra sempre, e a aba nova nunca aparece pra ela mesmo depois
 * do deploy, até alguém lembrar de corrigir manualmente no banco.
 *
 * Roda automaticamente uma vez a cada boot do servidor (`server.ts`), como um
 * job idempotente a mais — mesmo espírito do `ensureTables()` de cada rota:
 * só grava quando o conjunto de features realmente mudou (comparação exata
 * via `@>`/`<@` do Postgres, ignorando ordem), então não gera ruído em toda
 * subida quando nada mudou.
 */
export async function syncActiveFeatures(pool: { query: (sql: string, params?: any[]) => Promise<{ rowCount: number | null }> }): Promise<void> {
  for (const bp of Object.values(BLUEPRINTS)) {
    try {
      const featuresJson = JSON.stringify(bp.features);
      const r = await pool.query(
        `UPDATE establishments
         SET active_features = $1::jsonb, updated_at = NOW()
         WHERE vertical_slug = $2
           AND setup_done = true
           AND NOT (active_features @> $1::jsonb AND active_features <@ $1::jsonb)`,
        [featuresJson, bp.slug]
      );
      if (r.rowCount) {
        console.log(`[blueprints] active_features ressincronizado para ${r.rowCount} loja(s) do nicho "${bp.slug}".`);
      }
    } catch (err: any) {
      console.error(`[blueprints] falha ao ressincronizar active_features do nicho "${bp.slug}":`, err.message);
    }
  }
}