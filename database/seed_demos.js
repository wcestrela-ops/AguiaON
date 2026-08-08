/**
 * Águia-ON SAAS — SEED DE LOJAS DEMO
 *
 * Cria uma loja demo para cada segmento do sistema.
 * Todas as contas usam a senha: Demo@2025
 *
 * Como rodar:
 *   node -r dotenv/config database/seed_demos.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: horário comercial padrão Seg–Sex + Sáb meio período
// ─────────────────────────────────────────────────────────────────────────────
function _horariosComerciais(start, end) {
  const dias = {};
  for (let d = 0; d <= 6; d++) {
    dias[String(d)] = d === 0
      ? { active: false, start, end }
      : d === 6
        ? { active: true, start, end: '13:00' }
        : { active: true, start, end };
  }
  return dias;
}

// ─────────────────────────────────────────────────────────────────────────────
// DADOS DAS LOJAS DEMO
// ─────────────────────────────────────────────────────────────────────────────
const DEMOS = [
  {
    estId:  'de000001-0000-0000-0000-000000000001',
    userId: 'de000001-0000-0000-0000-000000000002',
    name:   'Barbearia Estilo (DEMO)',
    slug:   'barbearia-demo',
    city:   'São Paulo',
    vertical_slug: 'barbearia',
    cor_primaria:  '#1a1a1a',
    cor_destaque:  '#d4af37',
    active_features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'bloqueios', 'avaliacoes'],
    business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 2, intervalo_agenda_minutos: 30 },
    settings: {
      theme: { primary_color: '#d4af37' },
      contact: { whatsapp: '11911110001', email: 'demo@barbearia.com' },
      business_hours: _horariosComerciais('08:00', '20:00'),
      is_open: true,
    },
    description: 'Cortes modernos, barba e estética masculina. Ambiente estiloso, profissionais experientes.',
    categorias: [
      { nome: 'Cabelo', ordem: 1 },
      { nome: 'Barba',  ordem: 2 },
      { nome: 'Combo',  ordem: 3 },
      { nome: 'Estética', ordem: 4 },
    ],
    produtos: [
      { cat: 'Cabelo',   nome: 'Corte Masculino',      tipo: 'service', preco: 45.00, duracao: 30, desc: 'Corte na tesoura ou máquina com acabamento perfeito.' },
      { cat: 'Barba',    nome: 'Barba Completa',        tipo: 'service', preco: 35.00, duracao: 30, desc: 'Aparar, modelar e hidratação com toalha quente.' },
      { cat: 'Combo',    nome: 'Combo Corte + Barba',   tipo: 'service', preco: 70.00, duracao: 60, desc: 'Pacote completo com desconto especial.' },
      { cat: 'Estética', nome: 'Sobrancelha',            tipo: 'service', preco: 20.00, duracao: 15, desc: 'Design e definição de sobrancelha masculina.' },
      { cat: 'Cabelo',   nome: 'Hidratação Capilar',    tipo: 'service', preco: 30.00, duracao: 30, desc: 'Tratamento profundo para cabelos ressecados.' },
    ],
    owner_name: 'Carlos Barbeiro (DEMO)',
    email:      'demo@barbearia-ag.com',
    whatsapp:   '11911110001',
  },

  {
    estId:  'de000002-0000-0000-0000-000000000001',
    userId: 'de000002-0000-0000-0000-000000000002',
    name:   'Studio Bella Unhas (DEMO)',
    slug:   'studio-beleza-demo',
    city:   'Rio de Janeiro',
    vertical_slug: 'studio_beleza',
    cor_primaria:  '#1a0a1a',
    cor_destaque:  '#e91e8c',
    active_features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'comissao', 'bloqueios', 'avaliacoes'],
    business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 2, comissao_padrao_percentual: 40, intervalo_agenda_minutos: 30 },
    settings: {
      theme: { primary_color: '#e91e8c' },
      contact: { whatsapp: '21922220002', email: 'demo@studio-beleza.com' },
      business_hours: _horariosComerciais('09:00', '19:00'),
      is_open: true,
    },
    description: 'Unhas artísticas, sobrancelhas perfeitas e depilação profissional. O melhor do Rio!',
    categorias: [
      { nome: 'Unhas',       ordem: 1 },
      { nome: 'Sobrancelha', ordem: 2 },
      { nome: 'Depilação',   ordem: 3 },
      { nome: 'Maquiagem',   ordem: 4 },
    ],
    produtos: [
      { cat: 'Unhas',       nome: 'Manicure',                tipo: 'service', preco: 40.00,  duracao: 45,  desc: 'Cuidado completo das unhas das mãos.' },
      { cat: 'Unhas',       nome: 'Pedicure',                tipo: 'service', preco: 50.00,  duracao: 60,  desc: 'Cuidado completo das unhas dos pés.' },
      { cat: 'Unhas',       nome: 'Manicure + Pedicure',     tipo: 'service', preco: 80.00,  duracao: 90,  desc: 'Combo completo com desconto.' },
      { cat: 'Sobrancelha', nome: 'Design de Sobrancelha',   tipo: 'service', preco: 35.00,  duracao: 30,  desc: 'Design personalizado com linha e pinça.' },
      { cat: 'Depilação',   nome: 'Depilação Perna Inteira', tipo: 'service', preco: 60.00,  duracao: 40,  desc: 'Remoção completa dos pelos com cera quente.' },
      { cat: 'Maquiagem',   nome: 'Maquiagem Social',        tipo: 'service', preco: 120.00, duracao: 60,  desc: 'Maquiagem completa para festas e eventos.' },
    ],
    owner_name: 'Ana Studio (DEMO)',
    email:      'demo@studio-ag.com',
    whatsapp:   '21922220002',
  },

  {
    estId:  'de000003-0000-0000-0000-000000000001',
    userId: 'de000003-0000-0000-0000-000000000002',
    name:   'Academia Força Total (DEMO)',
    slug:   'academia-demo',
    city:   'Curitiba',
    vertical_slug: 'academia',
    cor_primaria:  '#0d1117',
    cor_destaque:  '#f97316',
    active_features: ['agenda', 'profissionais', 'servicos', 'planos', 'checkin', 'vendas', 'avaliacoes'],
    business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 4, intervalo_agenda_minutos: 60 },
    settings: {
      theme: { primary_color: '#f97316' },
      contact: { whatsapp: '41933330003', email: 'demo@academia.com' },
      business_hours: { '0': {active:false,start:'08:00',end:'12:00'}, '1': {active:true,start:'06:00',end:'22:00'}, '2': {active:true,start:'06:00',end:'22:00'}, '3': {active:true,start:'06:00',end:'22:00'}, '4': {active:true,start:'06:00',end:'22:00'}, '5': {active:true,start:'06:00',end:'22:00'}, '6': {active:true,start:'08:00',end:'14:00'} },
      is_open: true,
    },
    description: 'Musculação, crossfit, spinning e personal trainer. Estrutura completa para sua evolução!',
    categorias: [
      { nome: 'Planos',   ordem: 1 },
      { nome: 'Serviços', ordem: 2 },
    ],
    produtos: [
      { cat: 'Planos',   nome: 'Plano Mensal',      tipo: 'plan',    preco: 89.90,  recorrencia: 'monthly',  desc: 'Acesso ilimitado por 30 dias.' },
      { cat: 'Planos',   nome: 'Plano Trimestral',  tipo: 'plan',    preco: 239.90, recorrencia: 'quarterly', desc: 'Acesso por 3 meses com desconto.' },
      { cat: 'Planos',   nome: 'Plano Semestral',   tipo: 'plan',    preco: 419.90, recorrencia: 'semiannual', desc: 'Acesso por 6 meses com o melhor custo-benefício.' },
      { cat: 'Planos',   nome: 'Plano Anual',       tipo: 'plan',    preco: 779.90, recorrencia: 'annual',   desc: 'Acesso anual com economia de 27%.' },
      { cat: 'Serviços', nome: 'Avaliação Física',  tipo: 'service', preco: 80.00,  duracao: 60, desc: 'Bioimpedância, medidas e montagem de planilha de treino.' },
      { cat: 'Serviços', nome: 'Personal Trainer',  tipo: 'service', preco: 120.00, duracao: 60, desc: 'Sessão exclusiva com professor certificado.' },
    ],
    owner_name: 'Roberto Academia (DEMO)',
    email:      'demo@academia-ag.com',
    whatsapp:   '41933330003',
  },

  // ── PERSONAL TRAINER ────────────────────────────────────────────────────────
  {
    estId:  'de000004-0000-0000-0000-000000000001',
    userId: 'de000004-0000-0000-0000-000000000002',
    name:   'Lucas PT — Personal Trainer (DEMO)',
    slug:   'personal-trainer-demo',
    city:   'Belo Horizonte',
    vertical_slug: 'personal_trainer',
    cor_primaria:  '#050f1a',
    cor_destaque:  '#22d3ee',
    active_features: ['agenda', 'profissionais', 'servicos', 'planos', 'vendas', 'avaliacoes'],
    business_config: {
      aceita_agendamento: true,
      permite_cancelamento: true,
      horas_antecedencia_cancelamento: 4,
      intervalo_agenda_minutos: 60,
      modalidade_atendimento: 'hibrido',
      plataforma_online: 'Google Meet',
      agata_knowledge: 'Sou personal trainer com mais de 8 anos de experiência. Atendo presencial em BH e online para todo o Brasil. Trabalho com emagrecimento, hipertrofia e preparação para corridas.',
      agata_mood: 'Motivador, energético e focado em resultados reais. Acredito que consistência bate intensidade. Cada treino te aproxima do seu objetivo.',
    },
    settings: {
      theme: { primary_color: '#22d3ee' },
      contact: { whatsapp: '31944440004', email: 'demo@personal.com' },
      business_hours: _horariosComerciais('06:00', '21:00'),
      is_open: true,
    },
    description: 'Personal trainer com 8 anos de experiência. Treinos presenciais, online e consultoria de nutrição. Resultados reais e acompanhamento próximo.',
    categorias: [
      { nome: 'Sessões Avulsas', ordem: 1 },
      { nome: 'Planos Mensais',  ordem: 2 },
      { nome: 'Online',          ordem: 3 },
      { nome: 'Avaliação',       ordem: 4 },
    ],
    produtos: [
      { cat: 'Sessões Avulsas', nome: 'Sessão Presencial (1h)',      tipo: 'service', preco: 130.00, duracao: 60,  desc: 'Treino individual supervisionado na academia parceira.' },
      { cat: 'Sessões Avulsas', nome: 'Sessão Online (1h)',          tipo: 'service', preco: 90.00,  duracao: 60,  desc: 'Treino ao vivo via Google Meet — você treina de onde estiver.' },
      { cat: 'Planos Mensais',  nome: 'Plano 2x por semana',         tipo: 'plan',    preco: 480.00, recorrencia: 'monthly', desc: '8 sessões presenciais + acompanhamento no WhatsApp.' },
      { cat: 'Planos Mensais',  nome: 'Plano 3x por semana',         tipo: 'plan',    preco: 680.00, recorrencia: 'monthly', desc: '12 sessões presenciais + planilha de treino + dieta.' },
      { cat: 'Planos Mensais',  nome: 'Plano 5x por semana',         tipo: 'plan',    preco: 950.00, recorrencia: 'monthly', desc: '20 sessões + nutrição + suplementação orientada.' },
      { cat: 'Online',          nome: 'Consultoria Online (mensal)',  tipo: 'plan',    preco: 250.00, recorrencia: 'monthly', desc: 'Planilha de treino + vídeos explicativos + revisão quinzenal.' },
      { cat: 'Online',          nome: 'Plano Treino em Casa (mensal)',tipo: 'plan',    preco: 150.00, recorrencia: 'monthly', desc: 'Treinos sem equipamentos, adaptados para home office.' },
      { cat: 'Avaliação',       nome: 'Avaliação Física Completa',   tipo: 'service', preco: 180.00, duracao: 90,  desc: 'Bioimpedância, medidas corporais, VO² máx estimado e planilha personalizada.' },
    ],
    owner_name: 'Lucas Personal (DEMO)',
    email:      'demo@personal-ag.com',
    whatsapp:   '31944440004',
  },

  // ── RESTAURANTE / DELIVERY ──────────────────────────────────────────────────
  {
    estId:  'de000005-0000-0000-0000-000000000001',
    userId: 'de000005-0000-0000-0000-000000000002',
    name:   'Burguer Top (DEMO)',
    slug:   'delivery-demo',
    city:   'Florianópolis',
    vertical_slug: 'delivery',
    cor_primaria:  '#1a0800',
    cor_destaque:  '#f97316',
    active_features: ['cardapio', 'pedidos', 'vendas'],
    business_config: {
      aceita_agendamento: false,
      delivery_tax: 5.00,
      free_delivery_over: 60.00,
      estimated_time: '30-45 min',
      delivery_type: 'both',
      min_order: 25.00,
    },
    settings: {
      theme: { primary_color: '#f97316' },
      contact: { whatsapp: '48955550005', email: 'demo@delivery.com' },
      business_hours: { '0': {active:true,start:'11:00',end:'23:00'}, '1': {active:true,start:'11:00',end:'23:00'}, '2': {active:true,start:'11:00',end:'23:00'}, '3': {active:true,start:'11:00',end:'23:00'}, '4': {active:true,start:'11:00',end:'23:00'}, '5': {active:true,start:'11:00',end:'00:00'}, '6': {active:true,start:'11:00',end:'00:00'} },
      is_open: true,
    },
    description: 'Os melhores hambúrgueres artesanais de Floripa. Entrega rápida e retirada no local. Frete grátis em pedidos acima de R$ 60!',
    categorias: [
      { nome: 'Hambúrgueres',    ordem: 1 },
      { nome: 'Combos',          ordem: 2 },
      { nome: 'Acompanhamentos', ordem: 3 },
      { nome: 'Bebidas',         ordem: 4 },
      { nome: 'Sobremesas',      ordem: 5 },
    ],
    produtos: [
      { cat: 'Hambúrgueres', nome: 'X-Burguer Clássico',           tipo: 'product', preco: 24.90, desc: '180g de blend bovino, queijo cheddar, alface, tomate e molho especial.' },
      { cat: 'Hambúrgueres', nome: 'X-Bacon Duplo',                tipo: 'product', preco: 32.90, desc: 'Dois blends de 150g, bacon crocante, queijo duplo e cebola caramelizada.' },
      { cat: 'Hambúrgueres', nome: 'Smash Burguer',                tipo: 'product', preco: 28.90, desc: 'Blend smashado na chapa, queijo americano, pepino e mostarda.' },
      { cat: 'Hambúrgueres', nome: 'Burguer Vegano',               tipo: 'product', preco: 26.90, desc: 'Blend de feijão preto e grão de bico, queijo vegano e pesto de rúcula.' },
      { cat: 'Combos',       nome: 'Combo Clássico',               tipo: 'product', preco: 38.90, desc: 'X-Burguer Clássico + Batata Média + Refrigerante Lata.' },
      { cat: 'Combos',       nome: 'Combo Bacon Duplo',            tipo: 'product', preco: 46.90, desc: 'X-Bacon Duplo + Batata Grande + Refri ou Suco.' },
      { cat: 'Acompanhamentos', nome: 'Batata Frita Pequena',      tipo: 'product', preco: 9.90,  desc: 'Batatas crocantes com tempero defumado.' },
      { cat: 'Acompanhamentos', nome: 'Batata Frita Grande',       tipo: 'product', preco: 15.90, desc: 'Porção grande de batatas crocantes para dividir.' },
      { cat: 'Acompanhamentos', nome: 'Anéis de Cebola',           tipo: 'product', preco: 13.90, desc: 'Anéis empanados e fritos com molho barbecue.' },
      { cat: 'Bebidas',      nome: 'Refrigerante Lata',            tipo: 'product', preco: 6.90,  desc: 'Coca-Cola, Guaraná ou Fanta — 350ml.' },
      { cat: 'Bebidas',      nome: 'Suco Natural 500ml',           tipo: 'product', preco: 12.90, desc: 'Laranja, limão ou maracujá — feito na hora.' },
      { cat: 'Bebidas',      nome: 'Milkshake',                    tipo: 'product', preco: 18.90, desc: 'Morango, chocolate ou baunilha — 400ml.' },
      { cat: 'Sobremesas',   nome: 'Brownie com Sorvete',          tipo: 'product', preco: 14.90, desc: 'Brownie quentinho com bola de sorvete de creme.' },
    ],
    // Configuração de delivery
    delivery: {
      delivery_tax: 5.00,
      free_delivery_over: 60.00,
      estimated_time: '30-45 min',
      delivery_type: 'both',
      min_order: 25.00,
    },
    // Zonas de entrega
    zonas: [
      { nome: 'Centro',     taxa: 3.00,  tempo: '20-30 min' },
      { nome: 'Continente', taxa: 5.00,  tempo: '30-40 min' },
      { nome: 'Norte',      taxa: 7.00,  tempo: '40-55 min' },
      { nome: 'Sul',        taxa: 7.00,  tempo: '40-55 min' },
    ],
    // Grupos de opcionais (por produto: nome do produto → grupos)
    opcoes: {
      'X-Burguer Clássico': [
        {
          nome: 'Ponto da Carne', min: 1, max: 1, obrigatorio: true,
          itens: [
            { nome: 'Mal Passada',  preco: 0 },
            { nome: 'Ao Ponto',     preco: 0 },
            { nome: 'Bem Passada',  preco: 0 },
          ],
        },
        {
          nome: 'Adicionais', min: 0, max: 4, obrigatorio: false,
          itens: [
            { nome: 'Bacon Crocante',  preco: 4.00 },
            { nome: 'Ovo Frito',       preco: 3.00 },
            { nome: 'Queijo Extra',    preco: 2.50 },
            { nome: 'Cebola Roxa',     preco: 1.50 },
            { nome: 'Jalapeño',        preco: 1.00 },
          ],
        },
      ],
      'X-Bacon Duplo': [
        {
          nome: 'Ponto da Carne', min: 1, max: 1, obrigatorio: true,
          itens: [
            { nome: 'Mal Passada', preco: 0 },
            { nome: 'Ao Ponto',    preco: 0 },
            { nome: 'Bem Passada', preco: 0 },
          ],
        },
        {
          nome: 'Molho', min: 0, max: 2, obrigatorio: false,
          itens: [
            { nome: 'Molho Especial',  preco: 0 },
            { nome: 'Barbecue',        preco: 0 },
            { nome: 'Aioli de Alho',   preco: 0 },
            { nome: 'Pimenta Sriracha',preco: 0 },
          ],
        },
      ],
      'Smash Burguer': [
        {
          nome: 'Adicionar ao Smash', min: 0, max: 3, obrigatorio: false,
          itens: [
            { nome: 'Bacon',        preco: 4.00 },
            { nome: 'Ovo',          preco: 3.00 },
            { nome: 'Queijo Extra', preco: 2.50 },
          ],
        },
      ],
      'Batata Frita Grande': [
        {
          nome: 'Sabor', min: 1, max: 1, obrigatorio: true,
          itens: [
            { nome: 'Tradicional (sal)',      preco: 0 },
            { nome: 'Temperada (defumado)',   preco: 0 },
            { nome: 'Parmesão e Alho',        preco: 3.00 },
            { nome: 'Cheddar e Bacon',        preco: 5.00 },
          ],
        },
      ],
      'Milkshake': [
        {
          nome: 'Sabor', min: 1, max: 1, obrigatorio: true,
          itens: [
            { nome: 'Morango',   preco: 0 },
            { nome: 'Chocolate', preco: 0 },
            { nome: 'Baunilha',  preco: 0 },
            { nome: 'Ovomaltine',preco: 2.00 },
          ],
        },
      ],
    },
    owner_name: 'Marcos Delivery (DEMO)',
    email:      'demo@delivery-ag.com',
    whatsapp:   '48955550005',
  },

  // ── RASTREAMENTO ────────────────────────────────────────────────────────────
  {
    estId:  'de000006-0000-0000-0000-000000000001',
    userId: 'de000006-0000-0000-0000-000000000002',
    name:   'RastreoFácil Gestão (DEMO)',
    slug:   'rastreamento-demo',
    city:   'Brasília',
    vertical_slug: 'rastreamento',
    cor_primaria:  '#0a0a1a',
    cor_destaque:  '#3b82f6',
    active_features: ['frota', 'frota_clientes', 'cobranca', 'crm', 'vendas'],
    business_config: { aceita_agendamento: false, show_mapa: false, dia_cobranca: 10, campos_veiculo: ['placa', 'modelo', 'ano', 'cor', 'data_instalacao', 'imei_rastreador'] },
    settings: {
      theme: { primary_color: '#3b82f6' },
      contact: { whatsapp: '61966660006', email: 'demo@rastreamento.com' },
      business_hours: _horariosComerciais('08:00', '18:00'),
      is_open: true,
    },
    description: 'Gestão completa de frotas com rastreamento em tempo real. Controle de mensalidades e CRM integrado.',
    categorias: [
      { nome: 'Planos',   ordem: 1 },
      { nome: 'Serviços', ordem: 2 },
    ],
    produtos: [
      { cat: 'Planos',   nome: 'Mensalidade Básica',       tipo: 'plan',    preco: 49.90,  recorrencia: 'monthly', desc: 'Rastreamento em tempo real, histórico de 30 dias.' },
      { cat: 'Planos',   nome: 'Mensalidade Premium',      tipo: 'plan',    preco: 89.90,  recorrencia: 'monthly', desc: 'Rastreamento + alertas de velocidade + cerca virtual.' },
      { cat: 'Serviços', nome: 'Instalação do Rastreador', tipo: 'service', preco: 150.00, duracao: 60,            desc: 'Instalação técnica com garantia de 1 ano.' },
    ],
    owner_name: 'Pedro Rastreamento (DEMO)',
    email:      'demo@rastreamento-ag.com',
    whatsapp:   '61966660006',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌱 Águia-ON SAAS — Seed de Lojas Demo\n');

  const PASSWORD = 'Demo@2025';
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── Garante colunas e tabelas ──────────────────────────────────────────────
  const alters = [
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS vertical_slug TEXT NOT NULL DEFAULT 'generico'`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS active_features JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS business_config JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS setup_done BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_primaria TEXT`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_destaque TEXT`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS niche_data JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS city TEXT`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS whatsapp_link TEXT`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS instagram_url TEXT`,
    // delivery columns
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS delivery_tax NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS free_delivery_over NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS estimated_time TEXT DEFAULT '30-45 min'`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS delivery_type TEXT DEFAULT 'both'`,
    `ALTER TABLE establishments ADD COLUMN IF NOT EXISTS min_order NUMERIC(10,2) DEFAULT 0`,
  ];
  for (const sql of alters) await pool.query(sql);

  // Catálogo
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      name             TEXT NOT NULL,
      order_index      INTEGER DEFAULT 0,
      active           BOOLEAN DEFAULT true,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      category_id      UUID,
      name             TEXT NOT NULL,
      description      TEXT,
      price            NUMERIC(10,2) NOT NULL DEFAULT 0,
      type             TEXT NOT NULL DEFAULT 'product',
      image_base64     TEXT,
      video_url        TEXT,
      settings         JSONB NOT NULL DEFAULT '{}',
      active           BOOLEAN DEFAULT true,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )`);

  // Delivery
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delivery_zones (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      name             TEXT NOT NULL,
      delivery_tax     NUMERIC(10,2) NOT NULL DEFAULT 0,
      estimated_time   TEXT,
      is_active        BOOLEAN NOT NULL DEFAULT true,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_options (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id  UUID NOT NULL,
      name        TEXT NOT NULL,
      min_options INTEGER NOT NULL DEFAULT 0,
      max_options INTEGER NOT NULL DEFAULT 1,
      is_required BOOLEAN NOT NULL DEFAULT false,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_option_items (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      option_id        UUID NOT NULL,
      name             TEXT NOT NULL,
      additional_price NUMERIC(10,2) NOT NULL DEFAULT 0,
      is_active        BOOLEAN NOT NULL DEFAULT true,
      order_index      INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  // ── Itera demos ────────────────────────────────────────────────────────────
  for (const demo of DEMOS) {
    process.stdout.write(`  → ${demo.name} ... `);

    // 1. Estabelecimento
    await pool.query(`
      INSERT INTO establishments (
        id, name, slug, city, vertical_slug, setup_done, is_active, is_public,
        active_features, business_config, cor_primaria, cor_destaque,
        settings, niche_data, whatsapp_link, description
      ) VALUES ($1,$2,$3,$4,$5,true,true,true,$6,$7,$8,$9,$10,'{}',$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        name            = EXCLUDED.name,
        slug            = EXCLUDED.slug,
        active_features = EXCLUDED.active_features,
        business_config = EXCLUDED.business_config,
        cor_primaria    = EXCLUDED.cor_primaria,
        cor_destaque    = EXCLUDED.cor_destaque,
        settings        = EXCLUDED.settings,
        description     = EXCLUDED.description,
        whatsapp_link   = EXCLUDED.whatsapp_link,
        is_public       = true,
        setup_done      = true
    `, [
      demo.estId, demo.name, demo.slug, demo.city, demo.vertical_slug,
      JSON.stringify(demo.active_features),
      JSON.stringify(demo.business_config),
      demo.cor_primaria, demo.cor_destaque,
      JSON.stringify(demo.settings),
      demo.settings.contact.whatsapp,
      demo.description,
    ]);

    // 2. Config delivery (se for loja de delivery)
    if (demo.delivery) {
      const d = demo.delivery;
      await pool.query(`
        UPDATE establishments SET
          delivery_tax=$1, free_delivery_over=$2, estimated_time=$3,
          delivery_type=$4, min_order=$5
        WHERE id=$6
      `, [d.delivery_tax, d.free_delivery_over, d.estimated_time, d.delivery_type, d.min_order, demo.estId]);
    }

    // 3. Usuário
    await pool.query(`
      INSERT INTO users (id, full_name, whatsapp, email, password_hash, auth_level, establishment_id, is_confirmed)
      VALUES ($1,$2,$3,$4,$5,'LOJISTA',$6,true)
      ON CONFLICT (id) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        email         = EXCLUDED.email,
        full_name     = EXCLUDED.full_name
    `, [demo.userId, demo.owner_name, demo.whatsapp, demo.email, hash, demo.estId]);

    // 4. Catálogo: recria categorias e produtos
    await pool.query(`DELETE FROM products  WHERE establishment_id = $1`, [demo.estId]);
    await pool.query(`DELETE FROM categories WHERE establishment_id = $1`, [demo.estId]);

    // Cria categorias e mapeia nome → id
    const catMap = {};
    for (const cat of (demo.categorias || [])) {
      const res = await pool.query(`
        INSERT INTO categories (establishment_id, name, order_index)
        VALUES ($1,$2,$3) RETURNING id
      `, [demo.estId, cat.nome, cat.ordem]);
      catMap[cat.nome] = res.rows[0].id;
    }

    // Cria produtos
    const prodMap = {}; // nome → id (para opcoes de delivery)
    for (const p of (demo.produtos || [])) {
      const catId = catMap[p.cat] || null;
      const settings = {};
      if (p.duracao)      settings.duration_minutes = p.duracao;
      if (p.recorrencia)  settings.recurrence       = p.recorrencia;

      const res = await pool.query(`
        INSERT INTO products (establishment_id, category_id, name, description, price, type, settings)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [demo.estId, catId, p.nome, p.desc || '', p.preco, p.tipo, JSON.stringify(settings)]);
      prodMap[p.nome] = res.rows[0].id;
    }

    // 5. Zonas de entrega (só delivery)
    if (demo.zonas) {
      await pool.query(`DELETE FROM delivery_zones WHERE establishment_id = $1`, [demo.estId]);
      for (const z of demo.zonas) {
        await pool.query(`
          INSERT INTO delivery_zones (establishment_id, name, delivery_tax, estimated_time)
          VALUES ($1,$2,$3,$4)
        `, [demo.estId, z.nome, z.taxa, z.tempo]);
      }
    }

    // 6. Opcionais de produto (só delivery)
    if (demo.opcoes) {
      for (const [prodNome, grupos] of Object.entries(demo.opcoes)) {
        const productId = prodMap[prodNome];
        if (!productId) continue;

        // Remove opcionais antigos do produto
        await pool.query(`DELETE FROM product_options WHERE product_id = $1`, [productId]);

        for (let gi = 0; gi < grupos.length; gi++) {
          const g = grupos[gi];
          const gRes = await pool.query(`
            INSERT INTO product_options (product_id, name, min_options, max_options, is_required, order_index)
            VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
          `, [productId, g.nome, g.min, g.max, g.obrigatorio, gi]);

          const groupId = gRes.rows[0].id;
          for (let ii = 0; ii < g.itens.length; ii++) {
            const it = g.itens[ii];
            await pool.query(`
              INSERT INTO product_option_items (option_id, name, additional_price, order_index)
              VALUES ($1,$2,$3,$4)
            `, [groupId, it.nome, it.preco, ii]);
          }
        }
      }
    }

    console.log('✅');
  }

  // ── Resumo ────────────────────────────────────────────────────────────────
  console.log('\n✅ Todas as lojas demo criadas com sucesso!\n');
  console.log('┌──────────────────────────────────────────────────────────────────────┐');
  console.log('│                      CREDENCIAIS DE ACESSO                           │');
  console.log('├───────────────────────┬──────────────────────────────┬───────────────┤');
  console.log('│ Segmento              │ E-mail                       │ Senha         │');
  console.log('├───────────────────────┼──────────────────────────────┼───────────────┤');
  for (const demo of DEMOS) {
    console.log(`│ ${demo.vertical_slug.padEnd(21)} │ ${demo.email.padEnd(28)} │ Demo@2025     │`);
  }
  console.log('├───────────────────────┴──────────────────────────────┴───────────────┤');
  console.log('│  Links públicos das vitrines:                                        │');
  for (const demo of DEMOS) {
    console.log(`│    /${demo.slug.padEnd(69)}│`);
  }
  console.log('└──────────────────────────────────────────────────────────────────────┘\n');

  await pool.end();
}

main().catch(err => {
  console.error('\n❌ Erro no seed:', err);
  process.exit(1);
});
