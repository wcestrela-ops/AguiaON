/**
 * ROTAS DO MÓDULO AGENDA — integradas no core
 * Prefixo: /agenda
 *
 * Todas as rotas exigem JWT válido com role LOJISTA ou SUPERADMIN.
 * Tenant isolation automático via user.establishmentId do JWT.
 */
import { Router, Request, Response } from 'express';
import pool from '../../shared/db';
import { requireAuth, TokenPayload } from '../../shared/authMiddleware';
import {
  getGpswoxConfig,
  saveGpswoxConfig,
  isGpswoxConfigured,
  listDevices as listGpswoxDevices,
  createDevice as createGpswoxDevice,
  getDeviceLocation,
  sendCommand as sendGpswoxCommand,
  getHistory,
  createSharing,
  listGeofences,
  addGeofence,
  deleteGeofence,
  isGpsFailoverEligible,
  extractDeviceImei,
  extractDeviceSimNumber,
  extractDeviceGpswoxUserId,
} from '../../shared/gpswoxClient';
// generateFrotaPix: só era usado por POST /frota/:id/cobrar, desativada no
// Fix de produção 32 (cobrança por veículo foi removida) — import mantido
// comentado na rota, não removido daqui, pra não quebrar se for reativado.
import { generateFrotaPix } from '../../shared/pixService';
import { sendSms } from '../../shared/smsSender';
import {
  listAllCustomers as listAsaasCustomers,
  createCustomer as createAsaasCustomer,
  getCustomerPayments as getAsaasCustomerPayments,
  getCustomerSubscriptions as getAsaasCustomerSubscriptions,
  createPixCharge as createAsaasPixCharge,
  getPixPayload as getAsaasPixPayload,
  getMunicipalOptions,
  listMunicipalServices,
  saveFiscalInfo,
} from '../../shared/asaasClient';
import { sendWhatsAppMessage } from '../../shared/waSender';
import { emitirNotaFiscal } from '../../shared/notaFiscalService';
import { listBlueprints } from '../../verticals/blueprints';
import { sendEmail, buildTermoAdesaoEmailHtml } from '../../shared/mailer';
import { montarMensagensCobranca, DadosMensagemCobranca } from '../../shared/cobrancaMensagem';

const router = Router();
router.use(requireAuth);

// Helper: retorna o establishment_id do JWT (ou lança 403)
function estabId(req: Request): string {
  const user = req.user as TokenPayload;
  if (user.role === 'SUPERADMIN') {
    // GET: query param | POST/PUT/PATCH: body
    return (req.body?.establishment_id as string) || (req.query.establishment_id as string) || '';
  }
  if (!user.establishmentId) throw { status: 403, message: 'Sem estabelecimento no token.' };
  return user.establishmentId;
}

// Auto-migração das tabelas do agenda (roda na primeira chamada)
// Exportada porque routes/landings.ts (conversão de lead do Rastreamento em
// agenda_clientes) também precisa garantir que a tabela/constraint existam
// antes do INSERT — sem isso, se nenhuma rota /agenda/* tiver rodado ainda
// nesse processo, a conversão quebraria com "relation does not exist".
let migrated = false;
export async function ensureTables() {
  if (migrated) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_profissionais (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      user_id UUID,
      nome TEXT NOT NULL,
      especialidade TEXT,
      tipo_contrato TEXT DEFAULT 'CLT',
      email TEXT, telefone TEXT, foto_url TEXT,
      comissao_percentual NUMERIC(5,2) DEFAULT 0,
      horario_trabalho JSONB DEFAULT '{}',
      ativo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_servicos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      nome TEXT NOT NULL, descricao TEXT, categoria TEXT,
      duracao_minutos INTEGER NOT NULL DEFAULT 30,
      preco NUMERIC(10,2) NOT NULL DEFAULT 0,
      comissao_percentual NUMERIC(5,2),
      ordem INTEGER DEFAULT 0,
      ativo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_agendamentos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      profissional_id UUID, servico_id UUID, user_id UUID,
      cliente_nome TEXT NOT NULL, cliente_telefone TEXT, cliente_email TEXT,
      data DATE NOT NULL, hora_inicio TIME NOT NULL, hora_fim TIME,
      status TEXT NOT NULL DEFAULT 'pendente',
      observacoes TEXT,
      valor_total NUMERIC(10,2) DEFAULT 0,
      valor_pago  NUMERIC(10,2) DEFAULT 0,
      metodo_pagamento TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_bloqueios (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL, profissional_id UUID,
      data_inicio DATE NOT NULL, data_fim DATE,
      hora_inicio TIME, hora_fim TIME,
      dia_inteiro BOOLEAN NOT NULL DEFAULT false,
      motivo TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_produtos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      nome TEXT NOT NULL, descricao TEXT, categoria TEXT,
      preco NUMERIC(10,2) NOT NULL DEFAULT 0,
      custo NUMERIC(10,2) DEFAULT 0,
      estoque INTEGER DEFAULT 0,
      estoque_minimo INTEGER DEFAULT 0,
      unidade TEXT DEFAULT 'un', imagem_url TEXT,
      ativo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_vendas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      agendamento_id UUID, profissional_id UUID, user_id UUID,
      cliente_nome TEXT,
      itens JSONB NOT NULL DEFAULT '[]',
      subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
      desconto NUMERIC(10,2) NOT NULL DEFAULT 0,
      total    NUMERIC(10,2) NOT NULL DEFAULT 0,
      comissao_calculada NUMERIC(10,2) DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      metodo_pagamento TEXT, observacoes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_avaliacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      agendamento_id UUID, profissional_id UUID, user_id UUID,
      cliente_nome TEXT,
      nota SMALLINT NOT NULL CHECK (nota BETWEEN 1 AND 5),
      comentario TEXT,
      aprovado BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_frota (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      user_id UUID, cliente_nome TEXT, cliente_telefone TEXT,
      placa TEXT, modelo TEXT, ano INTEGER, cor TEXT,
      imei_rastreador TEXT, data_instalacao DATE,
      plano_id UUID,
      status TEXT DEFAULT 'ativo',
      observacoes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Fase 7 — integração GPSWOX real + cobrança recorrente (portado do Águia Auto)
  await pool.query(`
    ALTER TABLE agenda_frota
      ADD COLUMN IF NOT EXISTS gpswox_device_id  TEXT,
      ADD COLUMN IF NOT EXISTS tracker_model      TEXT,
      ADD COLUMN IF NOT EXISTS tracker_synced_at   TIMESTAMPTZ
  `);
  await pool.query(`
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
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_charges_estab ON agenda_frota_charges(establishment_id)`);
  await pool.query(`ALTER TABLE agenda_frota_charges ADD COLUMN IF NOT EXISTS asaas_payment_id TEXT`);
  // Fix de produção 24 — "Fatura N°..." e o link da fatura hospedada no
  // Asaas, usados nas mensagens de cobrança/pagamento confirmado com o
  // mesmo padrão que a empresa já usava (Águia Auto). Só vem preenchido
  // quando o método de pagamento é Asaas (manual_pix/mercadopago não têm
  // esse conceito de fatura hospedada).
  await pool.query(`ALTER TABLE agenda_frota_charges ADD COLUMN IF NOT EXISTS invoice_url TEXT`);
  await pool.query(`ALTER TABLE agenda_frota_charges ADD COLUMN IF NOT EXISTS invoice_number TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_gpswox_device ON agenda_frota(gpswox_device_id)`);

  // Fase 8 — comandos remotos, histórico, compartilhamento
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_frota_commands (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
      establishment_id  UUID NOT NULL,
      action            TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
      error_message     TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Fallback SMS pros comandos (portado de gps-failover.js do Águia Auto)
  await pool.query(`
    ALTER TABLE agenda_frota ADD COLUMN IF NOT EXISTS tracker_phone TEXT
  `);
  await pool.query(`
    ALTER TABLE agenda_frota_commands
      ADD COLUMN IF NOT EXISTS channel  TEXT NOT NULL DEFAULT '4g' CHECK (channel IN ('4g','sms')),
      ADD COLUMN IF NOT EXISTS failover BOOLEAN NOT NULL DEFAULT false
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_frota_shares (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
      establishment_id  UUID NOT NULL,
      link              TEXT,
      duration_minutes  INTEGER NOT NULL DEFAULT 60,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_commands_veiculo ON agenda_frota_commands(agenda_frota_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_shares_veiculo ON agenda_frota_shares(agenda_frota_id)`);

  // Fase 11 — CRM do Rastreamento: notas por veículo/cliente + funil de leads
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_frota_notes (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
      establishment_id  UUID NOT NULL,
      texto             TEXT NOT NULL,
      autor_nome        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_frota_leads (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id  UUID NOT NULL,
      nome              TEXT NOT NULL,
      telefone          TEXT,
      veiculo_info      TEXT,
      etapa             TEXT NOT NULL DEFAULT 'novo_contato'
                          CHECK (etapa IN ('novo_contato','negociacao','agendado','instalado','perdido')),
      valor_estimado    NUMERIC(10,2),
      observacoes       TEXT,
      convertido_frota_id UUID REFERENCES agenda_frota(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_notes_veiculo ON agenda_frota_notes(agenda_frota_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_leads_estab ON agenda_frota_leads(establishment_id, etapa)`);

  // Fase 12 — Clientes do Rastreamento + import da base já cadastrada no Asaas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_clientes (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id  UUID NOT NULL,
      nome              TEXT NOT NULL,
      telefone          TEXT,
      email             TEXT,
      cpf_cnpj          TEXT,
      asaas_customer_id TEXT,
      origem            TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','asaas_sync')),
      observacoes       TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_estab ON agenda_clientes(establishment_id)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_asaas_id
      ON agenda_clientes(establishment_id, asaas_customer_id) WHERE asaas_customer_id IS NOT NULL
  `);
  // Fase 17 (Fix de produção 8) — conversão de lead do Rastreamento
  // (routes/landings.ts) cria um agenda_clientes com origem='landing_rastreamento',
  // valor novo que o CHECK original (só 'manual'/'asaas_sync') não aceitava.
  // Fica aqui, não em landings.ts, porque essa migração roda logo depois da
  // CREATE TABLE acima, no mesmo arquivo — sem depender de ordem entre
  // migrações de arquivos diferentes.
  // 'landing_rastreamento' era o valor original (Fix 8); generalizado pra
  // 'landing_modulo' no Fix de produção 12 (vale pra qualquer módulo
  // "serviço único", não só Rastreamento) — mantido na lista por segurança,
  // caso algum registro de teste já tenha usado o valor antigo.
  await pool.query(`ALTER TABLE agenda_clientes DROP CONSTRAINT IF EXISTS agenda_clientes_origem_check`);
  await pool.query(`ALTER TABLE agenda_clientes ADD CONSTRAINT agenda_clientes_origem_check CHECK (origem IN ('manual','asaas_sync','landing_rastreamento','landing_modulo'))`);
  // Fix de produção 9 — endereço, data de nascimento e contato de emergência
  // coletados no formulário "Contratar" da landing (routes/landings.ts), pra
  // já vir preenchido no cadastro do cliente sem precisar redigitar. Dados
  // do veículo (placa/modelo/ano/cor) vão pra agenda_frota, não pra cá.
  await pool.query(`
    ALTER TABLE agenda_clientes
      ADD COLUMN IF NOT EXISTS endereco_cep    TEXT,
      ADD COLUMN IF NOT EXISTS endereco_rua    TEXT,
      ADD COLUMN IF NOT EXISTS endereco_numero TEXT,
      ADD COLUMN IF NOT EXISTS endereco_bairro TEXT,
      ADD COLUMN IF NOT EXISTS endereco_cidade TEXT,
      ADD COLUMN IF NOT EXISTS endereco_estado TEXT,
      ADD COLUMN IF NOT EXISTS data_nascimento DATE,
      ADD COLUMN IF NOT EXISTS contato_emergencia_nome     TEXT,
      ADD COLUMN IF NOT EXISTS contato_emergencia_telefone TEXT
  `);
  // Cache local (só leitura/exibição) das cobranças e assinaturas que já
  // existiam na conta Asaas do lojista antes de existir essa tela — não é
  // fonte de verdade de cobrança nova, isso continua sendo agenda_frota_charges.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_cliente_asaas_cache (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cliente_id          UUID NOT NULL REFERENCES agenda_clientes(id) ON DELETE CASCADE,
      establishment_id    UUID NOT NULL,
      tipo                TEXT NOT NULL CHECK (tipo IN ('payment','subscription')),
      asaas_id             TEXT NOT NULL,
      valor               NUMERIC(10,2),
      status              TEXT,
      vencimento          TEXT,
      descricao           TEXT,
      invoice_url         TEXT,
      synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cliente_asaas_cache_cliente ON agenda_cliente_asaas_cache(cliente_id)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cliente_asaas_cache_unique
      ON agenda_cliente_asaas_cache(cliente_id, tipo, asaas_id)
  `);
  await pool.query(`ALTER TABLE agenda_frota ADD COLUMN IF NOT EXISTS cliente_id UUID REFERENCES agenda_clientes(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_cliente ON agenda_frota(cliente_id)`);
  await pool.query(`ALTER TABLE agenda_cliente_asaas_cache ADD COLUMN IF NOT EXISTS pix_payload TEXT`);

  // Fase 14 — Portal do cliente (login) + recorrência por cliente + dar baixa manual
  // user_id: vincula o cliente do Rastreamento a um usuário da tabela `users`
  // (auth_level='CLIENT') pra ele conseguir logar pelo /login unificado que já
  // existe — reaproveita o sistema de auth em vez de criar um paralelo.
  await pool.query(`ALTER TABLE agenda_clientes ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_user ON agenda_clientes(user_id)`);
  // Fix de produção 40 — findOrCreateClienteUser() (mais abaixo neste arquivo)
  // busca em `users` por `lower(email)=$2`. O índice único que já existe em
  // `users(email)` não serve pra essa busca (é sobre a coluna crua, não sobre
  // lower(email)) — sem um índice de expressão dedicado, toda chamada faz uma
  // varredura completa da tabela `users`, que só piora conforme a base de
  // usuários cresce. Isso roda a cada cliente novo/editado com telefone ou
  // e-mail (POST/PUT /agenda/clientes) — mais uma causa da lentidão reportada.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email))`);
  // Recorrência no nível do CLIENTE (independente de veículo) — valor fixo
  // cobrado todo mês no dia configurado, separado da recorrência por veículo
  // (agenda_frota.plano_id) que já existia desde a Fase 7.
  await pool.query(`ALTER TABLE agenda_clientes ADD COLUMN IF NOT EXISTS recorrencia_ativa BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE agenda_clientes ADD COLUMN IF NOT EXISTS valor_recorrente NUMERIC(10,2)`);
  await pool.query(`ALTER TABLE agenda_clientes ADD COLUMN IF NOT EXISTS dia_cobranca_recorrente SMALLINT CHECK (dia_cobranca_recorrente BETWEEN 1 AND 28)`);
  await pool.query(`ALTER TABLE agenda_clientes ADD COLUMN IF NOT EXISTS descricao_recorrente TEXT`);
  // Idempotência da recorrência de cliente — evita gerar 2x a cobrança do
  // mesmo mês se o processo reiniciar no meio (mesmo padrão de
  // agenda_frota_charges.UNIQUE(agenda_frota_id, competencia) da Fase 7).
  await pool.query(`ALTER TABLE agenda_cliente_asaas_cache ADD COLUMN IF NOT EXISTS competencia TEXT`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cliente_asaas_cache_competencia
      ON agenda_cliente_asaas_cache(cliente_id, competencia) WHERE competencia IS NOT NULL
  `);
  // "Dar baixa" manual — pra cobrança em Pix Manual (sem webhook automático),
  // o lojista confirma o pagamento na mão depois de ver o comprovante.
  await pool.query(`ALTER TABLE agenda_cliente_asaas_cache ADD COLUMN IF NOT EXISTS baixado_manualmente BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE agenda_cliente_asaas_cache ADD COLUMN IF NOT EXISTS baixado_em TIMESTAMPTZ`);

  // Fix de produção 22 — lembrete de cobrança no dia do vencimento marcado no
  // Asaas (trackingBillingJob.ts). Cobre tanto a cobrança que a gente mesmo
  // gera (recorrência de cliente) quanto a que já existia direto na conta
  // Asaas do lojista e só foi trazida pelo "Sincronizar" — pra não mandar 2x
  // pro mesmo cliente no mesmo dia, marca aqui se já foi avisado (a
  // recorrência de cliente já marca isso na hora que gera + avisa).
  await pool.query(`ALTER TABLE agenda_cliente_asaas_cache ADD COLUMN IF NOT EXISTS lembrete_enviado BOOLEAN NOT NULL DEFAULT false`);

  // Fix de produção 24 — mesma "Fatura N°..." do agenda_frota_charges acima,
  // aqui pro lado da cobrança de CLIENTE (recorrência, avulsa, sincronizada).
  await pool.query(`ALTER TABLE agenda_cliente_asaas_cache ADD COLUMN IF NOT EXISTS invoice_number TEXT`);
  // Data do último "resumo de faturas atrasadas" mandado pra esse cliente —
  // controla a frequência configurável (Configurações → Rastreamento) do
  // aviso de atraso, pra não mandar de novo antes do intervalo escolhido
  // pelo lojista (7/15/30 dias).
  await pool.query(`ALTER TABLE agenda_clientes ADD COLUMN IF NOT EXISTS aviso_atraso_enviado_em TIMESTAMPTZ`);

  // Fase 13 — Nota fiscal automática (NFS-e via Asaas) + cobrança avulsa por WhatsApp
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_fiscal_config (
      establishment_id       UUID PRIMARY KEY,
      email                  TEXT NOT NULL,
      municipal_inscription  TEXT,
      simples_nacional       BOOLEAN NOT NULL DEFAULT true,
      cultural_projects_promoter BOOLEAN NOT NULL DEFAULT false,
      cnae                   TEXT,
      special_tax_regime     TEXT,
      service_list_item      TEXT,
      nbs_code               TEXT,
      rps_serie              TEXT,
      rps_number             INTEGER,
      lote_number            INTEGER,
      auth_type              TEXT NOT NULL DEFAULT 'USER_AND_PASSWORD' CHECK (auth_type IN ('USER_AND_PASSWORD','TOKEN')),
      username                TEXT,
      password                TEXT,
      access_token            TEXT,
      municipal_service_id    TEXT,
      municipal_service_code  TEXT,
      municipal_service_name  TEXT,
      retain_iss              BOOLEAN NOT NULL DEFAULT false,
      iss_pct                 NUMERIC(5,2) NOT NULL DEFAULT 0,
      pis_pct                 NUMERIC(5,2) NOT NULL DEFAULT 0,
      cofins_pct              NUMERIC(5,2) NOT NULL DEFAULT 0,
      csll_pct                NUMERIC(5,2) NOT NULL DEFAULT 0,
      inss_pct                NUMERIC(5,2) NOT NULL DEFAULT 0,
      ir_pct                  NUMERIC(5,2) NOT NULL DEFAULT 0,
      emissao_automatica       BOOLEAN NOT NULL DEFAULT false,
      ativo                    BOOLEAN NOT NULL DEFAULT false,
      configured_at            TIMESTAMPTZ,
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_notas_fiscais (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id  UUID NOT NULL,
      cliente_id        UUID REFERENCES agenda_clientes(id) ON DELETE SET NULL,
      agenda_frota_id   UUID REFERENCES agenda_frota(id) ON DELETE SET NULL,
      asaas_payment_id  TEXT,
      asaas_invoice_id  TEXT,
      status            TEXT NOT NULL DEFAULT 'SCHEDULED',
      valor             NUMERIC(10,2),
      pdf_url           TEXT,
      xml_url           TEXT,
      erro              TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notas_fiscais_estab ON agenda_notas_fiscais(establishment_id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notas_fiscais_payment ON agenda_notas_fiscais(asaas_payment_id) WHERE asaas_payment_id IS NOT NULL`);
  // Fix de produção 40 — cliente_id e agenda_frota_id têm FK com ON DELETE
  // SET NULL mas nunca ganharam índice próprio. Sem índice, todo DELETE de
  // agenda_clientes (ou de agenda_frota) obriga o Postgres a varrer a tabela
  // agenda_notas_fiscais INTEIRA pra achar as linhas que referenciam o
  // registro apagado (é assim que o banco enforce a FK) — e essa varredura
  // fica mais lenta à medida que a tabela cresce, o que bate exatamente com
  // o que o Carlos reportou ("apagar cliente demora mais do que antes").
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notas_fiscais_cliente ON agenda_notas_fiscais(cliente_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notas_fiscais_frota ON agenda_notas_fiscais(agenda_frota_id)`);

  // Colunas extras em establishments
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS vertical_slug TEXT NOT NULL DEFAULT 'generico'`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS active_features JSONB NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS business_config JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS setup_done BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_primaria TEXT`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_destaque TEXT`);
  migrated = true;
}

// Middleware de auto-migração
router.use(async (_req, _res, next) => {
  try { await ensureTables(); next(); }
  catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════
// DASHBOARD — resumo do dia
// ═══════════════════════════════════════════════════════
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const eid = estabId(req);
    const hoje = new Date().toISOString().split('T')[0];

    const [agendHoje, agendMes, vendasHoje, profCount, servCount] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM agenda_agendamentos WHERE establishment_id=$1 AND data=$2`, [eid, hoje]),
      pool.query(`SELECT COUNT(*) FROM agenda_agendamentos WHERE establishment_id=$1 AND data_trunc('month',data::timestamptz)=date_trunc('month',NOW())`, [eid]).catch(() =>
        pool.query(`SELECT COUNT(*) FROM agenda_agendamentos WHERE establishment_id=$1 AND data >= date_trunc('month', NOW()::date)`, [eid])),
      pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM agenda_vendas WHERE establishment_id=$1 AND created_at::date=$2 AND status='pago'`, [eid, hoje]),
      pool.query(`SELECT COUNT(*) FROM agenda_profissionais WHERE establishment_id=$1 AND ativo=true`, [eid]),
      pool.query(`SELECT COUNT(*) FROM agenda_servicos WHERE establishment_id=$1 AND ativo=true`, [eid]),
    ]);

    // Próximos agendamentos do dia
    const proximos = await pool.query(
      `SELECT a.*, p.nome AS profissional_nome, s.nome AS servico_nome
       FROM agenda_agendamentos a
       LEFT JOIN agenda_profissionais p ON p.id = a.profissional_id
       LEFT JOIN agenda_servicos s ON s.id = a.servico_id
       WHERE a.establishment_id=$1 AND a.data=$2 AND a.status NOT IN ('cancelado','faltou')
       ORDER BY a.hora_inicio LIMIT 10`,
      [eid, hoje]
    );

    res.json({
      hoje:            { agendamentos: parseInt(agendHoje.rows[0].count), faturamento: parseFloat(vendasHoje.rows[0].total) },
      mes:             { agendamentos: parseInt(agendMes.rows[0].count) },
      totais:          { profissionais: parseInt(profCount.rows[0].count), servicos: parseInt(servCount.rows[0].count) },
      proximos_hoje:   proximos.rows,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// PROFISSIONAIS
// ═══════════════════════════════════════════════════════
router.get('/profissionais', async (req, res) => {
  try {
    const eid = estabId(req);
    const { ativo } = req.query;
    let q = `SELECT * FROM agenda_profissionais WHERE establishment_id=$1`;
    const p: any[] = [eid];
    if (ativo !== undefined) { q += ` AND ativo=$2`; p.push(ativo === 'true'); }
    q += ` ORDER BY nome`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/profissionais', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, especialidade, tipo_contrato, email, telefone, foto_url, comissao_percentual, horario_trabalho } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_profissionais (establishment_id,nome,especialidade,tipo_contrato,email,telefone,foto_url,comissao_percentual,horario_trabalho)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [eid, nome, especialidade||null, tipo_contrato||'CLT', email||null, telefone||null, foto_url||null,
       comissao_percentual||0, horario_trabalho ? JSON.stringify(horario_trabalho) : '{}']
    );
    res.status(201).json({ success: true, profissional: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/profissionais/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, especialidade, tipo_contrato, email, telefone, foto_url, comissao_percentual, horario_trabalho, ativo } = req.body;
    const r = await pool.query(
      `UPDATE agenda_profissionais SET nome=$1,especialidade=$2,tipo_contrato=$3,email=$4,telefone=$5,
       foto_url=$6,comissao_percentual=$7,horario_trabalho=$8,ativo=$9,updated_at=NOW()
       WHERE id=$10 AND establishment_id=$11 RETURNING *`,
      [nome, especialidade||null, tipo_contrato||'CLT', email||null, telefone||null, foto_url||null,
       comissao_percentual||0, horario_trabalho ? JSON.stringify(horario_trabalho) : '{}',
       ativo !== undefined ? ativo : true, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, profissional: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/profissionais/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_profissionais SET ativo=false,updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// SERVIÇOS
// ═══════════════════════════════════════════════════════
router.get('/servicos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { ativo, categoria } = req.query;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_servicos WHERE establishment_id=$1`;
    if (ativo !== undefined) { q += ` AND ativo=$${p.length+1}`; p.push(ativo === 'true'); }
    if (categoria) { q += ` AND categoria=$${p.length+1}`; p.push(categoria); }
    q += ` ORDER BY ordem, nome`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/servicos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, duracao_minutos, preco, comissao_percentual, ordem } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_servicos (establishment_id,nome,descricao,categoria,duracao_minutos,preco,comissao_percentual,ordem)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [eid, nome, descricao||null, categoria||null, duracao_minutos||30, preco||0, comissao_percentual||null, ordem||0]
    );
    res.status(201).json({ success: true, servico: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/servicos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, duracao_minutos, preco, comissao_percentual, ordem, ativo } = req.body;
    const r = await pool.query(
      `UPDATE agenda_servicos SET nome=$1,descricao=$2,categoria=$3,duracao_minutos=$4,preco=$5,
       comissao_percentual=$6,ordem=$7,ativo=$8,updated_at=NOW()
       WHERE id=$9 AND establishment_id=$10 RETURNING *`,
      [nome, descricao||null, categoria||null, duracao_minutos||30, preco||0,
       comissao_percentual||null, ordem||0, ativo !== undefined ? ativo : true, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, servico: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/servicos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_servicos SET ativo=false,updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// AGENDAMENTOS
// ═══════════════════════════════════════════════════════
router.get('/agendamentos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { data, profissional_id, status, limit = 100, offset = 0 } = req.query as Record<string, string>;
    const p: any[] = [eid];
    let q = `SELECT a.*, p.nome AS profissional_nome, s.nome AS servico_nome, NULL AS servico_cor
             FROM agenda_agendamentos a
             LEFT JOIN agenda_profissionais p ON p.id=a.profissional_id
             LEFT JOIN agenda_servicos s ON s.id=a.servico_id
             WHERE a.establishment_id=$1`;
    if (data)            { q += ` AND a.data=$${p.length+1}`;             p.push(data); }
    if (profissional_id) { q += ` AND a.profissional_id=$${p.length+1}`;  p.push(profissional_id); }
    if (status)          { q += ` AND a.status=$${p.length+1}`;           p.push(status); }
    q += ` ORDER BY a.data, a.hora_inicio LIMIT ${Math.min(Number(limit),500)} OFFSET ${Number(offset)}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/agendamentos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, servico_id, user_id, cliente_nome, cliente_telefone, cliente_email,
            data, hora_inicio, hora_fim, status, observacoes, valor_total } = req.body;
    if (!cliente_nome || !data || !hora_inicio) return res.status(400).json({ error: 'cliente_nome, data e hora_inicio são obrigatórios' });
    const r = await pool.query(
      `INSERT INTO agenda_agendamentos
       (establishment_id,profissional_id,servico_id,user_id,cliente_nome,cliente_telefone,cliente_email,
        data,hora_inicio,hora_fim,status,observacoes,valor_total)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [eid, profissional_id||null, servico_id||null, user_id||null,
       cliente_nome, cliente_telefone||null, cliente_email||null,
       data, hora_inicio, hora_fim||null, status||'pendente', observacoes||null, valor_total||0]
    );
    res.status(201).json({ success: true, agendamento: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/agendamentos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, servico_id, cliente_nome, cliente_telefone, cliente_email,
            data, hora_inicio, hora_fim, status, observacoes, valor_total, valor_pago, metodo_pagamento } = req.body;
    const r = await pool.query(
      `UPDATE agenda_agendamentos SET profissional_id=$1,servico_id=$2,cliente_nome=$3,
       cliente_telefone=$4,cliente_email=$5,data=$6,hora_inicio=$7,hora_fim=$8,status=$9,
       observacoes=$10,valor_total=$11,valor_pago=$12,metodo_pagamento=$13,updated_at=NOW()
       WHERE id=$14 AND establishment_id=$15 RETURNING *`,
      [profissional_id||null, servico_id||null, cliente_nome, cliente_telefone||null, cliente_email||null,
       data, hora_inicio, hora_fim||null, status, observacoes||null,
       valor_total||0, valor_pago||0, metodo_pagamento||null, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, agendamento: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Cancela (soft delete via status)
router.delete('/agendamentos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_agendamentos SET status='cancelado',updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// BLOQUEIOS
// ═══════════════════════════════════════════════════════
router.get('/bloqueios', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, data_inicio, data_fim } = req.query as Record<string, string>;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_bloqueios WHERE establishment_id=$1`;
    if (profissional_id) { q += ` AND profissional_id=$${p.length+1}`; p.push(profissional_id); }
    if (data_inicio)     { q += ` AND data_inicio>=$${p.length+1}`;    p.push(data_inicio); }
    if (data_fim)        { q += ` AND data_inicio<=$${p.length+1}`;    p.push(data_fim); }
    q += ` ORDER BY data_inicio`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/bloqueios', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, data_inicio, data_fim, hora_inicio, hora_fim, dia_inteiro, motivo } = req.body;
    if (!data_inicio) return res.status(400).json({ error: 'data_inicio é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_bloqueios (establishment_id,profissional_id,data_inicio,data_fim,hora_inicio,hora_fim,dia_inteiro,motivo)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [eid, profissional_id||null, data_inicio, data_fim||null, hora_inicio||null, hora_fim||null, dia_inteiro||false, motivo||null]
    );
    res.status(201).json({ success: true, bloqueio: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/bloqueios/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`DELETE FROM agenda_bloqueios WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// PRODUTOS
// ═══════════════════════════════════════════════════════
router.get('/produtos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { ativo, categoria } = req.query;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_produtos WHERE establishment_id=$1`;
    if (ativo !== undefined) { q += ` AND ativo=$${p.length+1}`; p.push(ativo === 'true'); }
    if (categoria)           { q += ` AND categoria=$${p.length+1}`; p.push(categoria); }
    q += ` ORDER BY nome`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/produtos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, preco, custo, estoque, estoque_minimo, unidade, imagem_url } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_produtos (establishment_id,nome,descricao,categoria,preco,custo,estoque,estoque_minimo,unidade,imagem_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [eid, nome, descricao||null, categoria||null, preco||0, custo||0, estoque||0, estoque_minimo||0, unidade||'un', imagem_url||null]
    );
    res.status(201).json({ success: true, produto: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/produtos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, preco, custo, estoque, estoque_minimo, unidade, imagem_url, ativo } = req.body;
    const r = await pool.query(
      `UPDATE agenda_produtos SET nome=$1,descricao=$2,categoria=$3,preco=$4,custo=$5,
       estoque=$6,estoque_minimo=$7,unidade=$8,imagem_url=$9,ativo=$10,updated_at=NOW()
       WHERE id=$11 AND establishment_id=$12 RETURNING *`,
      [nome, descricao||null, categoria||null, preco||0, custo||0,
       estoque||0, estoque_minimo||0, unidade||'un', imagem_url||null, ativo !== undefined ? ativo : true,
       req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, produto: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/produtos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_produtos SET ativo=false,updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// VENDAS / CAIXA
// ═══════════════════════════════════════════════════════
router.get('/vendas', async (req, res) => {
  try {
    const eid = estabId(req);
    const { status, limit = 50, offset = 0 } = req.query as Record<string, string>;
    const p: any[] = [eid];
    let q = `SELECT v.*, p.nome AS profissional_nome FROM agenda_vendas v
             LEFT JOIN agenda_profissionais p ON p.id=v.profissional_id
             WHERE v.establishment_id=$1`;
    if (status) { q += ` AND v.status=$${p.length+1}`; p.push(status); }
    q += ` ORDER BY v.created_at DESC LIMIT ${Math.min(Number(limit),200)} OFFSET ${Number(offset)}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/vendas', async (req, res) => {
  try {
    const eid = estabId(req);
    const { agendamento_id, profissional_id, user_id, cliente_nome, itens, subtotal, desconto, total, metodo_pagamento, observacoes } = req.body;
    if (!total) return res.status(400).json({ error: 'total é obrigatório' });
    const itensArr = Array.isArray(itens) ? itens : [];

    // Comissão: soma da comissão dos itens de SERVIÇO vendidos (produtos não
    // geram comissão nesta conta — regra padrão de balcão). Usa o % próprio
    // do serviço quando definido; senão cai no % padrão do profissional.
    let comissaoCalculada = 0;
    const servicoItens = itensArr.filter((i: any) => i?.tipo === 'servico' && i?.id);
    if (profissional_id && servicoItens.length) {
      const profRes = await pool.query(
        `SELECT comissao_percentual FROM agenda_profissionais WHERE id=$1 AND establishment_id=$2`,
        [profissional_id, eid]
      );
      const profPct = Number(profRes.rows[0]?.comissao_percentual) || 0;
      const servIds = servicoItens.map((i: any) => i.id);
      const servRes = await pool.query(
        `SELECT id, comissao_percentual FROM agenda_servicos WHERE id = ANY($1::uuid[]) AND establishment_id=$2`,
        [servIds, eid]
      );
      const servPctMap = new Map(
        servRes.rows.map((s: any) => [String(s.id), s.comissao_percentual != null ? Number(s.comissao_percentual) : null])
      );
      for (const item of servicoItens) {
        const pct = servPctMap.get(String(item.id));
        const efetivo = (pct != null ? pct : profPct) || 0;
        const preco = Number(item.preco) || 0;
        const qtd = Number(item.qtd) || 1;
        comissaoCalculada += (preco * qtd * efetivo) / 100;
      }
    }

    const r = await pool.query(
      `INSERT INTO agenda_vendas (establishment_id,agendamento_id,profissional_id,user_id,cliente_nome,itens,subtotal,desconto,total,metodo_pagamento,observacoes,status,comissao_calculada)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pago',$12) RETURNING *`,
      [eid, agendamento_id||null, profissional_id||null, user_id||null, cliente_nome||null,
       JSON.stringify(itensArr), subtotal||total, desconto||0, total, metodo_pagamento||null, observacoes||null,
       comissaoCalculada.toFixed(2)]
    );
    res.status(201).json({ success: true, venda: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/vendas/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { status, metodo_pagamento, observacoes } = req.body;
    const r = await pool.query(
      `UPDATE agenda_vendas SET status=$1,metodo_pagamento=$2,observacoes=$3,updated_at=NOW()
       WHERE id=$4 AND establishment_id=$5 RETURNING *`,
      [status, metodo_pagamento||null, observacoes||null, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, venda: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// AVALIAÇÕES
// ═══════════════════════════════════════════════════════
router.get('/avaliacoes', async (req, res) => {
  try {
    const eid = estabId(req);
    const { aprovado } = req.query;
    const p: any[] = [eid];
    let q = `SELECT a.*, p.nome AS profissional_nome FROM agenda_avaliacoes a
             LEFT JOIN agenda_profissionais p ON p.id=a.profissional_id
             WHERE a.establishment_id=$1`;
    if (aprovado !== undefined) { q += ` AND a.aprovado=$${p.length+1}`; p.push(aprovado === 'true'); }
    q += ` ORDER BY a.created_at DESC`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/avaliacoes', async (req, res) => {
  try {
    const eid = estabId(req);
    const { agendamento_id, profissional_id, user_id, cliente_nome, nota, comentario } = req.body;
    if (!nota) return res.status(400).json({ error: 'nota é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_avaliacoes (establishment_id,agendamento_id,profissional_id,user_id,cliente_nome,nota,comentario)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [eid, agendamento_id||null, profissional_id||null, user_id||null, cliente_nome||null, nota, comentario||null]
    );
    res.status(201).json({ success: true, avaliacao: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Aprovar/reprovar avaliação
router.patch('/avaliacoes/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { aprovado } = req.body;
    await pool.query(`UPDATE agenda_avaliacoes SET aprovado=$1 WHERE id=$2 AND establishment_id=$3`, [aprovado, req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// FROTA (nicho Rastreamento)
// ═══════════════════════════════════════════════════════
router.get('/frota', async (req, res) => {
  try {
    const eid = estabId(req);
    const { status } = req.query;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_frota WHERE establishment_id=$1`;
    if (status) { q += ` AND status=$${p.length+1}`; p.push(status); }
    q += ` ORDER BY cliente_nome, placa`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Se cliente_id for informado e nome/telefone não vierem preenchidos no
// corpo, busca do cadastro de cliente pra manter os dois em sincronia.
async function resolveClienteDados(eid: string, cliente_id: string | null | undefined, nome?: string, telefone?: string) {
  if (!cliente_id || (nome && telefone)) return { nome: nome || null, telefone: telefone || null };
  const c = await pool.query(`SELECT nome, telefone FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [cliente_id, eid]);
  if (!c.rows.length) return { nome: nome || null, telefone: telefone || null };
  return { nome: nome || c.rows[0].nome, telefone: telefone || c.rows[0].telefone };
}

router.post('/frota', async (req, res) => {
  try {
    const eid = estabId(req);
    const { cliente_nome, cliente_telefone, cliente_id, placa, modelo, ano, cor, imei_rastreador, tracker_phone, data_instalacao, plano_id, status, observacoes } = req.body;
    const dados = await resolveClienteDados(eid, cliente_id, cliente_nome, cliente_telefone);
    const r = await pool.query(
      `INSERT INTO agenda_frota (establishment_id,cliente_nome,cliente_telefone,cliente_id,placa,modelo,ano,cor,imei_rastreador,tracker_phone,data_instalacao,plano_id,status,observacoes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [eid, dados.nome, dados.telefone, cliente_id||null, placa||null, modelo||null, ano||null, cor||null,
       imei_rastreador||null, tracker_phone?.replace(/\D/g,'') || null, data_instalacao||null, plano_id||null, status||'ativo', observacoes||null]
    );
    res.status(201).json({ success: true, veiculo: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/frota/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { cliente_nome, cliente_telefone, cliente_id, placa, modelo, ano, cor, imei_rastreador, tracker_phone, data_instalacao, plano_id, status, observacoes } = req.body;
    const dados = await resolveClienteDados(eid, cliente_id, cliente_nome, cliente_telefone);
    const r = await pool.query(
      `UPDATE agenda_frota SET cliente_nome=$1,cliente_telefone=$2,cliente_id=$3,placa=$4,modelo=$5,ano=$6,cor=$7,
       imei_rastreador=$8,tracker_phone=$9,data_instalacao=$10,plano_id=$11,status=$12,observacoes=$13,updated_at=NOW()
       WHERE id=$14 AND establishment_id=$15 RETURNING *`,
      [dados.nome, dados.telefone, cliente_id||null, placa||null, modelo||null, ano||null, cor||null,
       imei_rastreador||null, tracker_phone?.replace(/\D/g,'') || null, data_instalacao||null, plano_id||null, status||'ativo', observacoes||null,
       req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, veiculo: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/frota/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_frota SET status='inativo',updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/frota/:id/desvincular-cliente — remove o vínculo com o cliente
// SEM tocar nos outros campos do veículo (Fase 14). Diferente de um PUT
// completo em /frota/:id — que reescreve placa/modelo/etc a partir do body
// inteiro — essa rota faz um UPDATE parcial só na coluna cliente_id, pra não
// arriscar apagar dados do veículo num botão de "desvincular" que só devia
// mexer no vínculo.
router.post('/frota/:id/desvincular-cliente', async (req, res) => {
  try {
    const eid = estabId(req);
    const r = await pool.query(
      `UPDATE agenda_frota SET cliente_id=NULL, updated_at=NOW() WHERE id=$1 AND establishment_id=$2 RETURNING *`,
      [req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    res.json({ success: true, veiculo: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// FROTA — Integração GPSWOX (Fase 7, portado do Águia Auto)
// ═══════════════════════════════════════════════════════

// GET /agenda/frota-gpswox-config — status da config (nunca retorna o hash em claro)
router.get('/frota-gpswox-config', async (req, res) => {
  try {
    const eid = estabId(req);
    const cfg = await getGpswoxConfig(eid);
    res.json({ url: cfg.url, configured: isGpswoxConfigured(cfg) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /agenda/frota-gpswox-config — salva credenciais GPSWOX da empresa
router.put('/frota-gpswox-config', async (req, res) => {
  try {
    const eid = estabId(req);
    const { url, api_hash } = req.body || {};
    if (!url || !api_hash) return res.status(400).json({ error: 'url e api_hash são obrigatórios.' });
    await saveGpswoxConfig(eid, url, api_hash);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Fix de produção 46 — extractDeviceImei/extractDeviceSimNumber saíram
// daqui: agora vivem em shared/gpswoxClient.ts (junto com
// extractDeviceGpswoxUserId), corrigidas pra ler de dentro de
// `device.device_data` conforme o handoff do ag-on-track — importadas logo
// abaixo, junto com os outros helpers do GPSWOX.

// POST /agenda/frota-gpswox-sync — casa dispositivos GPSWOX com veículos pelo IMEI
// Body: { dry_run?: boolean }. Sem dry_run (ou dry_run=false), aplica as vinculações.
//
// Fix de produção 42 — antes só vinculava (por IMEI) dispositivos e veículos
// que já existiam dos DOIS lados. O Carlos pediu duas mãos a mais: (1)
// PUXAR pro AguiaON, como veículo novo, todo dispositivo do GPSWOX que não
// tem nenhum veículo cadastrado aqui com aquele IMEI; (2) ENVIAR pro GPSWOX
// (criar o dispositivo lá) todo veículo cadastrado aqui que já tem IMEI
// preenchido mas nunca foi registrado na plataforma. Os três blocos rodam
// juntos, sob o mesmo dry_run — a pré-visualização mostra os três antes de
// aplicar, com um único botão.
router.post('/frota-gpswox-sync', async (req, res) => {
  try {
    const eid = estabId(req);
    const dryRun = req.body?.dry_run !== false && req.body?.dry_run !== undefined
      ? Boolean(req.body.dry_run)
      : true; // padrão seguro: pré-visualiza antes de aplicar

    const devices = await listGpswoxDevices(eid);
    // Fix de produção 43 — log server-side: o Carlos reportou que a
    // sincronização dizia "importado"/"enviado" mas nada aparecia nem aqui
    // nem no GPSWOX depois. Sem acesso a logs de produção daqui, é impossível
    // confirmar de fora se o problema é o establishment_id usado, a resposta
    // do GPSWOX, ou outra coisa — esses logs aparecem no EasyPanel (aba Logs
    // do serviço) e são o que precisamos ler pra achar a causa real.
    console.log(`[frota-gpswox-sync] eid=${eid} dry_run=${dryRun} devices_recebidos=${devices.length}`);
    const veiculos = (await pool.query(
      `SELECT id, placa, cliente_nome, imei_rastreador, gpswox_device_id FROM agenda_frota WHERE establishment_id=$1`,
      [eid]
    )).rows;
    console.log(`[frota-gpswox-sync] veiculos_locais=${veiculos.length} (ids: ${veiculos.map((v: any) => v.id).join(', ') || 'nenhum'})`);

    const porImei = new Map<string, any>();
    for (const v of veiculos) {
      if (v.imei_rastreador) porImei.set(String(v.imei_rastreador).trim(), v);
    }
    const deviceImeisVistos = new Set<string>();

    // Fix de produção 46 — criar dispositivo novo no GPSWOX (mão "enviar")
    // exige um user_id (o cliente dono, dentro do GPSWOX — ver handoff do
    // ag-on-track). A gente não guarda esse id por veículo/cliente hoje;
    // como os dispositivos existentes desta conta pertencem todos ao mesmo
    // usuário GPSWOX (confirmado no log do Fix 43 — mesma conta única), usa
    // o user_id de qualquer dispositivo já cadastrado como referência pros
    // novos. Sem nenhum dispositivo existente, não tem como descobrir.
    let gpswoxUserId: string | null = null;
    for (const d of devices) {
      const uid = extractDeviceGpswoxUserId(d);
      if (uid) { gpswoxUserId = uid; break; }
    }
    console.log(`[frota-gpswox-sync] gpswoxUserId_detectado=${gpswoxUserId}`);

    const matched: any[] = [];
    const unmatched: any[] = [];
    const importados: any[] = [];

    for (const device of devices) {
      const imei = extractDeviceImei(device);
      const deviceId = device.id != null ? String(device.id) : null;
      const nome = device.name || device.title || (deviceId ? `Dispositivo ${deviceId}` : 'Dispositivo');
      if (!deviceId) continue;
      if (imei) deviceImeisVistos.add(imei);

      const veiculo = imei ? porImei.get(imei) : null;
      if (!veiculo) {
        // Ninguém aqui tem esse IMEI cadastrado — vira candidato a importar
        // como veículo novo (placa desconhecida: usa o nome do dispositivo
        // como ponto de partida, o Carlos ajusta depois se precisar).
        unmatched.push({ device_id: deviceId, imei, nome });
        if (!dryRun) {
          const simNumber = extractDeviceSimNumber(device);
          const novo = await pool.query(
            `INSERT INTO agenda_frota (establishment_id, placa, imei_rastreador, gpswox_device_id, tracker_model, tracker_synced_at, tracker_phone, status, observacoes)
             VALUES ($1,$2,$3,$4,$5,NOW(),$6,'ativo',$7) RETURNING id, placa`,
            [eid, nome || null, imei, deviceId, device.device_model || device.model || device.protocol || null, simNumber,
             'Importado automaticamente do GPSWOX pela Sincronização com GPS — confira placa/cliente.']
          );
          console.log(`[frota-gpswox-sync] IMPORTADO veiculo_id=${novo.rows[0].id} placa=${novo.rows[0].placa} eid=${eid} imei=${imei}`);
          importados.push({ veiculo_id: novo.rows[0].id, placa: novo.rows[0].placa, device_id: deviceId, imei, nome });
        } else {
          importados.push({ placa: nome, device_id: deviceId, imei, nome });
        }
        continue;
      }

      const jaVinculado = veiculo.gpswox_device_id === deviceId;
      matched.push({
        veiculo_id: veiculo.id, placa: veiculo.placa, cliente_nome: veiculo.cliente_nome,
        device_id: deviceId, imei, nome, acao: jaVinculado ? 'já vinculado' : 'vincular',
      });

      if (!dryRun && !jaVinculado) {
        const simNumber = extractDeviceSimNumber(device);
        await pool.query(
          `UPDATE agenda_frota
           SET gpswox_device_id=$1, tracker_model=$2, tracker_synced_at=NOW(),
               tracker_phone=COALESCE($3, tracker_phone), updated_at=NOW()
           WHERE id=$4`,
          [deviceId, device.device_model || device.model || device.protocol || null, simNumber, veiculo.id]
        );
      }
    }

    // Mão contrária: veículos cadastrados aqui, com IMEI preenchido, que não
    // batem com NENHUM dispositivo do GPSWOX (nem por IMEI, nem já vinculado
    // por gpswox_device_id) — esses nunca foram criados na plataforma.
    const enviados: any[] = [];
    for (const v of veiculos) {
      if (!v.imei_rastreador) continue;
      const imei = String(v.imei_rastreador).trim();
      if (!imei || v.gpswox_device_id || deviceImeisVistos.has(imei)) continue;

      if (!dryRun) {
        if (!gpswoxUserId) {
          enviados.push({
            veiculo_id: v.id, placa: v.placa, imei, device_id: null,
            erro: 'Não foi possível determinar o usuário do GPSWOX (nenhum dispositivo existente nessa conta pra usar de referência) — crie ao menos 1 dispositivo manualmente pelo painel GPSWOX primeiro, depois tente sincronizar de novo.',
          });
          continue;
        }
        try {
          const criado = await createGpswoxDevice(eid, { name: v.placa || v.cliente_nome || `Veículo ${v.id}`, imei, userId: gpswoxUserId });
          // Fix de produção 46 — loga a resposta CRUA do GPSWOX pro
          // edit_device (endpoint/payload corrigidos neste mesmo fix, a
          // partir do handoff do ag-on-track).
          console.log(`[frota-gpswox-sync] ENVIAR veiculo_id=${v.id} placa=${v.placa} imei=${imei} user_id=${gpswoxUserId} resposta_gpswox=${JSON.stringify(criado.raw).slice(0, 500)}`);
          if (criado.id) {
            await pool.query(
              `UPDATE agenda_frota SET gpswox_device_id=$1, tracker_synced_at=NOW(), updated_at=NOW() WHERE id=$2`,
              [criado.id, v.id]
            );
          }
          enviados.push({
            veiculo_id: v.id, placa: v.placa, imei, device_id: criado.id,
            erro: criado.id ? null : 'GPSWOX não retornou o id do dispositivo criado — confira manualmente no painel GPSWOX.',
            resposta_gpswox: criado.raw,
          });
        } catch (e: any) {
          console.log(`[frota-gpswox-sync] ENVIAR FALHOU veiculo_id=${v.id} placa=${v.placa} imei=${imei} erro=${e.message}`);
          enviados.push({ veiculo_id: v.id, placa: v.placa, imei, device_id: null, erro: e.message });
        }
      } else {
        enviados.push({ veiculo_id: v.id, placa: v.placa, imei, device_id: null, erro: null });
      }
    }

    res.json({
      dry_run: dryRun,
      establishment_id_usado: eid,
      total_dispositivos: devices.length,
      vinculados: matched.length,
      sem_correspondencia: unmatched.length,
      matched,
      unmatched,
      importados,
      total_importados: importados.length,
      enviados,
      total_enviados: enviados.length,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/frota/:id/localizacao — posição atual via GPSWOX
router.get('/frota/:id/localizacao', async (req, res) => {
  try {
    const eid = estabId(req);
    const veh = await pool.query(
      `SELECT gpswox_device_id FROM agenda_frota WHERE id=$1 AND establishment_id=$2`,
      [req.params.id, eid]
    );
    if (!veh.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    if (!veh.rows[0].gpswox_device_id) return res.status(422).json({ error: 'Veículo sem dispositivo GPSWOX vinculado. Use "Sincronizar com GPS" ou cadastre o IMEI.' });

    const location = await getDeviceLocation(eid, veh.rows[0].gpswox_device_id);
    res.json(location);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// FROTA — Cobrança de mensalidade (Fase 7, portado do Águia Auto)
// ═══════════════════════════════════════════════════════
//
// Fix de produção 32 — DESATIVADA. O Carlos confirmou que a Frota nunca
// deveria emitir fatura: ela é só sincronização com o GPSWOX (rastreamento
// de verdade) e o vínculo veículo↔cliente; cobrança sempre foi pra ser coisa
// de PESSOA, não de veículo. Cobrança de cliente já existe de sobra
// (recorrência mensal fixa e cobrança avulsa, ambas em /clientes/:id/...).
// Rota comentada (não apagada) por cautela, mesmo padrão do /veiculos em
// server.ts — se algo externo ainda bater aqui, dá pra rastrear rápido; o
// botão que chamava essa rota (cobrarFrota, loja.html) já foi removido.
//
// router.post('/frota/:id/cobrar', async (req, res) => {
//   try {
//     const eid = estabId(req);
//     const veh = await pool.query(
//       `SELECT f.*, s.preco AS plano_preco, s.nome AS plano_nome
//        FROM agenda_frota f
//        LEFT JOIN agenda_servicos s ON s.id = f.plano_id
//        WHERE f.id=$1 AND f.establishment_id=$2`,
//       [req.params.id, eid]
//     );
//     if (!veh.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
//     const v = veh.rows[0];
//     if (!v.plano_id || !v.plano_preco) return res.status(422).json({ error: 'Veículo sem plano de mensalidade vinculado.' });
//
//     const competencia = new Date().toISOString().slice(0, 7); // YYYY-MM
//
//     let charge = (await pool.query(
//       `SELECT * FROM agenda_frota_charges WHERE agenda_frota_id=$1 AND competencia=$2`,
//       [v.id, competencia]
//     )).rows[0];
//
//     if (!charge) {
//       charge = (await pool.query(
//         `INSERT INTO agenda_frota_charges (agenda_frota_id, establishment_id, competencia, valor)
//          VALUES ($1,$2,$3,$4) RETURNING *`,
//         [v.id, eid, competencia, v.plano_preco]
//       )).rows[0];
//     } else if (charge.status === 'paid') {
//       return res.json({ already_paid: true, charge });
//     }
//
//     const pix = await generateFrotaPix(eid, charge.id, parseFloat(v.plano_preco), v.cliente_nome || 'Cliente', undefined);
//     if (!pix) return res.status(422).json({ error: 'Nenhum método de pagamento configurado (Asaas, Mercado Pago ou PIX manual). Configure em Configurações → Pagamentos.' });
//
//     await pool.query(
//       `UPDATE agenda_frota_charges SET pix_code=$1, pix_provider=$2, asaas_payment_id=$3 WHERE id=$4`,
//       [pix.code, pix.provider, pix.provider_payment_id || null, charge.id]
//     );
//
//     res.json({ charge, pix, cliente_telefone: v.cliente_telefone, cliente_nome: v.cliente_nome, plano_nome: v.plano_nome });
//   } catch (err: any) { res.status(500).json({ error: err.message }); }
// });

// GET /agenda/frota-cobrancas — histórico de cobranças da empresa.
//
// Fix de produção 17: até aqui essa lista só trazia cobrança por VEÍCULO
// (agenda_frota_charges — geradas por gerarCobrancasDoDia). Cobrança no nível
// do CLIENTE (agenda_cliente_asaas_cache, tipo='payment') — tanto a
// recorrência mensal configurada em Clientes → "Recorrência" quanto a
// cobrança avulsa do botão "Cobrar" — nunca aparecia aqui, só dentro do
// histórico de cada cliente (Clientes → "Ver cobranças"). O Carlos reportou
// exatamente isso: criou uma recorrência, ela "sumia" da seção Cobranças.
// Agora a rota junta as duas fontes, normalizando pro mesmo formato que o
// front já espera (status em pending/paid/failed — a tabela de cliente guarda
// o status cru do Asaas, tipo RECEIVED/OVERDUE/PENDING etc., que precisa virar
// esse vocabulário).
router.get('/frota-cobrancas', async (req, res) => {
  try {
    const eid = estabId(req);

    const frotaRes = await pool.query(
      `SELECT c.id, c.competencia, c.valor, c.status, c.paid_at, c.created_at,
              f.placa, f.cliente_nome, f.cliente_telefone
       FROM agenda_frota_charges c
       JOIN agenda_frota f ON f.id = c.agenda_frota_id
       WHERE c.establishment_id=$1`,
      [eid]
    );

    const clienteRes = await pool.query(
      `SELECT ac.id, ac.cliente_id, ac.competencia, ac.valor, ac.status, ac.vencimento, ac.baixado_em, ac.synced_at,
              cli.nome AS cliente_nome, cli.telefone AS cliente_telefone
       FROM agenda_cliente_asaas_cache ac
       JOIN agenda_clientes cli ON cli.id = ac.cliente_id
       WHERE ac.establishment_id=$1 AND ac.tipo='payment'`,
      [eid]
    );

    const PAGO = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
    const FALHOU = new Set(['OVERDUE', 'CANCELLED', 'REFUNDED', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'REFUND_REQUESTED']);
    const normalizarStatus = (s: string) => (PAGO.has(s) ? 'paid' : FALHOU.has(s) ? 'failed' : 'pending');

    const frota = frotaRes.rows.map(c => ({
      id: c.id, tipo: 'frota', competencia: c.competencia, placa: c.placa,
      cliente_nome: c.cliente_nome, cliente_telefone: c.cliente_telefone,
      valor: c.valor, status: c.status, paid_at: c.paid_at,
      _sort: c.created_at,
    }));

    const clientes = clienteRes.rows.map(c => ({
      id: c.id, tipo: 'cliente', cliente_id: c.cliente_id, competencia: c.competencia, placa: null,
      cliente_nome: c.cliente_nome, cliente_telefone: c.cliente_telefone,
      valor: c.valor, status: normalizarStatus(c.status), paid_at: c.baixado_em || null,
      _sort: c.baixado_em || c.synced_at,
    }));

    const rows = [...frota, ...clientes]
      .sort((a, b) => new Date(b._sort).getTime() - new Date(a._sort).getTime())
      .slice(0, 200)
      .map(({ _sort, ...rest }) => rest);

    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// FROTA — Comandos remotos, histórico, compartilhamento (Fase 8)
// ═══════════════════════════════════════════════════════

async function getVeiculoComDevice(eid: string, id: string) {
  const r = await pool.query(
    `SELECT id, placa, cliente_nome, cliente_telefone, gpswox_device_id FROM agenda_frota WHERE id=$1 AND establishment_id=$2`,
    [id, eid]
  );
  if (!r.rows.length) return null;
  return r.rows[0];
}

// Mapa de comandos: tipo GPSWOX (4G) + código SMS de fallback direto pro chip
// do rastreador — portado de vehicle-commands.js do Águia Auto.
const FROTA_COMMAND_MAP: Record<string, { gpswoxType: string; smsCode: string; label: string }> = {
  bloquear:    { gpswoxType: 'engine_stop',    smsCode: 'RELAY,1#', label: 'Bloquear motor' },
  desbloquear: { gpswoxType: 'engine_resume',  smsCode: 'RELAY,0#', label: 'Desbloquear motor' },
  atualizar:   { gpswoxType: 'position_single', smsCode: 'WHERE#',  label: 'Atualizar localização' },
};

// POST /agenda/frota/:id/comando — body: { action: 'bloquear' | 'desbloquear' | 'atualizar' }
// Tenta primeiro via GPSWOX (4G); se falhar por motivo de rede/gateway (não por
// erro "lógico" tipo duplicado) e o veículo tiver o telefone do chip cadastrado,
// cai pro SMS direto no rastreador — mesmo comportamento do Águia Auto.
router.post('/frota/:id/comando', async (req, res) => {
  try {
    const eid = estabId(req);
    const veh = await getVeiculoComDevice(eid, req.params.id);
    if (!veh) return res.status(404).json({ error: 'Veículo não encontrado.' });
    if (!veh.gpswox_device_id) return res.status(422).json({ error: 'Veículo sem dispositivo GPSWOX vinculado.' });

    const action = req.body?.action;
    const command = FROTA_COMMAND_MAP[action];
    if (!command) {
      return res.status(400).json({ error: `action deve ser: ${Object.keys(FROTA_COMMAND_MAP).join(', ')}.` });
    }

    let channel: '4g' | 'sms' = '4g';
    let failover = false;
    let status = 'sent';
    let errorMessage: string | null = null;

    try {
      await sendGpswoxCommand(eid, veh.gpswox_device_id, command.gpswoxType);
    } catch (gpsErr: any) {
      if (!isGpsFailoverEligible(gpsErr)) {
        status = 'failed';
        errorMessage = gpsErr.message;
      } else if (!veh.tracker_phone) {
        status = 'failed';
        errorMessage = `Comando 4G indisponível (${gpsErr.message}) e veículo sem telefone do chip cadastrado para SMS.`;
        failover = true;
      } else {
        channel = 'sms';
        failover = true;
        try {
          await sendSms(veh.tracker_phone, command.smsCode, { establishmentId: eid, action: `frota.comando.${action}` });
        } catch (smsErr: any) {
          status = 'failed';
          errorMessage = `4G falhou (${gpsErr.message}) e SMS também falhou: ${smsErr.message}`;
        }
      }
    }

    await pool.query(
      `INSERT INTO agenda_frota_commands (agenda_frota_id, establishment_id, action, status, error_message, channel, failover)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [veh.id, eid, action, status, errorMessage, channel, failover]
    );

    if (status === 'failed') return res.status(502).json({ error: errorMessage || 'Falha ao enviar comando.' });
    res.json({ success: true, action, status, channel, failover, label: command.label });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/frota/:id/comandos — histórico de comandos do veículo
router.get('/frota/:id/comandos', async (req, res) => {
  try {
    const eid = estabId(req);
    const result = await pool.query(
      `SELECT * FROM agenda_frota_commands WHERE agenda_frota_id=$1 AND establishment_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id, eid]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/frota/:id/historico?from=...&to=... — trajeto no período
router.get('/frota/:id/historico', async (req, res) => {
  try {
    const eid = estabId(req);
    const veh = await getVeiculoComDevice(eid, req.params.id);
    if (!veh) return res.status(404).json({ error: 'Veículo não encontrado.' });
    if (!veh.gpswox_device_id) return res.status(422).json({ error: 'Veículo sem dispositivo GPSWOX vinculado.' });

    const from = (req.query.from as string) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = (req.query.to as string) || new Date().toISOString();

    const pontos = await getHistory(eid, veh.gpswox_device_id, from, to);
    res.json({ from, to, pontos });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/frota/:id/compartilhar — body: { duration_minutes? }
router.post('/frota/:id/compartilhar', async (req, res) => {
  try {
    const eid = estabId(req);
    const veh = await getVeiculoComDevice(eid, req.params.id);
    if (!veh) return res.status(404).json({ error: 'Veículo não encontrado.' });
    if (!veh.gpswox_device_id) return res.status(422).json({ error: 'Veículo sem dispositivo GPSWOX vinculado.' });

    const duration = parseInt(req.body?.duration_minutes, 10) || 60;
    const result = await createSharing(eid, veh.gpswox_device_id, duration);

    await pool.query(
      `INSERT INTO agenda_frota_shares (agenda_frota_id, establishment_id, link, duration_minutes)
       VALUES ($1,$2,$3,$4)`,
      [veh.id, eid, result.link, duration]
    );

    res.json({ link: result.link, duration_minutes: duration, cliente_telefone: veh.cliente_telefone, cliente_nome: veh.cliente_nome });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// FROTA — Cercas eletrônicas (geofences, por conta GPSWOX da empresa)
// ═══════════════════════════════════════════════════════

// GET /agenda/frota-cercas
router.get('/frota-cercas', async (req, res) => {
  try {
    const eid = estabId(req);
    const cercas = await listGeofences(eid);
    res.json(cercas);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/frota-cercas — body: { nome, latitude, longitude, raio_metros, veiculo_id? }
router.post('/frota-cercas', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, latitude, longitude, raio_metros, veiculo_id } = req.body || {};
    if (!nome || latitude == null || longitude == null || !raio_metros) {
      return res.status(400).json({ error: 'nome, latitude, longitude e raio_metros são obrigatórios.' });
    }

    let deviceId: string | undefined;
    if (veiculo_id) {
      const veh = await getVeiculoComDevice(eid, veiculo_id);
      if (veh?.gpswox_device_id) deviceId = veh.gpswox_device_id;
    }

    const result = await addGeofence(eid, { nome, latitude: parseFloat(latitude), longitude: parseFloat(longitude), raioMetros: parseInt(raio_metros, 10), deviceId });
    res.status(201).json({ success: true, raw: result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /agenda/frota-cercas/:geofenceId
router.delete('/frota-cercas/:geofenceId', async (req, res) => {
  try {
    const eid = estabId(req);
    await deleteGeofence(eid, req.params.geofenceId);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// CRM — Notas por veículo/cliente, funil de leads, alertas (Fase 11)
// ═══════════════════════════════════════════════════════

// GET /agenda/frota/:id/notas — timeline de notas do veículo/cliente
router.get('/frota/:id/notas', async (req, res) => {
  try {
    const eid = estabId(req);
    const veh = await pool.query(`SELECT id FROM agenda_frota WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!veh.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    const r = await pool.query(
      `SELECT * FROM agenda_frota_notes WHERE agenda_frota_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/frota/:id/notas — adiciona nota ao histórico de contato
router.post('/frota/:id/notas', async (req, res) => {
  try {
    const eid = estabId(req);
    const { texto, autor_nome } = req.body;
    if (!texto?.trim()) return res.status(400).json({ error: 'texto é obrigatório.' });
    const veh = await pool.query(`SELECT id FROM agenda_frota WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!veh.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    const r = await pool.query(
      `INSERT INTO agenda_frota_notes (agenda_frota_id, establishment_id, texto, autor_nome)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, eid, texto.trim(), autor_nome || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /agenda/frota-notas/:noteId
router.delete('/frota-notas/:noteId', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`DELETE FROM agenda_frota_notes WHERE id=$1 AND establishment_id=$2`, [req.params.noteId, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/frota-leads — funil de leads (opcional: ?etapa=)
router.get('/frota-leads', async (req, res) => {
  try {
    const eid = estabId(req);
    const { etapa } = req.query as Record<string, string>;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_frota_leads WHERE establishment_id=$1`;
    if (etapa) { q += ` AND etapa=$${p.length + 1}`; p.push(etapa); }
    q += ` ORDER BY created_at DESC`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/frota-leads — cria lead
router.post('/frota-leads', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, telefone, veiculo_info, valor_estimado, observacoes, etapa } = req.body;
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório.' });
    const r = await pool.query(
      `INSERT INTO agenda_frota_leads (establishment_id, nome, telefone, veiculo_info, valor_estimado, observacoes, etapa)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'novo_contato')) RETURNING *`,
      [eid, nome.trim(), telefone || null, veiculo_info || null, valor_estimado || null, observacoes || null, etapa || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /agenda/frota-leads/:id — atualiza dados/etapa
router.put('/frota-leads/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, telefone, veiculo_info, valor_estimado, observacoes, etapa } = req.body;
    const r = await pool.query(
      `UPDATE agenda_frota_leads SET
         nome=COALESCE($1,nome), telefone=$2, veiculo_info=$3, valor_estimado=$4,
         observacoes=$5, etapa=COALESCE($6,etapa), updated_at=NOW()
       WHERE id=$7 AND establishment_id=$8 RETURNING *`,
      [nome || null, telefone || null, veiculo_info || null, valor_estimado || null,
       observacoes || null, etapa || null, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.json(r.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /agenda/frota-leads/:id
router.delete('/frota-leads/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`DELETE FROM agenda_frota_leads WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/frota-leads/:id/converter — vira veículo/cliente real (agenda_frota)
router.post('/frota-leads/:id/converter', async (req, res) => {
  try {
    const eid = estabId(req);
    const leadRes = await pool.query(`SELECT * FROM agenda_frota_leads WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = leadRes.rows[0];

    const vehRes = await pool.query(
      `INSERT INTO agenda_frota (establishment_id, cliente_nome, cliente_telefone, observacoes, status)
       VALUES ($1,$2,$3,$4,'ativo') RETURNING *`,
      [eid, lead.nome, lead.telefone || null,
       [lead.veiculo_info, lead.observacoes].filter(Boolean).join(' — ') || null]
    );
    const veiculo = vehRes.rows[0];

    await pool.query(
      `UPDATE agenda_frota_leads SET etapa='instalado', convertido_frota_id=$1, updated_at=NOW() WHERE id=$2`,
      [veiculo.id, lead.id]
    );

    res.json({ success: true, veiculo });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/frota-alertas — clientes vencendo (cobrança próxima/pendente) e sem plano vinculado
router.get('/frota-alertas', async (req, res) => {
  try {
    const eid = estabId(req);
    const competencia = new Date().toISOString().slice(0, 7);

    const semPlano = await pool.query(
      `SELECT id, placa, cliente_nome, cliente_telefone
       FROM agenda_frota
       WHERE establishment_id=$1 AND status='ativo' AND plano_id IS NULL
       ORDER BY created_at DESC LIMIT 50`,
      [eid]
    );

    // "Vencendo": veículo ativo com plano, cuja cobrança da competência atual
    // ainda não existe ou existe mas não foi paga (pending/failed).
    const vencendo = await pool.query(
      `SELECT f.id, f.placa, f.cliente_nome, f.cliente_telefone, s.nome AS plano_nome, s.preco AS plano_preco,
              c.status AS cobranca_status, c.id AS cobranca_id
       FROM agenda_frota f
       JOIN agenda_servicos s ON s.id = f.plano_id
       LEFT JOIN agenda_frota_charges c ON c.agenda_frota_id = f.id AND c.competencia = $2
       WHERE f.establishment_id=$1 AND f.status IN ('ativo','inadimplente') AND f.plano_id IS NOT NULL
         AND (c.id IS NULL OR c.status != 'paid')
       ORDER BY f.status DESC, f.cliente_nome ASC LIMIT 50`,
      [eid, competencia]
    );

    res.json({ vencendo: vencendo.rows, sem_plano: semPlano.rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// CLIENTES (Rastreamento) — cadastro próprio + import da base Asaas (Fase 12)
// ═══════════════════════════════════════════════════════

// GET /agenda/clientes — lista com contagem de veículos vinculados
router.get('/clientes', async (req, res) => {
  try {
    const eid = estabId(req);
    const r = await pool.query(
      `SELECT c.*, COUNT(f.id)::int AS veiculos_count
       FROM agenda_clientes c
       LEFT JOIN agenda_frota f ON f.cliente_id = c.id
       WHERE c.establishment_id=$1
       GROUP BY c.id
       ORDER BY c.nome ASC`,
      [eid]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Fase 14 — acha (ou cria) um usuário CLIENT pra esse cliente conseguir logar
// pelo /login unificado que já existe. Só vincula se não houver conflito com
// uma conta de outro papel (LOJISTA/SUPERADMIN/funcionário) já usando o mesmo
// telefone/e-mail — nesse caso não mexe, o cliente segue funcionando
// normalmente no painel, só não ganha login (evita "roubar" a conta de
// alguém que já era lojista ou funcionário com o mesmo contato).
export async function findOrCreateClienteUser(nome: string, telefone?: string | null, email?: string | null): Promise<string | null> {
  const clean = telefone?.replace(/\D/g, '') || null;
  const emailLow = email?.toLowerCase().trim() || null;
  if (!clean && !emailLow) return null;
  try {
    const existing = await pool.query(
      `SELECT id, auth_level FROM users WHERE (whatsapp=$1 AND $1 IS NOT NULL) OR (lower(email)=$2 AND $2 IS NOT NULL) LIMIT 1`,
      [clean, emailLow]
    );
    if (existing.rows.length) {
      const u = existing.rows[0];
      return (u.auth_level === 'CLIENT' || u.auth_level === 'LEAD' || u.auth_level === 'REGISTERED') ? u.id : null;
    }
    const created = await pool.query(
      `INSERT INTO users (full_name, whatsapp, email, auth_level, is_confirmed) VALUES ($1,$2,$3,'CLIENT',true) RETURNING id`,
      [nome, clean, emailLow]
    );
    return created.rows[0].id;
  } catch (e: any) {
    console.warn('[clientes] findOrCreateClienteUser falhou (best-effort):', e.message);
    return null;
  }
}

// POST /agenda/clientes — cria cliente manual; tenta criar também no Asaas
// (best-effort: se a empresa não tiver Asaas configurado ou a chamada falhar,
// o cliente ainda é criado localmente sem asaas_customer_id).
router.post('/clientes', async (req, res) => {
  try {
    const eid = estabId(req);
    // Fix de produção 32 — data de nascimento e contato de emergência (nome+
    // telefone) já existiam no formulário de lead da landing (Fix 10), mas o
    // cadastro manual rápido de cliente (esse aqui) nunca coletava — o Carlos
    // pediu pra igualar.
    const { nome, telefone, email, cpf_cnpj, observacoes, data_nascimento, contato_emergencia_nome, contato_emergencia_telefone } = req.body;
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório.' });

    let asaasCustomerId: string | null = null;
    try {
      const created = await createAsaasCustomer(eid, { name: nome.trim(), phone: telefone, email, cpfCnpj: cpf_cnpj });
      asaasCustomerId = created?.id || null;
    } catch (asaasErr: any) {
      console.warn(`[clientes] não foi possível criar no Asaas (${asaasErr.message}) — seguindo só local.`);
    }

    const userId = await findOrCreateClienteUser(nome.trim(), telefone, email);

    const r = await pool.query(
      `INSERT INTO agenda_clientes
         (establishment_id, nome, telefone, email, cpf_cnpj, asaas_customer_id, observacoes, origem, user_id,
          data_nascimento, contato_emergencia_nome, contato_emergencia_telefone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11) RETURNING *`,
      [eid, nome.trim(), telefone || null, email || null, cpf_cnpj || null, asaasCustomerId, observacoes || null, userId,
       data_nascimento || null, contato_emergencia_nome || null, contato_emergencia_telefone || null]
    );
    res.status(201).json({ ...r.rows[0], asaas_sincronizado: !!asaasCustomerId, login_disponivel: !!userId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /agenda/clientes/:id
router.put('/clientes/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, telefone, email, cpf_cnpj, observacoes, data_nascimento, contato_emergencia_nome, contato_emergencia_telefone } = req.body;

    const atual = await pool.query(`SELECT nome, user_id FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!atual.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    // Se ainda não tinha login vinculado e agora tem telefone/e-mail, tenta vincular.
    let userId = atual.rows[0].user_id;
    if (!userId && (telefone || email)) {
      userId = await findOrCreateClienteUser(nome || atual.rows[0].nome, telefone, email);
    }

    const r = await pool.query(
      `UPDATE agenda_clientes SET nome=COALESCE($1,nome), telefone=$2, email=$3, cpf_cnpj=$4, observacoes=$5, user_id=$6,
         data_nascimento=$7, contato_emergencia_nome=$8, contato_emergencia_telefone=$9, updated_at=NOW()
       WHERE id=$10 AND establishment_id=$11 RETURNING *`,
      [nome || null, telefone || null, email || null, cpf_cnpj || null, observacoes || null, userId,
       data_nascimento || null, contato_emergencia_nome || null, contato_emergencia_telefone || null, req.params.id, eid]
    );
    res.json(r.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /agenda/clientes/:id/recorrencia — liga/desliga e configura a
// mensalidade fixa do cliente (Fase 14), separado do PUT genérico acima pra
// não misturar dados cadastrais com configuração financeira.
//
// Fix de produção 32 — antes disso, ativar a recorrência só AGENDAVA: a
// primeira cobrança de verdade (PIX no Asaas + aviso por WhatsApp) só saía
// no dia configurado, via job diário (gerarCobrancasRecorrentesClientes,
// trackingBillingJob.ts) — por isso a seção "Cobranças" ficava vazia na hora
// de salvar, e o Carlos achou que parecia quebrado. O Carlos confirmou que
// prefere gerar a 1ª cobrança JÁ, na hora de ativar (as próximas continuam
// saindo automaticamente todo mês pelo job de sempre). Só dispara nessa
// transição desativado→ativado — só editar valor/dia/descrição com a
// recorrência já ativa não gera cobrança nova (evitaria cobrar 2x no mesmo
// mês sem querer; o `ON CONFLICT (cliente_id, competencia)` do job também
// protege contra duplicidade, mas aqui nem chega a tentar).
router.put('/clientes/:id/recorrencia', async (req, res) => {
  try {
    const eid = estabId(req);
    const { recorrencia_ativa, valor_recorrente, dia_cobranca_recorrente, descricao_recorrente } = req.body;
    if (recorrencia_ativa) {
      if (!valor_recorrente || Number(valor_recorrente) <= 0) return res.status(400).json({ error: 'Informe um valor válido pra ativar a recorrência.' });
      if (!dia_cobranca_recorrente || dia_cobranca_recorrente < 1 || dia_cobranca_recorrente > 28) return res.status(400).json({ error: 'Dia de cobrança deve ser entre 1 e 28.' });
    }

    const antes = await pool.query(`SELECT recorrencia_ativa FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!antes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const estavaAtiva = !!antes.rows[0].recorrencia_ativa;

    const r = await pool.query(
      `UPDATE agenda_clientes SET
         recorrencia_ativa=$1, valor_recorrente=$2, dia_cobranca_recorrente=$3, descricao_recorrente=$4, updated_at=NOW()
       WHERE id=$5 AND establishment_id=$6 RETURNING *`,
      [!!recorrencia_ativa, valor_recorrente || null, dia_cobranca_recorrente || null, descricao_recorrente || null, req.params.id, eid]
    );
    let cliente = r.rows[0];
    let primeiraCobranca: any = null;

    if (recorrencia_ativa && !estavaAtiva) {
      try {
        if (!cliente.asaas_customer_id) {
          const created = await createAsaasCustomer(eid, { name: cliente.nome, phone: cliente.telefone, email: cliente.email, cpfCnpj: cliente.cpf_cnpj });
          await pool.query(`UPDATE agenda_clientes SET asaas_customer_id=$1, updated_at=NOW() WHERE id=$2`, [created.id, cliente.id]);
          cliente = { ...cliente, asaas_customer_id: created.id };
        }

        const { payment, pixPayload } = await createAsaasPixCharge(eid, {
          customerId: cliente.asaas_customer_id,
          value: Number(valor_recorrente),
          description: descricao_recorrente || `Mensalidade — ${cliente.nome}`,
        });

        const competencia = new Date().toISOString().slice(0, 7); // YYYY-MM
        const vaiAvisar = !!(cliente.telefone && (pixPayload || payment.invoiceUrl));
        const inserted = await pool.query(
          `INSERT INTO agenda_cliente_asaas_cache
             (cliente_id, establishment_id, tipo, asaas_id, valor, status, vencimento, descricao, invoice_url, pix_payload, competencia, lembrete_enviado, invoice_number)
           VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (cliente_id, competencia) WHERE competencia IS NOT NULL DO NOTHING
           RETURNING *`,
          [cliente.id, eid, payment.id, payment.value, payment.status, payment.dueDate, payment.description || null,
           payment.invoiceUrl || null, pixPayload || null, competencia, vaiAvisar, payment.invoiceNumber || null]
        );
        primeiraCobranca = inserted.rows[0] || null;

        if (vaiAvisar) {
          const estRow = await pool.query(`SELECT business_config FROM establishments WHERE id=$1`, [eid]);
          const bc = estRow.rows[0]?.business_config || {};
          const vencimentoLabel = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
          const dados: DadosMensagemCobranca = {
            nome: cliente.nome, valor: Number(valor_recorrente), descricao: descricao_recorrente,
            vencimentoLabel, faturaNumero: payment.invoiceNumber, pixPayload, invoiceUrl: payment.invoiceUrl,
          };
          const msgs = montarMensagensCobranca(bc.mensagem_cobranca_template, dados, !!bc.cobranca_pix_separado);
          for (let i = 0; i < msgs.length; i++) {
            if (i > 0) await new Promise(resolve => setTimeout(resolve, 1500));
            await sendWhatsAppMessage(eid, cliente.telefone, msgs[i]).catch(() => {});
          }
        }
      } catch (cobrancaErr: any) {
        // Recorrência já foi ativada e salva — só a 1ª cobrança falhou (ex:
        // Asaas não configurado). Não desfaz a ativação: as próximas
        // tentativas continuam saindo pelo job diário normalmente.
        console.error(`[clientes] falha ao gerar 1ª cobrança da recorrência (cliente ${cliente.id}):`, cobrancaErr.message);
        return res.json({ ...cliente, aviso_1a_cobranca: `Recorrência ativada, mas a 1ª cobrança falhou: ${cobrancaErr.message}. A próxima tentativa será automática, no dia configurado.` });
      }
    }

    res.json({ ...cliente, primeira_cobranca: primeiraCobranca });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// Termo de Adesão do cliente (Fix de produção 21) — pedido do Carlos: depois
// que um lead da landing vira cliente (POST /admin|lojista/landing-leads/:id/
// converter, em landings.ts), o Termo de Adesão que ele assinou só dava pra
// ver/baixar de volta lá na tela de Leads. Como o lead "some" da lista de
// leads depois de convertido (na prática ele agora é procurado em Clientes,
// não mais em Leads), faz sentido também poder baixar e reenviar o termo
// direto do cadastro do cliente — inclusive serve de forma de teste: se o
// reenvio manual aqui funcionar, confirma que o SMTP e o texto do termo estão
// OK, isolado do fluxo automático do aceite.
//
// O vínculo entre cliente e o termo que ele assinou é `landing_leads.
// cliente_id` (preenchido no momento da conversão) — um cliente pode não ter
// nenhum lead vinculado (se foi cadastrado manualmente, sem passar pela
// landing), então essas rotas tratam esse caso como 404 "sem termo", não erro.
// ─────────────────────────────────────────────────────────────

async function buscarLeadDoCliente(clienteId: string) {
  const r = await pool.query(
    `SELECT * FROM landing_leads WHERE cliente_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [clienteId]
  );
  return r.rows[0] || null;
}

// GET /agenda/clientes/:id/termo-adesao — dados pro botão "Baixar Contrato"
// no cadastro do cliente (o front monta a página/print a partir disso, mesma
// técnica já usada na tela de Leads).
router.get('/clientes/:id/termo-adesao', async (req, res) => {
  try {
    const eid = estabId(req);
    const cliente = await pool.query(`SELECT id, nome FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const lead = await buscarLeadDoCliente(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Esse cliente não veio de um lead da landing — não tem termo de adesão pra baixar.' });

    const bp = listBlueprints().find((b: any) => b.slug === lead.vertical_slug);
    res.json({
      nome: cliente.rows[0].nome,
      empresa: lead.empresa,
      plano_nome: lead.plano_nome,
      modulo_label: bp?.label || lead.vertical_slug,
      contrato_texto: lead.contrato_texto,
      aceite_nome: lead.aceite_nome,
      aceite_cpf: lead.aceite_cpf,
      aceite_ip: lead.aceite_ip,
      aceite_user_agent: lead.aceite_user_agent,
      aceite_em: lead.aceite_em,
      email_termo_enviado: lead.email_termo_enviado,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/clientes/:id/termo-adesao/reenviar-email — botão "Reenviar por
// E-mail" no cadastro do cliente. Usa o e-mail ATUAL do cadastro do cliente
// (não o que estava no lead na hora — pode ter sido corrigido depois), mas o
// texto do termo continua sendo o que foi de fato aceito.
router.post('/clientes/:id/termo-adesao/reenviar-email', async (req, res) => {
  try {
    const eid = estabId(req);
    const clienteRes = await pool.query(`SELECT * FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!clienteRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cliente = clienteRes.rows[0];
    if (!cliente.email) return res.status(422).json({ error: 'Esse cliente não tem e-mail cadastrado.' });

    const lead = await buscarLeadDoCliente(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Esse cliente não veio de um lead da landing — não tem termo de adesão pra reenviar.' });

    const bp = listBlueprints().find((b: any) => b.slug === lead.vertical_slug);
    const moduloLabel = bp?.label || lead.vertical_slug;
    const corpoTermo = lead.contrato_texto || `Você aceitou contratar ${moduloLabel}. Em breve entraremos em contato com os próximos passos.`;

    const enviado = await sendEmail(
      cliente.email,
      `Termo de Adesão — ${moduloLabel}`,
      buildTermoAdesaoEmailHtml(cliente.nome, moduloLabel, corpoTermo)
    );
    if (enviado) {
      await pool.query(`UPDATE landing_leads SET email_termo_enviado=true WHERE id=$1`, [lead.id]);
    }
    res.json({ success: enviado, email_enviado: enviado });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/clientes/:id/veiculos — veículos vinculados a este cliente (Fase 14)
router.get('/clientes/:id/veiculos', async (req, res) => {
  try {
    const eid = estabId(req);
    const cliente = await pool.query(`SELECT id FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const r = await pool.query(
      `SELECT id, placa, modelo, ano, cor, status, plano_id FROM agenda_frota WHERE cliente_id=$1 AND establishment_id=$2 ORDER BY placa`,
      [req.params.id, eid]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/clientes/:id/veiculos/:veiculoId/vincular — vincula um
// veículo já cadastrado (sem dono ou de outro cliente) a este cliente, sem
// tocar em nenhum outro campo do veículo (mesmo motivo do
// /frota/:id/desvincular-cliente acima).
router.post('/clientes/:id/veiculos/:veiculoId/vincular', async (req, res) => {
  try {
    const eid = estabId(req);
    const cliente = await pool.query(`SELECT nome, telefone FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const r = await pool.query(
      `UPDATE agenda_frota SET cliente_id=$1, cliente_nome=$2, cliente_telefone=$3, updated_at=NOW()
       WHERE id=$4 AND establishment_id=$5 RETURNING *`,
      [req.params.id, cliente.rows[0].nome, cliente.rows[0].telefone, req.params.veiculoId, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    res.json({ success: true, veiculo: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /agenda/clientes/:id — veículos vinculados ficam sem cliente (ON DELETE SET NULL)
router.delete('/clientes/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`DELETE FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/clientes/:id/asaas-cobrancas — histórico puxado do Asaas (cache local)
router.get('/clientes/:id/asaas-cobrancas', async (req, res) => {
  try {
    const eid = estabId(req);
    const cliente = await pool.query(`SELECT id FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const r = await pool.query(
      `SELECT * FROM agenda_cliente_asaas_cache WHERE cliente_id=$1 ORDER BY tipo, vencimento DESC NULLS LAST`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/clientes/:id/cobrar — cobrança avulsa (não vinculada a veículo/plano)
router.post('/clientes/:id/cobrar', async (req, res) => {
  try {
    const eid = estabId(req);
    const { valor, descricao } = req.body;
    if (!valor || Number(valor) <= 0) return res.status(400).json({ error: 'valor é obrigatório.' });

    const clienteRes = await pool.query(`SELECT * FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!clienteRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    let cliente = clienteRes.rows[0];

    // Cliente ainda sem conta no Asaas (ex: veio 100% manual) — cria agora sob demanda
    if (!cliente.asaas_customer_id) {
      const created = await createAsaasCustomer(eid, { name: cliente.nome, phone: cliente.telefone, email: cliente.email, cpfCnpj: cliente.cpf_cnpj });
      await pool.query(`UPDATE agenda_clientes SET asaas_customer_id=$1, updated_at=NOW() WHERE id=$2`, [created.id, cliente.id]);
      cliente = { ...cliente, asaas_customer_id: created.id };
    }

    const { payment, pixPayload } = await createAsaasPixCharge(eid, {
      customerId: cliente.asaas_customer_id,
      value: Number(valor),
      description: descricao || `Cobrança avulsa — ${cliente.nome}`,
    });

    await pool.query(
      `INSERT INTO agenda_cliente_asaas_cache (cliente_id, establishment_id, tipo, asaas_id, valor, status, vencimento, descricao, invoice_url, pix_payload, invoice_number)
       VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (cliente_id, tipo, asaas_id) DO UPDATE SET valor=$4, status=$5, vencimento=$6, descricao=$7, invoice_url=$8, pix_payload=$9, invoice_number=$10, synced_at=NOW()`,
      [cliente.id, eid, payment.id, payment.value, payment.status, payment.dueDate, payment.description || null, payment.invoiceUrl || null, pixPayload || null, payment.invoiceNumber || null]
    );

    res.json({ success: true, payment, pix_payload: pixPayload });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/clientes/sync-asaas — importa a base de clientes já cadastrada
// na conta Asaas da empresa: cria os que não existem, vincula por telefone/CPF
// aos que já foram cadastrados manualmente, e atualiza os que já vieram do
// Asaas antes. Também puxa cobranças e assinaturas de cada um pro cache local.
router.post('/clientes/sync-asaas', async (req, res) => {
  try {
    const eid = estabId(req);
    const customers = await listAsaasCustomers(eid);

    let criados = 0, vinculados = 0, atualizados = 0;
    const syncPairs: { clienteId: string; asaasCustomerId: string }[] = [];

    for (const c of customers) {
      if (!c.id || !c.name) continue;
      const telefoneNorm = (c.mobilePhone || c.phone || '').replace(/\D/g, '') || null;
      const cpfNorm = (c.cpfCnpj || '').replace(/\D/g, '') || null;

      const existing = await pool.query(
        `SELECT id FROM agenda_clientes WHERE establishment_id=$1 AND asaas_customer_id=$2`,
        [eid, c.id]
      );
      if (existing.rows.length) {
        await pool.query(
          `UPDATE agenda_clientes SET nome=$1, telefone=COALESCE(telefone,$2), email=COALESCE(email,$3), cpf_cnpj=COALESCE(cpf_cnpj,$4), updated_at=NOW()
           WHERE id=$5`,
          [c.name, telefoneNorm, c.email || null, cpfNorm, existing.rows[0].id]
        );
        syncPairs.push({ clienteId: existing.rows[0].id, asaasCustomerId: c.id });
        atualizados++;
        continue;
      }

      let matched: { id: string } | null = null;
      if (telefoneNorm || cpfNorm) {
        const m = await pool.query(
          `SELECT id FROM agenda_clientes
           WHERE establishment_id=$1 AND asaas_customer_id IS NULL
             AND (($2::text IS NOT NULL AND regexp_replace(COALESCE(telefone,''),'\\D','','g')=$2)
               OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(cpf_cnpj,''),'\\D','','g')=$3))
           LIMIT 1`,
          [eid, telefoneNorm, cpfNorm]
        );
        matched = m.rows[0] || null;
      }

      if (matched) {
        await pool.query(
          `UPDATE agenda_clientes SET asaas_customer_id=$1, email=COALESCE(email,$2), updated_at=NOW() WHERE id=$3`,
          [c.id, c.email || null, matched.id]
        );
        syncPairs.push({ clienteId: matched.id, asaasCustomerId: c.id });
        vinculados++;
        continue;
      }

      const created = await pool.query(
        `INSERT INTO agenda_clientes (establishment_id, nome, telefone, email, cpf_cnpj, asaas_customer_id, origem)
         VALUES ($1,$2,$3,$4,$5,$6,'asaas_sync') RETURNING id`,
        [eid, c.name, telefoneNorm, c.email || null, cpfNorm, c.id]
      );
      syncPairs.push({ clienteId: created.rows[0].id, asaasCustomerId: c.id });
      criados++;
    }

    // Cobranças + assinaturas de cada cliente sincronizado, gravadas no cache local
    let cobrancasImportadas = 0;
    for (const { clienteId, asaasCustomerId } of syncPairs) {
      try {
        const [payments, subs] = await Promise.all([
          getAsaasCustomerPayments(eid, asaasCustomerId),
          getAsaasCustomerSubscriptions(eid, asaasCustomerId),
        ]);
        for (const p of payments) {
          await pool.query(
            `INSERT INTO agenda_cliente_asaas_cache (cliente_id, establishment_id, tipo, asaas_id, valor, status, vencimento, descricao, invoice_url, invoice_number)
             VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (cliente_id, tipo, asaas_id) DO UPDATE SET valor=$4, status=$5, vencimento=$6, descricao=$7, invoice_url=$8, invoice_number=$9, synced_at=NOW()`,
            [clienteId, eid, p.id, p.value, p.status, p.dueDate, p.description || null, p.invoiceUrl || null, p.invoiceNumber || null]
          );
          cobrancasImportadas++;
        }
        for (const s of subs) {
          await pool.query(
            `INSERT INTO agenda_cliente_asaas_cache (cliente_id, establishment_id, tipo, asaas_id, valor, status, vencimento, descricao)
             VALUES ($1,$2,'subscription',$3,$4,$5,$6,$7)
             ON CONFLICT (cliente_id, tipo, asaas_id) DO UPDATE SET valor=$4, status=$5, vencimento=$6, descricao=$7, synced_at=NOW()`,
            [clienteId, eid, s.id, s.value, s.status, s.nextDueDate || null, s.description || null]
          );
        }
      } catch (subErr: any) {
        console.warn(`[clientes/sync-asaas] falha ao puxar histórico (cliente ${clienteId}):`, subErr.message);
      }
    }

    res.json({ success: true, total_asaas: customers.length, criados, vinculados, atualizados, cobrancas_importadas: cobrancasImportadas });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// NOTA FISCAL (NFS-e via Asaas) — Fase 13
// ═══════════════════════════════════════════════════════

// GET /agenda/fiscal-config — status da config, sem expor senha/token em claro
router.get('/fiscal-config', async (req, res) => {
  try {
    const eid = estabId(req);
    const r = await pool.query(`SELECT * FROM agenda_fiscal_config WHERE establishment_id=$1`, [eid]);
    if (!r.rows.length) return res.json({ configurado: false });
    const c = r.rows[0];
    res.json({
      configurado: true,
      ativo: c.ativo,
      emissao_automatica: c.emissao_automatica,
      email: c.email,
      municipal_inscription: c.municipal_inscription,
      simples_nacional: c.simples_nacional,
      cultural_projects_promoter: c.cultural_projects_promoter,
      cnae: c.cnae,
      special_tax_regime: c.special_tax_regime,
      service_list_item: c.service_list_item,
      nbs_code: c.nbs_code,
      rps_serie: c.rps_serie,
      rps_number: c.rps_number,
      lote_number: c.lote_number,
      auth_type: c.auth_type,
      username: c.username,
      password_set: !!c.password,
      access_token_set: !!c.access_token,
      municipal_service_id: c.municipal_service_id,
      municipal_service_code: c.municipal_service_code,
      municipal_service_name: c.municipal_service_name,
      retain_iss: c.retain_iss,
      iss_pct: c.iss_pct, pis_pct: c.pis_pct, cofins_pct: c.cofins_pct,
      csll_pct: c.csll_pct, inss_pct: c.inss_pct, ir_pct: c.ir_pct,
      configured_at: c.configured_at,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/fiscal-config/requisitos-municipais — o que a prefeitura da conta exige
router.get('/fiscal-config/requisitos-municipais', async (req, res) => {
  try {
    const eid = estabId(req);
    const opts = await getMunicipalOptions(eid);
    res.json(opts);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/fiscal-config/servicos-municipais?description=
router.get('/fiscal-config/servicos-municipais', async (req, res) => {
  try {
    const eid = estabId(req);
    const { description } = req.query as Record<string, string>;
    const servicos = await listMunicipalServices(eid, description);
    res.json(servicos);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /agenda/fiscal-config — salva localmente + registra no Asaas
router.put('/fiscal-config', async (req, res) => {
  try {
    const eid = estabId(req);
    const b = req.body;
    if (!b.email) return res.status(400).json({ error: 'email é obrigatório.' });
    if (b.auth_type === 'USER_AND_PASSWORD' && !b.username) return res.status(400).json({ error: 'usuário é obrigatório pra autenticação por usuário/senha.' });
    if (b.auth_type === 'TOKEN' && !b.access_token && !(await pool.query(`SELECT access_token FROM agenda_fiscal_config WHERE establishment_id=$1`, [eid])).rows[0]?.access_token) {
      return res.status(400).json({ error: 'token de acesso é obrigatório pra essa prefeitura.' });
    }

    // Registra/atualiza no Asaas primeiro — só grava local se o Asaas aceitar
    await saveFiscalInfo(eid, {
      email: b.email,
      municipalInscription: b.municipal_inscription || undefined,
      simplesNacional: !!b.simples_nacional,
      culturalProjectsPromoter: !!b.cultural_projects_promoter,
      cnae: b.cnae || undefined,
      specialTaxRegime: b.special_tax_regime || undefined,
      serviceListItem: b.service_list_item || undefined,
      nbsCode: b.nbs_code || undefined,
      rpsSerie: b.rps_serie || undefined,
      rpsNumber: b.rps_number ? Number(b.rps_number) : undefined,
      loteNumber: b.lote_number ? Number(b.lote_number) : undefined,
      username: b.auth_type === 'USER_AND_PASSWORD' ? (b.username || undefined) : undefined,
      password: b.auth_type === 'USER_AND_PASSWORD' ? (b.password || undefined) : undefined,
      accessToken: b.auth_type === 'TOKEN' ? (b.access_token || undefined) : undefined,
    });

    const existing = await pool.query(`SELECT password, access_token FROM agenda_fiscal_config WHERE establishment_id=$1`, [eid]);
    const keepPassword = b.password || existing.rows[0]?.password || null;
    const keepToken = b.access_token || existing.rows[0]?.access_token || null;

    await pool.query(
      `INSERT INTO agenda_fiscal_config (
         establishment_id, email, municipal_inscription, simples_nacional, cultural_projects_promoter,
         cnae, special_tax_regime, service_list_item, nbs_code, rps_serie, rps_number, lote_number,
         auth_type, username, password, access_token,
         municipal_service_id, municipal_service_code, municipal_service_name,
         retain_iss, iss_pct, pis_pct, cofins_pct, csll_pct, inss_pct, ir_pct,
         emissao_automatica, ativo, configured_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,true,NOW(),NOW())
       ON CONFLICT (establishment_id) DO UPDATE SET
         email=$2, municipal_inscription=$3, simples_nacional=$4, cultural_projects_promoter=$5,
         cnae=$6, special_tax_regime=$7, service_list_item=$8, nbs_code=$9, rps_serie=$10, rps_number=$11, lote_number=$12,
         auth_type=$13, username=$14, password=$15, access_token=$16,
         municipal_service_id=$17, municipal_service_code=$18, municipal_service_name=$19,
         retain_iss=$20, iss_pct=$21, pis_pct=$22, cofins_pct=$23, csll_pct=$24, inss_pct=$25, ir_pct=$26,
         emissao_automatica=$27, ativo=true, configured_at=COALESCE(agenda_fiscal_config.configured_at,NOW()), updated_at=NOW()`,
      [eid, b.email, b.municipal_inscription || null, !!b.simples_nacional, !!b.cultural_projects_promoter,
       b.cnae || null, b.special_tax_regime || null, b.service_list_item || null, b.nbs_code || null,
       b.rps_serie || null, b.rps_number || null, b.lote_number || null,
       b.auth_type || 'USER_AND_PASSWORD', b.username || null, keepPassword, keepToken,
       b.municipal_service_id || null, b.municipal_service_code || null, b.municipal_service_name || null,
       !!b.retain_iss, b.iss_pct || 0, b.pis_pct || 0, b.cofins_pct || 0, b.csll_pct || 0, b.inss_pct || 0, b.ir_pct || 0,
       !!b.emissao_automatica]
    );

    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /agenda/notas-fiscais — histórico de notas emitidas/agendadas
router.get('/notas-fiscais', async (req, res) => {
  try {
    const eid = estabId(req);
    const r = await pool.query(
      `SELECT n.*, c.nome AS cliente_nome, f.placa
       FROM agenda_notas_fiscais n
       LEFT JOIN agenda_clientes c ON c.id = n.cliente_id
       LEFT JOIN agenda_frota f ON f.id = n.agenda_frota_id
       WHERE n.establishment_id=$1
       ORDER BY n.created_at DESC LIMIT 200`,
      [eid]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// COBRANÇA VIA WHATSAPP — reenvio manual (Fase 13)
// ═══════════════════════════════════════════════════════

// Fix de produção 23 — envia uma ou duas mensagens (a segunda só existe se
// `cobranca_pix_separado` estiver ligado e houver Pix) com um intervalo curto
// entre elas, mesmo padrão de sequência usado no job automático
// (trackingBillingJob.ts). Reaproveitado pelos dois reenvios manuais abaixo.
async function enviarMensagensCobranca(eid: string, telefone: string, msgs: string[]): Promise<void> {
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 1_500));
    await sendWhatsAppMessage(eid, telefone, msgs[i]);
  }
}

// POST /agenda/frota-cobrancas/:id/notificar-whatsapp — reenvia o PIX de uma mensalidade
router.post('/frota-cobrancas/:id/notificar-whatsapp', async (req, res) => {
  try {
    const eid = estabId(req);
    const r = await pool.query(
      `SELECT c.*, f.cliente_nome, f.cliente_telefone, est.business_config, est.name AS estab_name
       FROM agenda_frota_charges c
       JOIN agenda_frota f ON f.id = c.agenda_frota_id
       JOIN establishments est ON est.id = c.establishment_id
       WHERE c.id=$1 AND c.establishment_id=$2`,
      [req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cobrança não encontrada.' });
    const c = r.rows[0];
    if (!c.cliente_telefone) return res.status(422).json({ error: 'Veículo sem telefone de cliente cadastrado.' });
    if (!c.pix_code) return res.status(422).json({ error: 'Essa cobrança ainda não tem PIX gerado.' });

    const bc = c.business_config || {};
    const dados: DadosMensagemCobranca = {
      nome: c.cliente_nome || 'cliente', empresa: c.estab_name, modulo: 'Rastreamento',
      valor: c.valor, vencimentoLabel: c.competencia, pixPayload: c.pix_code,
    };
    const msgs = montarMensagensCobranca(bc.mensagem_cobranca_template, dados, !!bc.cobranca_pix_separado);
    await enviarMensagensCobranca(eid, c.cliente_telefone, msgs);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/clientes/:clienteId/cobrancas/:cacheId/notificar-whatsapp — reenvia cobrança avulsa do cliente
router.post('/clientes/:clienteId/cobrancas/:cacheId/notificar-whatsapp', async (req, res) => {
  try {
    const eid = estabId(req);
    const clienteRes = await pool.query(
      `SELECT ac.*, est.business_config
       FROM agenda_clientes ac
       JOIN establishments est ON est.id = ac.establishment_id
       WHERE ac.id=$1 AND ac.establishment_id=$2`,
      [req.params.clienteId, eid]
    );
    if (!clienteRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cliente = clienteRes.rows[0];
    if (!cliente.telefone) return res.status(422).json({ error: 'Cliente sem telefone cadastrado.' });

    const cobRes = await pool.query(
      `SELECT * FROM agenda_cliente_asaas_cache WHERE id=$1 AND cliente_id=$2 AND tipo='payment'`,
      [req.params.cacheId, req.params.clienteId]
    );
    if (!cobRes.rows.length) return res.status(404).json({ error: 'Cobrança não encontrada.' });
    const cob = cobRes.rows[0];
    if (!cob.pix_payload && !cob.invoice_url) {
      return res.status(422).json({ error: 'Essa cobrança não tem PIX nem link de pagamento salvo — gere uma nova cobrança.' });
    }

    // Fix de produção 25 — cobrança sincronizada nunca teve o Pix buscado
    // (só é buscado na hora que a gente cria a cobrança) — busca sob demanda
    // aqui no reenvio manual, e guarda no cache pra próxima vez.
    let pixPayload = cob.pix_payload;
    if (!pixPayload && cob.asaas_id) {
      pixPayload = await getAsaasPixPayload(eid, cob.asaas_id);
      if (pixPayload) {
        await pool.query(`UPDATE agenda_cliente_asaas_cache SET pix_payload=$1 WHERE id=$2`, [pixPayload, cob.id]);
      }
    }

    const bc = cliente.business_config || {};
    const dados: DadosMensagemCobranca = {
      nome: cliente.nome, valor: cob.valor, descricao: cob.descricao,
      pixPayload, invoiceUrl: cob.invoice_url,
    };
    const msgs = montarMensagensCobranca(bc.mensagem_cobranca_template, dados, !!bc.cobranca_pix_separado);
    await enviarMensagensCobranca(eid, cliente.telefone, msgs);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/clientes/:clienteId/cobrancas/:cacheId/dar-baixa — confirma
// pagamento manualmente (Fase 14). Necessário pro fluxo de Pix Manual (sem
// webhook automático — Asaas/Mercado Pago) e como reserva pra qualquer
// cobrança que o lojista confirmou por fora (ex: comprovante recebido no
// WhatsApp). Dispara os mesmos efeitos colaterais de uma confirmação
// automática: WhatsApp de confirmação pro cliente e nota fiscal (se
// configurada) — mesmo padrão do branch de webhook em payments.ts (Fase 13).
router.post('/clientes/:clienteId/cobrancas/:cacheId/dar-baixa', async (req, res) => {
  try {
    const eid = estabId(req);
    const clienteRes = await pool.query(`SELECT * FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.clienteId, eid]);
    if (!clienteRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cliente = clienteRes.rows[0];

    const cobRes = await pool.query(
      `SELECT * FROM agenda_cliente_asaas_cache WHERE id=$1 AND cliente_id=$2 AND tipo='payment'`,
      [req.params.cacheId, req.params.clienteId]
    );
    if (!cobRes.rows.length) return res.status(404).json({ error: 'Cobrança não encontrada.' });
    const cob = cobRes.rows[0];

    if (cob.baixado_manualmente || ['RECEIVED', 'CONFIRMED'].includes(cob.status)) {
      return res.status(409).json({ error: 'Essa cobrança já está marcada como paga.' });
    }

    await pool.query(
      `UPDATE agenda_cliente_asaas_cache SET status='RECEIVED', baixado_manualmente=true, baixado_em=NOW(), synced_at=NOW() WHERE id=$1`,
      [cob.id]
    );

    if (cliente.telefone) {
      const msg = `✅ *Pagamento confirmado!*\n\nOlá, ${cliente.nome}! Recebemos seu pagamento${cob.descricao ? ` (${cob.descricao})` : ''}. Obrigado!`;
      sendWhatsAppMessage(eid, cliente.telefone, msg).catch(() => {});
    }

    emitirNotaFiscal({
      estId: eid,
      paymentAsaasId: cob.asaas_id || null,
      clienteId: cliente.id,
      value: Number(cob.valor),
      description: cob.descricao || `Cobrança — ${cliente.nome}`,
    }).catch(() => {});

    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;