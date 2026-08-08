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
  editDevice as editGpswoxDevice,
  createClient as createGpswoxClient,
  listClients as listGpswoxClients,
  listClientsForDevice as listGpswoxClientsForDevice,
  getDeviceLocation,
  sendCommand as sendGpswoxCommand,
  resolveCommandType as resolveGpswoxCommandType,
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
  // Fix de produção 50 — cliente cadastrado aqui agora tenta criar o
  // "client" correspondente no GPSWOX (best-effort); guarda o id retornado
  // pra não tentar criar de novo em edições futuras.
  await pool.query(`ALTER TABLE agenda_clientes ADD COLUMN IF NOT EXISTS gpswox_client_id TEXT`);

  // Fix de produção 53 — o Carlos confirmou que um veículo pode ter vários
  // e-mails com acesso no GPSWOX (normalmente só um paga, mas todos usam);
  // `agenda_frota.cliente_id` continua sendo o cliente PRINCIPAL (dono/quem
  // paga — usado pra cobrança e é o que já existia), e essa tabela nova
  // guarda TODOS os clientes com acesso ao veículo (N-pra-N), incluindo o
  // principal, pra a gente saber a lista completa de quem enxerga aquele
  // veículo no app/portal.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_frota_acessos (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agenda_frota_id   UUID NOT NULL REFERENCES agenda_frota(id) ON DELETE CASCADE,
      cliente_id        UUID NOT NULL REFERENCES agenda_clientes(id) ON DELETE CASCADE,
      establishment_id  UUID NOT NULL,
      gpswox_client_id  TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agenda_frota_id, cliente_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_acessos_veiculo ON agenda_frota_acessos(agenda_frota_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_acessos_estab ON agenda_frota_acessos(establishment_id)`);
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
  // Fix de produção 52 — 'gpswox_sync' adicionado à lista: cliente trazido
  // automaticamente do GPSWOX (dono de um dispositivo) quando não bate por
  // e-mail/telefone com nenhum cliente já cadastrado aqui.
  await pool.query(`ALTER TABLE agenda_clientes DROP CONSTRAINT IF EXISTS agenda_clientes_origem_check`);
  await pool.query(`ALTER TABLE agenda_clientes ADD CONSTRAINT agenda_clientes_origem_check CHECK (origem IN ('manual','asaas_sync','landing_rastreamento','landing_modulo','gpswox_sync'))`);
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

  // Fix de produção 62 — biblioteca de comandos SMS salvos por modelo de
  // rastreador, inspirada na tela "Meus Comandos" do CODESMS (ferramenta de
  // terceiro que o Carlos já usa). establishment_id NULL = catálogo
  // compartilhado da plataforma (curado pelo SUPERADMIN, todo lojista já vê
  // pronto); establishment_id preenchido = comando pessoal daquele lojista —
  // mesmo padrão SHARED/OWN já usado em sms_providers (Fix de produção 56).
  // `comando` pode conter o placeholder [ID], substituído pelo
  // imei_rastreador do veículo na hora do envio (mesma ideia da tela "Meus
  // Comandos com ID" do CODESMS).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS frota_sms_commands (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id  UUID REFERENCES establishments(id) ON DELETE CASCADE,
      tracker_model     TEXT NOT NULL DEFAULT 'Geral',
      categoria         TEXT NOT NULL DEFAULT 'Geral',
      titulo            TEXT NOT NULL,
      comando           TEXT NOT NULL,
      cor               TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_sms_commands_est ON frota_sms_commands(establishment_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_frota_sms_commands_model ON frota_sms_commands(tracker_model)`);
  // Índice único parcial (só entre os compartilhados) pra dar suporte ao
  // ON CONFLICT DO NOTHING do seed abaixo — roda toda vez que o processo
  // sobe, então sem isso duplicaria as linhas a cada restart.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_frota_sms_commands_shared_unico
      ON frota_sms_commands(tracker_model, titulo) WHERE establishment_id IS NULL
  `);
  await seedFrotaSmsCommandsCatalogo();

  migrated = true;
}

// Fix de produção 62.1 — catálogo compartilhado inicial, mandado pelo Carlos
// (lista de comandos que ele já usa e valida no CODESMS, por modelo de
// rastreador). ON CONFLICT DO NOTHING: roda a cada boot mas só insere na
// primeira vez — depois disso o SUPERADMIN pode editar/excluir livremente
// pelo painel (public/admin.html) sem o seed sobrescrever a edição.
// Comando '' (vazio) em 4 linhas do grupo J16/J14/EC33/GT06 é proposital —
// o Carlos pediu pra deixar em branco porque o mesmo comando SMS aparecia
// repetido em duas funções diferentes na lista original (BATERIA EXT /
// HODÔMETRO EM KM ambos SZCS#GT06IEXVOL=2; "Bloqueio imediato - Qualquer
// velocidade" / "ATIVAR HODÔMETRO" ambos SZCS#SOURCE_OFF_TYPE=1) e ele
// prefere conferir a fonte antes de preencher o valor certo de cada um.
async function seedFrotaSmsCommandsCatalogo(): Promise<void> {
  const seed: Array<[string, string, string, string]> = [
    // ── BWS3G ──
    ['BWS3G', 'BLOQUEIO', 'BLOQUEAR', 'ENGOFF'],
    ['BWS3G', 'BLOQUEIO', 'DESBLOQUEAR', 'ENGON'],
    ['BWS3G', 'BLOQUEIO', 'LED OFF', 'LEDOFF'],
    ['BWS3G', 'BLOQUEIO', 'LED ON', 'LEDON'],
    ['BWS3G', 'CONFIGURAÇÃO', 'ATIVAR SMS', 'SMS1'],
    ['BWS3G', 'CONFIGURAÇÃO', 'DESATIVAR SMS', 'SMS0'],
    ['BWS3G', 'CONFIGURAÇÃO', 'IGN FÍSICA', 'IVOFF'],
    ['BWS3G', 'CONFIGURAÇÃO', 'IGN VIRTUAL', 'IVON'],
    ['BWS3G', 'GERAIS', 'FACTORY', 'RST'],
    ['BWS3G', 'GERAIS', 'REG', 'REG000000#'],
    ['BWS3G', 'GERAIS', 'RESTART', 'RESTART'],
    ['BWS3G', 'GERAIS', 'TIMEZONE', 'TZW0'],
    ['BWS3G', 'MODO DE TRABALHO', 'SLEEP 5 MIN', 'SLEEP05'],
    // ── BWS4G ──
    ['BWS4G', 'BLOQUEIO', 'BLOQUEAR', 'ENGOFF'],
    ['BWS4G', 'BLOQUEIO', 'DESBLOQUEAR', 'ENGON'],
    ['BWS4G', 'BLOQUEIO', 'LED OFF', 'LEDOFF'],
    ['BWS4G', 'BLOQUEIO', 'LED ON', 'LEDON'],
    ['BWS4G', 'CONFIGURAÇÃO', 'ATIVAR SMS', 'SMS1'],
    ['BWS4G', 'CONFIGURAÇÃO', 'DESATIVAR SMS', 'SMS0'],
    ['BWS4G', 'CONFIGURAÇÃO', 'IGN FÍSICA', 'IVOFF'],
    ['BWS4G', 'CONFIGURAÇÃO', 'IGN VIRTUAL', 'IVON'],
    ['BWS4G', 'GERAIS', 'FACTORY', 'RST'],
    ['BWS4G', 'GERAIS', 'REG', 'REG000000#'],
    ['BWS4G', 'GERAIS', 'RESTART', 'RESTART'],
    ['BWS4G', 'GERAIS', 'TIMEZONE', 'TZW0'],
    ['BWS4G', 'MODO DE TRABALHO', 'SLEEP 5 MIN', 'SLEEP05'],
    // ── COBAN ──
    ['COBAN', 'BLOQUEIO', 'BLOQUEAR', 'stop123456'],
    ['COBAN', 'BLOQUEIO', 'BLOQUEIO RÁPIDO', 'quickstop123456'],
    ['COBAN', 'BLOQUEIO', 'DESBLOQUEAR', 'resume123456'],
    ['COBAN', 'BLOQUEIO', 'DESBLOQUEIO RÁPIDO', 'noquickstop123456'],
    ['COBAN', 'CONEXÃO', 'GPRS ON', 'gprs123456'],
    ['COBAN', 'CONEXÃO', 'PROTOCOLO TCP', 'gprs123456,0,0'],
    ['COBAN', 'CONEXÃO', 'PROTOCOLO UDP', 'gprs123456,1,1'],
    ['COBAN', 'GERAIS', 'BEGIN', 'begin123456'],
    ['COBAN', 'GERAIS', 'CLEAN', 'clear123456'],
    ['COBAN', 'GERAIS', 'RESET', 'reset123456'],
    ['COBAN', 'GERAIS', 'TIMEZONE', 'time zone123456 0'],
    ['COBAN', 'MODO DE OPERAÇÃO', 'MODO LIGAÇÃO', 'monitor123456'],
    ['COBAN', 'MODO DE OPERAÇÃO', 'MODO TRACKER', 'tracker123456'],
    // ── GV (Queclink GV50) ──
    ['GV', 'BLOQUEIO', 'BLOQUEAR', 'AT+GTOUT=gv50,1,0,0,0,0,0,,,,3,,,,,,,FFFF$'],
    ['GV', 'BLOQUEIO', 'DESBLOQUEAR', 'AT+GTOUT=gv50,0,0,0,0,0,0,,,,3,,,,,,,FFFF$'],
    ['GV', 'GERAIS', 'CLEAN', 'AT+GTRTO=gv50,D,,3,,,,FFFF$'],
    ['GV', 'GERAIS', 'FACTORY', 'AT+GTRTO=gv50m,04,,0,,,,FFFF$'],
    ['GV', 'GERAIS', 'RESET', 'AT+GTRTO=gv50,3,,3,,,,FFFF$'],
    ['GV', 'GERAIS', 'TIMEZONE', 'AT+GTTMA=gv50,+,0,0,0,,,,,,FFFF$'],
    ['GV', 'MODO DE TRABALHO', 'DEEP SLEEP', 'AT+GTCFG=gv50,gv50,gv50,,,,,,1,,,,,,,,,,,,,,FFFF$'],
    ['GV', 'MODO DE TRABALHO', 'LOW SLEEP', 'AT+GTCFG=gv50,gv50,gv50,,,,,,2,,,,,,,,,,,,,,FFFF$'],
    ['GV', 'MODO DE TRABALHO', 'SLEEP OFF', 'AT+GTCFG=gv50,gv50,gv50,,,,,,0,,,,,,,,,,,,,,FFFF$'],
    // ── J16/J14/EC33/GT06 ──
    ['J16/J14/EC33/GT06', 'ÂNGULO', 'ÂNGULO 15-30', 'SZCS#ANGLEVALUE=15-30'],
    ['J16/J14/EC33/GT06', 'ÂNGULO', 'ÂNGULO 35-2', 'SZCS#ANGLEVALUE=35-002'],
    ['J16/J14/EC33/GT06', 'ÂNGULO', 'ÂNGULO 8-15', 'SZCS#ANGLEVALUE=08-015'],
    ['J16/J14/EC33/GT06', 'ÂNGULO', 'ÂNGULO 8-30', 'SZCS#ANGLEVALUE=08-030'],
    ['J16/J14/EC33/GT06', 'BLOQUEIO', 'BATERIA EXT', ''],
    ['J16/J14/EC33/GT06', 'BLOQUEIO', 'BLOQUEAR', 'RELAY,1#'],
    ['J16/J14/EC33/GT06', 'BLOQUEIO', 'Bloqueio imediato - Qualquer velocidade', ''],
    ['J16/J14/EC33/GT06', 'BLOQUEIO', 'Desativar Bloqueio imediato', 'SZCS#SOURCE_OFF_TYPE=0'],
    ['J16/J14/EC33/GT06', 'BLOQUEIO', 'DESBLOQUEAR', 'RELAY,0#'],
    ['J16/J14/EC33/GT06', 'BLOQUEIO', 'LED DESLIGADO', 'SZCS#LED_ENABLE=0'],
    ['J16/J14/EC33/GT06', 'BLOQUEIO', 'LED LIGADO', 'SZCS#LED_ENABLE=1'],
    ['J16/J14/EC33/GT06', 'COMANDOS TÉCNICOS', 'ALARM VIBR.', 'SENALM,ON,0#'],
    ['J16/J14/EC33/GT06', 'COMANDOS TÉCNICOS', 'ALERTA IGN', 'ACCALM,ON,0#'],
    ['J16/J14/EC33/GT06', 'COMANDOS TÉCNICOS', 'GPS OFF PARADO', 'SZCS#GPS_DISSLP=0'],
    ['J16/J14/EC33/GT06', 'COMANDOS TÉCNICOS', 'GPS ON PARADO', 'SZCS#GPS_DISSLP=1'],
    ['J16/J14/EC33/GT06', 'COMANDOS TÉCNICOS', 'IGN FÍSICA', 'SZCS#ACCLINE=1'],
    ['J16/J14/EC33/GT06', 'COMANDOS TÉCNICOS', 'IGN VIRTUAL', 'SZCS#ACCLINE=0'],
    ['J16/J14/EC33/GT06', 'GERAIS', 'FACTORY', 'FACTORY#'],
    ['J16/J14/EC33/GT06', 'GERAIS', 'FORMAT', 'FORMAT#'],
    ['J16/J14/EC33/GT06', 'GERAIS', 'HORA CERTA', 'GMT,W,0,0#'],
    ['J16/J14/EC33/GT06', 'GERAIS', 'LOCK IP', 'SETIPLOCK=1'],
    ['J16/J14/EC33/GT06', 'GERAIS', 'RESET', 'RESET#'],
    ['J16/J14/EC33/GT06', 'GERAIS', 'UNLOCK IP', 'SETIPLOCK=0'],
    ['J16/J14/EC33/GT06', 'GPS', 'GPS ATIVO', 'SENDS,0#'],
    ['J16/J14/EC33/GT06', 'GPS', 'REINICIAR GPS SEM SINAL EM 180SEG', 'SZCS#GPS_RST_TIME=180'],
    ['J16/J14/EC33/GT06', 'GPS', 'REINICIAR GPS SEM SINAL EM 300SEG', 'SZCS#GPS_RST_TIME=300'],
    ['J16/J14/EC33/GT06', 'HODÔMETRO', 'ATIVAR HODÔMETRO', ''],
    ['J16/J14/EC33/GT06', 'HODÔMETRO', 'HODÔMETRO EM KM', ''],
    ['J16/J14/EC33/GT06', 'HODÔMETRO', 'INICIAR HODÔMETRO', 'MILEAGE,ON#'],
    ['J16/J14/EC33/GT06', 'MODO DE REDE', 'BACKUP OFF', 'SZCS#BLIND_EN=0'],
    ['J16/J14/EC33/GT06', 'MODO DE REDE', 'BACKUP ON', 'SZCS#BLIND_EN=1'],
    ['J16/J14/EC33/GT06', 'MODO DE REDE', 'REDE AUTO', 'signal,0#'],
    ['J16/J14/EC33/GT06', 'MODO DE REDE', 'SOMENTE 2G', 'signal,2#'],
    ['J16/J14/EC33/GT06', 'MODO DE REDE', 'SOMENTE 4G', 'signal,1#'],
    ['J16/J14/EC33/GT06', 'MODO DE TRABALHO', 'SEM SLEEP', 'SZCS#SLPDISCONNECT=0'],
    ['J16/J14/EC33/GT06', 'MODO DE TRABALHO', 'SLEEP 100%', 'SZCS#SLPDISCONNECT=2'],
    ['J16/J14/EC33/GT06', 'MODO DE TRABALHO', 'SLEEP C/SMS', 'SZCS#SLPDISCONNECT=1'],
    // ── T905 ──
    ['T905', 'ALARMES', 'ALARME OFF', 'noshock123456'],
    ['T905', 'ALARMES', 'ALARME ON', 'shock123456'],
    ['T905', 'ALARMES', 'ALERTA BATERIA OFF', 'lowbatsms123456 off'],
    ['T905', 'ALARMES', 'ALERTA BATERIA ON', 'lowbatsms123456 on'],
    ['T905', 'GERAIS', 'BEGIN', 'begin123456'],
    ['T905', 'GERAIS', 'RESET', 'reset123456'],
    ['T905', 'GERAIS', 'TIMEZONE', 'time zone123456 0'],
    ['T905', 'MODO DE OPERAÇÃO', 'MODO LIGAÇÃO', 'monitor123456'],
    ['T905', 'MODO DE OPERAÇÃO', 'MODO TRACKER', 'tracker123456'],
  ];

  for (const [tracker_model, categoria, titulo, comando] of seed) {
    await pool.query(
      `INSERT INTO frota_sms_commands (establishment_id, tracker_model, categoria, titulo, comando)
       VALUES (NULL, $1, $2, $3, $4)
       ON CONFLICT (tracker_model, titulo) WHERE establishment_id IS NULL DO NOTHING`,
      [tracker_model, categoria, titulo, comando]
    );
  }
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

// Fix de produção 50 — antes disso, o único jeito de um veículo virar
// dispositivo no GPSWOX era clicar manualmente em "Sincronizar com GPS"
// depois de cadastrar. O Carlos pediu pra isso acontecer sozinho: se o
// veículo já tem IMEI preenchido na hora de salvar (criar ou editar), tenta
// criar no GPSWOX na hora, best-effort (não bloqueia o salvamento local se o
// GPSWOX falhar ou não estiver configurado — "Sincronizar com GPS" continua
// funcionando como rede de segurança pra quem prefere preencher o IMEI
// depois). Reaproveita o mesmo `createGpswoxDevice` do fluxo manual.
async function tentarCriarDispositivoGpswox(eid: string, params: { imei: string; placa: string | null; clienteId: string | null | undefined; nomeFallback: string }): Promise<string | null> {
  try {
    let gpswoxUserId: string | undefined;
    if (params.clienteId) {
      const cli = await pool.query(`SELECT gpswox_client_id FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [params.clienteId, eid]);
      gpswoxUserId = cli.rows[0]?.gpswox_client_id || undefined;
    }
    const criado = await createGpswoxDevice(eid, {
      name: params.placa || params.nomeFallback,
      imei: params.imei,
      plateNumber: params.placa || undefined,
      userId: gpswoxUserId,
    });
    console.log(`[frota] dispositivo criado no GPSWOX ao salvar veiculo — imei=${params.imei} device_id=${criado.id}`);
    return criado.id;
  } catch (e: any) {
    console.warn(`[frota] não foi possível criar no GPSWOX ao salvar veículo (${e.message}) — segue só local, "Sincronizar com GPS" pega depois.`);
    return null;
  }
}

// Fix de produção 51 — vincular/desvincular cliente de um veículo que já
// tem dispositivo no GPSWOX atualizava só o cadastro local; o dono do
// dispositivo lá continuava desatualizado. Best-effort (não bloqueia a
// operação local se o GPSWOX falhar): busca o gpswox_client_id do cliente
// (quando `clienteId` é null, passa `userId: null` pra `editDevice`, que
// limpa o dono lá também).
async function tentarAtualizarDonoGpswox(eid: string, gpswoxDeviceId: string | null | undefined, clienteId: string | null | undefined) {
  if (!gpswoxDeviceId) return; // veículo sem dispositivo no GPSWOX — nada a atualizar
  try {
    let gpswoxUserId: string | null = null;
    if (clienteId) {
      const cli = await pool.query(`SELECT gpswox_client_id FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [clienteId, eid]);
      gpswoxUserId = cli.rows[0]?.gpswox_client_id || null;
    }
    await editGpswoxDevice(eid, gpswoxDeviceId, { userId: gpswoxUserId });
    console.log(`[frota] dono do dispositivo GPSWOX atualizado — device_id=${gpswoxDeviceId} novo_dono_gpswox=${gpswoxUserId || '(nenhum)'}`);
  } catch (e: any) {
    console.warn(`[frota] não foi possível atualizar o dono do dispositivo no GPSWOX (${e.message}) — vínculo local aplicado normalmente.`);
  }
}

router.post('/frota', async (req, res) => {
  try {
    const eid = estabId(req);
    const { cliente_nome, cliente_telefone, cliente_id, placa, modelo, ano, cor, imei_rastreador, tracker_phone, data_instalacao, plano_id, status, observacoes } = req.body;
    const dados = await resolveClienteDados(eid, cliente_id, cliente_nome, cliente_telefone);

    let gpswoxDeviceId: string | null = null;
    if (imei_rastreador) {
      gpswoxDeviceId = await tentarCriarDispositivoGpswox(eid, {
        imei: imei_rastreador, placa: placa || null, clienteId: cliente_id, nomeFallback: dados.nome || placa || 'Veículo',
      });
    }

    const r = await pool.query(
      `INSERT INTO agenda_frota (establishment_id,cliente_nome,cliente_telefone,cliente_id,placa,modelo,ano,cor,imei_rastreador,tracker_phone,data_instalacao,plano_id,status,observacoes,gpswox_device_id,tracker_synced_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [eid, dados.nome, dados.telefone, cliente_id||null, placa||null, modelo||null, ano||null, cor||null,
       imei_rastreador||null, tracker_phone?.replace(/\D/g,'') || null, data_instalacao||null, plano_id||null, status||'ativo', observacoes||null,
       gpswoxDeviceId, gpswoxDeviceId ? new Date() : null]
    );
    res.status(201).json({ success: true, veiculo: r.rows[0], gpswox_sincronizado: !!gpswoxDeviceId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/frota/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { cliente_nome, cliente_telefone, cliente_id, placa, modelo, ano, cor, imei_rastreador, tracker_phone, data_instalacao, plano_id, status, observacoes } = req.body;
    const dados = await resolveClienteDados(eid, cliente_id, cliente_nome, cliente_telefone);

    // Só tenta criar no GPSWOX se ainda não tinha device vinculado e agora
    // tem IMEI — evita recriar (ou duplicar) dispositivo em toda edição.
    const atual = await pool.query(`SELECT gpswox_device_id, cliente_id FROM agenda_frota WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    let gpswoxDeviceId: string | null = atual.rows[0]?.gpswox_device_id || null;
    const deviceJaExistia = !!gpswoxDeviceId;
    const clienteIdAntes = atual.rows[0]?.cliente_id || null;
    if (!gpswoxDeviceId && imei_rastreador) {
      gpswoxDeviceId = await tentarCriarDispositivoGpswox(eid, {
        imei: imei_rastreador, placa: placa || null, clienteId: cliente_id, nomeFallback: dados.nome || placa || 'Veículo',
      });
    }

    const r = await pool.query(
      `UPDATE agenda_frota SET cliente_nome=$1,cliente_telefone=$2,cliente_id=$3,placa=$4,modelo=$5,ano=$6,cor=$7,
       imei_rastreador=$8,tracker_phone=$9,data_instalacao=$10,plano_id=$11,status=$12,observacoes=$13,
       gpswox_device_id=COALESCE($14,gpswox_device_id),
       tracker_synced_at=CASE WHEN $14 IS NOT NULL THEN NOW() ELSE tracker_synced_at END,
       updated_at=NOW()
       WHERE id=$15 AND establishment_id=$16 RETURNING *`,
      [dados.nome, dados.telefone, cliente_id||null, placa||null, modelo||null, ano||null, cor||null,
       imei_rastreador||null, tracker_phone?.replace(/\D/g,'') || null, data_instalacao||null, plano_id||null, status||'ativo', observacoes||null,
       gpswoxDeviceId, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });

    // Fix de produção 51 — se o dispositivo já existia (não foi criado agora
    // por causa do IMEI novo, esse caso já nasce com o dono certo) e o
    // cliente vinculado mudou nessa edição, atualiza o dono lá no GPSWOX
    // também. Cobre quem troca o cliente pela tela de edição do veículo em
    // vez do botão dedicado de "vincular".
    if (deviceJaExistia && String(clienteIdAntes || '') !== String(cliente_id || '')) {
      await tentarAtualizarDonoGpswox(eid, gpswoxDeviceId, cliente_id || null);
    }

    res.json({ success: true, veiculo: r.rows[0], gpswox_sincronizado: !!gpswoxDeviceId });
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
    // Fix de produção 51 — limpa o dono lá no GPSWOX também, se o veículo já tiver dispositivo.
    await tentarAtualizarDonoGpswox(eid, r.rows[0].gpswox_device_id, null);
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

// GET /agenda/frota-gpswox-testar — Fix de produção 47. O Carlos pediu um
// botão de "Testar integração" nas Configurações pra não precisar mais
// caçar log no EasyPanel toda vez que algo no GPSWOX não bate. Chama
// get_devices de verdade e devolve um resumo pronto pra tela: quantos
// dispositivos vieram, o nome/IMEI/status de cada um (usando os mesmos
// extratores da sincronização, então se algo aqui não bate certo o
// "Sincronizar com GPS" também não vai bater), e o objeto CRU do primeiro
// dispositivo — pra qualquer campo novo que a API mande no futuro dar pra
// ver direto na tela, sem precisar mexer no código de novo.
router.get('/frota-gpswox-testar', async (req, res) => {
  try {
    const eid = estabId(req);
    const cfg = await getGpswoxConfig(eid);
    if (!isGpswoxConfigured(cfg)) {
      return res.status(422).json({ ok: false, error: 'GPSWOX ainda não configurado — preencha URL e Token acima e salve antes de testar.' });
    }
    const devices = await listGpswoxDevices(eid);
    res.json({
      ok: true,
      total_dispositivos: devices.length,
      dispositivos: devices.map((d: any) => ({
        id: d.id,
        nome: d.name || d.title || null,
        online: d.online ?? null,
        imei: extractDeviceImei(d),
        sim: extractDeviceSimNumber(d),
        gpswox_user_id: extractDeviceGpswoxUserId(d),
        chaves_disponiveis: Object.keys(d || {}),
      })),
      primeiro_dispositivo_cru: devices[0] || null,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
    // Fix de produção 49 — a expressão antiga (`dry_run !== false && dry_run
    // !== undefined ? Boolean(dry_run) : true`) tinha um bug de lógica: quando
    // o frontend mandava `dry_run: false` (clique real em "Aplicar
    // sincronização"), `dry_run !== false` já dava FALSE (porque dry_run
    // REALMENTE é false) — o `&&` inteiro virava false, caindo sempre no
    // ramo `: true` do ternário. Ou seja, `dryRun` era SEMPRE true,
    // independente do que o frontend mandasse — a sincronização nunca
    // aplicava de verdade, só mostrava a pré-visualização com uma mensagem
    // de sucesso (os contadores são calculados igual nos dois casos, só o
    // INSERT/UPDATE real que ficava de fora). Essa é a causa raiz de
    // "diz que sincronizou mas não aparece" que persistia mesmo depois de
    // corrigir a extração de dispositivos do GPSWOX (Fix 44-48) — o problema
    // nunca foi a extração, era essa checagem nunca deixar aplicar de
    // verdade. Corrigido pra uma condição direta: só é preview se dry_run
    // não for EXATAMENTE `false`.
    const dryRun = req.body?.dry_run !== false; // dry_run:false explícito → aplica; qualquer outra coisa → pré-visualiza (padrão seguro)

    const devices = await listGpswoxDevices(eid);
    // Fix de produção 43 — log server-side: o Carlos reportou que a
    // sincronização dizia "importado"/"enviado" mas nada aparecia nem aqui
    // nem no GPSWOX depois. Sem acesso a logs de produção daqui, é impossível
    // confirmar de fora se o problema é o establishment_id usado, a resposta
    // do GPSWOX, ou outra coisa — esses logs aparecem no EasyPanel (aba Logs
    // do serviço) e são o que precisamos ler pra achar a causa real.
    console.log(`[frota-gpswox-sync] eid=${eid} dry_run=${dryRun} devices_recebidos=${devices.length}`);
    const veiculos = (await pool.query(
      `SELECT id, placa, cliente_nome, cliente_id, imei_rastreador, gpswox_device_id FROM agenda_frota WHERE establishment_id=$1`,
      [eid]
    )).rows;
    console.log(`[frota-gpswox-sync] veiculos_locais=${veiculos.length} (ids: ${veiculos.map((v: any) => v.id).join(', ') || 'nenhum'})`);

    const porImei = new Map<string, any>();
    for (const v of veiculos) {
      if (v.imei_rastreador) porImei.set(String(v.imei_rastreador).trim(), v);
    }
    const deviceImeisVistos = new Set<string>();

    // Fix de produção 52 — o Carlos pediu que a sincronização também traga o
    // CLIENTE dono de cada dispositivo, não só o veículo: casando por e-mail
    // ou telefone com um cliente que já exista aqui (mesmo padrão do sync com
    // o Asaas), ou criando um novo se não achar nenhum. Carrega tudo uma vez
    // só antes do loop principal, pra não bater na API/banco por dispositivo.
    const clientesLocais = (await pool.query(
      `SELECT id, nome, telefone, email, gpswox_client_id FROM agenda_clientes WHERE establishment_id=$1`,
      [eid]
    )).rows;
    const clientesPorGpswoxId = new Map<string, any>();
    const clientesPorEmail = new Map<string, any>();
    const clientesPorTelefone = new Map<string, any>();
    for (const c of clientesLocais) {
      if (c.gpswox_client_id) clientesPorGpswoxId.set(String(c.gpswox_client_id), c);
      if (c.email) clientesPorEmail.set(String(c.email).trim().toLowerCase(), c);
      if (c.telefone) clientesPorTelefone.set(String(c.telefone).replace(/\D/g, ''), c);
    }
    let gpswoxClientsById = new Map<string, any>();
    try {
      const gpswoxClients = await listGpswoxClients(eid);
      gpswoxClientsById = new Map(gpswoxClients.map((c: any) => [c.id, c]));
      console.log(`[frota-gpswox-sync] clientes_gpswox=${gpswoxClients.length}`);
    } catch (e: any) {
      console.warn(`[frota-gpswox-sync] não foi possível listar clientes do GPSWOX (${e.message}) — sincronização segue só com dispositivos.`);
    }
    const clientesSincronizados: any[] = [];

    // Resolve (e, se `!dryRun`, cria/vincula de verdade) o cliente local
    // correspondente ao dono `gpswoxUserId` de um dispositivo. Não sobrescreve
    // um `cliente_id` que o veículo já tinha manualmente — só preenche quando
    // está vazio (`clienteIdAtualDoVeiculo` é o valor ANTES dessa sincronização).
    async function resolverClienteGpswox(gpswoxUserId: string | null, clienteIdAtualDoVeiculo: string | null | undefined): Promise<string | null> {
      if (!gpswoxUserId) return clienteIdAtualDoVeiculo || null;
      if (clienteIdAtualDoVeiculo) return clienteIdAtualDoVeiculo; // veículo já tem cliente — não mexe

      const jaVinculado = clientesPorGpswoxId.get(gpswoxUserId);
      if (jaVinculado) return jaVinculado.id;

      const gpswoxClient = gpswoxClientsById.get(gpswoxUserId);
      const email = gpswoxClient?.email ? String(gpswoxClient.email).trim().toLowerCase() : null;
      const telefoneDigits = gpswoxClient?.phoneNumber ? String(gpswoxClient.phoneNumber).replace(/\D/g, '') : null;

      const existentePorEmail = email ? clientesPorEmail.get(email) : null;
      const existentePorTelefone = !existentePorEmail && telefoneDigits ? clientesPorTelefone.get(telefoneDigits) : null;
      const existente = existentePorEmail || existentePorTelefone;

      if (existente) {
        clientesSincronizados.push({ gpswox_client_id: gpswoxUserId, cliente_id: existente.id, cliente_nome: existente.nome, acao: 'vinculado (já cadastrado, casado por e-mail/telefone)' });
        if (!dryRun) {
          await pool.query(`UPDATE agenda_clientes SET gpswox_client_id=$1, updated_at=NOW() WHERE id=$2`, [gpswoxUserId, existente.id]);
          clientesPorGpswoxId.set(gpswoxUserId, existente);
        }
        return existente.id;
      }

      // Não achou por e-mail nem telefone — cria cliente novo a partir dos
      // dados do GPSWOX (que não guarda nome, só e-mail/telefone).
      if (!email && !telefoneDigits) return null; // sem nada pra identificar, não cria fantasma
      const nomeFallback = email || gpswoxClient?.phoneNumber || `Cliente GPSWOX ${gpswoxUserId}`;
      clientesSincronizados.push({ gpswox_client_id: gpswoxUserId, cliente_id: null, cliente_nome: nomeFallback, acao: 'criar novo (sem correspondência aqui)' });
      if (dryRun) return null;

      const novo = await pool.query(
        `INSERT INTO agenda_clientes (establishment_id, nome, telefone, email, origem, gpswox_client_id)
         VALUES ($1,$2,$3,$4,'gpswox_sync',$5) RETURNING *`,
        [eid, nomeFallback, gpswoxClient?.phoneNumber || null, gpswoxClient?.email || null, gpswoxUserId]
      );
      const criado = novo.rows[0];
      clientesPorGpswoxId.set(gpswoxUserId, criado);
      if (criado.email) clientesPorEmail.set(String(criado.email).trim().toLowerCase(), criado);
      if (criado.telefone) clientesPorTelefone.set(String(criado.telefone).replace(/\D/g, ''), criado);
      console.log(`[frota-gpswox-sync] cliente criado a partir do GPSWOX — cliente_id=${criado.id} gpswox_client_id=${gpswoxUserId}`);
      return criado.id;
    }

    const acessosRegistrados: any[] = [];

    // Fix de produção 53 — grava em agenda_frota_acessos TODOS os clientes
    // que têm acesso ao dispositivo no GPSWOX (não só o dono/pagante
    // principal, que continua em agenda_frota.cliente_id). Usa a lista
    // completa vinda do filtro `search_device` de GET /api/admin/clients
    // (diferente de get_devices*, que só traz um dono por vez em
    // device_data.pivot.user_id). Best-effort: nunca derruba a sincronização
    // se alguma gravação falhar. Só escreve quando `!dryRun`; em modo
    // simulação, o `resolverClienteGpswox` já alimenta `clientesSincronizados`
    // pra dar a prévia de quem seria criado/vinculado.
    async function registrarAcessosDoVeiculo(veiculoId: string | null, clientesDoDispositivo: any[]) {
      if (!clientesDoDispositivo.length) return;
      for (const gc of clientesDoDispositivo) {
        // Resolve/cria o cliente local mesmo em dry-run (só assim a prévia em
        // `clientesSincronizados` mostra os acessos extras); a gravação em
        // agenda_frota_acessos em si só acontece com veículo real e fora do dry-run.
        const clienteId = await resolverClienteGpswox(gc.id, null);
        if (!clienteId || dryRun || !veiculoId) continue;
        try {
          await pool.query(
            `INSERT INTO agenda_frota_acessos (agenda_frota_id, cliente_id, establishment_id, gpswox_client_id)
             VALUES ($1,$2,$3,$4) ON CONFLICT (agenda_frota_id, cliente_id) DO NOTHING`,
            [veiculoId, clienteId, eid, gc.id]
          );
          acessosRegistrados.push({ veiculo_id: veiculoId, cliente_id: clienteId, gpswox_client_id: gc.id });
        } catch (e: any) {
          console.warn(`[frota-gpswox-sync] falha ao gravar acesso (veiculo=${veiculoId}, gpswox_client_id=${gc.id}): ${e.message}`);
        }
      }
    }

    // Fix de produção 48 — a documentação oficial confirma que `user_id` é
    // OPCIONAL na criação de dispositivo (POST /api/add_device); o Fix 46
    // tinha tornado isso obrigatório (bloqueando o envio inteiro sem ele)
    // com base no handoff não-oficial do ag-on-track. Continua detectando
    // um `gpswoxUserId` de referência quando existe (associa o dispositivo
    // novo ao mesmo dono dos existentes, se possível), mas agora é só um
    // bônus — não bloqueia mais o envio quando não encontrado.
    let gpswoxUserId: string | null = null;
    for (const d of devices) {
      const uid = extractDeviceGpswoxUserId(d);
      if (uid) { gpswoxUserId = uid; break; }
    }
    console.log(`[frota-gpswox-sync] gpswoxUserId_detectado=${gpswoxUserId} (opcional — não bloqueia mais o envio)`);

    const matched: any[] = [];
    const unmatched: any[] = [];
    const importados: any[] = [];

    for (const device of devices) {
      const imei = extractDeviceImei(device);
      const deviceId = device.id != null ? String(device.id) : null;
      const nome = device.name || device.title || (deviceId ? `Dispositivo ${deviceId}` : 'Dispositivo');
      if (!deviceId) continue;
      if (imei) deviceImeisVistos.add(imei);

      // Fix de produção 53 — busca a lista COMPLETA de clientes com acesso a
      // este dispositivo (best-effort, via search_device). O primeiro vira o
      // "dono/pagante principal" (cliente_id do veículo); todos alimentam
      // agenda_frota_acessos mais abaixo. Se a chamada falhar ou não vier
      // nada, cai de volta pro único sinal que existia antes deste fix
      // (device_data.pivot.user_id de get_devices/get_devices_latest).
      let clientesDoDispositivo: any[] = [];
      if (imei) {
        try {
          clientesDoDispositivo = await listGpswoxClientsForDevice(eid, imei);
        } catch (e: any) {
          console.warn(`[frota-gpswox-sync] não foi possível listar clientes com acesso ao dispositivo (imei=${imei}): ${e.message}`);
        }
      }
      const donoDoDevice = clientesDoDispositivo[0]?.id || extractDeviceGpswoxUserId(device);

      const veiculo = imei ? porImei.get(imei) : null;
      if (!veiculo) {
        // Ninguém aqui tem esse IMEI cadastrado — vira candidato a importar
        // como veículo novo (placa desconhecida: usa o nome do dispositivo
        // como ponto de partida, o Carlos ajusta depois se precisar).
        unmatched.push({ device_id: deviceId, imei, nome });
        if (!dryRun) {
          const simNumber = extractDeviceSimNumber(device);
          // Fix de produção 52 — resolve o cliente dono ANTES do insert, pra
          // já nascer com cliente_id/nome/telefone certos em vez de um
          // segundo UPDATE depois.
          const clienteId = await resolverClienteGpswox(donoDoDevice, null);
          const cliente = clienteId ? clientesPorGpswoxId.get(donoDoDevice!) : null;
          const novo = await pool.query(
            `INSERT INTO agenda_frota (establishment_id, placa, imei_rastreador, gpswox_device_id, tracker_model, tracker_synced_at, tracker_phone, status, observacoes, cliente_id, cliente_nome, cliente_telefone)
             VALUES ($1,$2,$3,$4,$5,NOW(),$6,'ativo',$7,$8,$9,$10) RETURNING id, placa`,
            [eid, nome || null, imei, deviceId, device.device_model || device.model || device.protocol || null, simNumber,
             'Importado automaticamente do GPSWOX pela Sincronização com GPS — confira placa/cliente.',
             clienteId, cliente?.nome || null, cliente?.telefone || null]
          );
          console.log(`[frota-gpswox-sync] IMPORTADO veiculo_id=${novo.rows[0].id} placa=${novo.rows[0].placa} eid=${eid} imei=${imei} cliente_id=${clienteId || '(nenhum)'}`);
          importados.push({ veiculo_id: novo.rows[0].id, placa: novo.rows[0].placa, device_id: deviceId, imei, nome, cliente_id: clienteId });
          await registrarAcessosDoVeiculo(novo.rows[0].id, clientesDoDispositivo);
        } else {
          // só preenche a prévia de clientesSincronizados (dono principal + demais acessos)
          if (clientesDoDispositivo.length) {
            await registrarAcessosDoVeiculo(null, clientesDoDispositivo);
          } else if (donoDoDevice) {
            await resolverClienteGpswox(donoDoDevice, null);
          }
          importados.push({ placa: nome, device_id: deviceId, imei, nome });
        }
        continue;
      }

      const jaVinculado = veiculo.gpswox_device_id === deviceId;
      matched.push({
        veiculo_id: veiculo.id, placa: veiculo.placa, cliente_nome: veiculo.cliente_nome,
        device_id: deviceId, imei, nome, acao: jaVinculado ? 'já vinculado' : 'vincular',
      });

      // Fix de produção 52 — veículo já existia aqui (bateu por IMEI) mas sem
      // cliente vinculado: tenta casar/criar o cliente dono do dispositivo,
      // do mesmo jeito que faz pros importados como veículo novo.
      if (!veiculo.cliente_id) {
        const clienteId = await resolverClienteGpswox(donoDoDevice, veiculo.cliente_id);
        if (!dryRun && clienteId) {
          const cliente = clientesPorGpswoxId.get(donoDoDevice!);
          await pool.query(
            `UPDATE agenda_frota SET cliente_id=$1, cliente_nome=COALESCE(cliente_nome,$2), cliente_telefone=COALESCE(cliente_telefone,$3), updated_at=NOW() WHERE id=$4`,
            [clienteId, cliente?.nome || null, cliente?.telefone || null, veiculo.id]
          );
        }
      }

      // Fix de produção 53 — veículo já existe aqui, então já dá pra gravar
      // (ou, em dry-run, só prever) TODOS os clientes com acesso a este
      // dispositivo, não só o dono principal tratado acima.
      await registrarAcessosDoVeiculo(veiculo.id, clientesDoDispositivo);

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
        try {
          const criado = await createGpswoxDevice(eid, {
            name: v.placa || v.cliente_nome || `Veículo ${v.id}`,
            imei,
            plateNumber: v.placa || undefined,
            userId: gpswoxUserId || undefined,
          });
          // Fix de produção 48 — loga a resposta CRUA do GPSWOX pro
          // add_device (endpoint/payload corrigidos neste fix contra a
          // documentação oficial — user_id agora é opcional).
          console.log(`[frota-gpswox-sync] ENVIAR veiculo_id=${v.id} placa=${v.placa} imei=${imei} user_id=${gpswoxUserId || '(nenhum)'} resposta_gpswox=${JSON.stringify(criado.raw).slice(0, 500)}`);
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
      // Fix de produção 52 — resumo de clientes trazidos/casados a partir
      // dos donos dos dispositivos no GPSWOX.
      clientes_sincronizados: clientesSincronizados,
      total_clientes_sincronizados: clientesSincronizados.length,
      // Fix de produção 53 — acessos extras (além do dono principal)
      // gravados em agenda_frota_acessos nesta rodada.
      acessos_registrados: acessosRegistrados,
      total_acessos_registrados: acessosRegistrados.length,
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

// GET /agenda/frota/:id/acessos — Fix de produção 53: lista todos os
// clientes com acesso a este veículo no GPSWOX (além do cliente
// principal/pagante em agenda_frota.cliente_id), populada pela
// "Sincronizar com GPS".
router.get('/frota/:id/acessos', async (req, res) => {
  try {
    const eid = estabId(req);
    const veh = await pool.query(`SELECT 1 FROM agenda_frota WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!veh.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });

    const result = await pool.query(
      `SELECT a.id, a.cliente_id, a.gpswox_client_id, a.created_at,
              c.nome AS cliente_nome, c.email AS cliente_email, c.telefone AS cliente_telefone
       FROM agenda_frota_acessos a
       JOIN agenda_clientes c ON c.id = a.cliente_id
       WHERE a.agenda_frota_id = $1 AND a.establishment_id = $2
       ORDER BY a.created_at ASC`,
      [req.params.id, eid]
    );
    res.json(result.rows);
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

// ─── Fix de produção 62 — biblioteca de comandos SMS + envio em massa ───
// Ver comentário da migração de frota_sms_commands (ensureTables) pra
// contexto completo do catálogo compartilhado vs. pessoal do lojista.

// GET /agenda/frota-comandos
//  - LOJISTA (ou SUPERADMIN com establishment_id): catálogo compartilhado + comandos próprios
//  - SUPERADMIN sem establishment_id: só o catálogo compartilhado (tela de gestão do admin)
router.get('/frota-comandos', async (req, res) => {
  try {
    const user = req.user as TokenPayload;
    let eid: string | null;
    if (user.role === 'SUPERADMIN') {
      eid = (req.query.establishment_id as string) || null;
    } else {
      if (!user.establishmentId) return res.status(403).json({ error: 'Sem estabelecimento no token.' });
      eid = user.establishmentId;
    }
    const { rows } = eid
      ? await pool.query(
          `SELECT * FROM frota_sms_commands WHERE establishment_id=$1 OR establishment_id IS NULL ORDER BY tracker_model, categoria, titulo`,
          [eid]
        )
      : await pool.query(
          `SELECT * FROM frota_sms_commands WHERE establishment_id IS NULL ORDER BY tracker_model, categoria, titulo`
        );
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /agenda/frota-comandos — body: { tracker_model, categoria, titulo, comando, cor, shared }
// `shared: true` só tem efeito se quem chama for SUPERADMIN (cria no catálogo
// compartilhado, establishment_id NULL); qualquer outro caso cria como
// comando próprio do estabelecimento de quem chamou.
router.post('/frota-comandos', async (req, res) => {
  try {
    const user = req.user as TokenPayload;
    const { tracker_model, categoria, titulo, comando, cor, shared } = req.body || {};
    if (!titulo || !comando) return res.status(400).json({ error: 'titulo e comando são obrigatórios.' });

    let establishmentId: string | null;
    if (user.role === 'SUPERADMIN' && shared === true) {
      establishmentId = null;
    } else {
      establishmentId = estabId(req);
      if (!establishmentId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO frota_sms_commands (establishment_id, tracker_model, categoria, titulo, comando, cor)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [establishmentId, tracker_model || 'Geral', categoria || 'Geral', titulo, comando, cor || null]
    );
    res.status(201).json(rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Confere posse: comando compartilhado (establishment_id NULL) só pode ser
// alterado por SUPERADMIN; comando próprio só pelo dono (establishment_id bate).
async function assertFrotaComandoAccess(req: Request, id: string) {
  const user = req.user as TokenPayload;
  const r = await pool.query(`SELECT * FROM frota_sms_commands WHERE id=$1`, [id]);
  if (!r.rows.length) throw { status: 404, message: 'Comando não encontrado.' };
  const row = r.rows[0];
  if (row.establishment_id === null) {
    if (user.role !== 'SUPERADMIN') throw { status: 403, message: 'Só o SUPERADMIN pode alterar comandos do catálogo compartilhado.' };
  } else {
    const eid = user.role === 'SUPERADMIN'
      ? ((req.body?.establishment_id as string) || (req.query.establishment_id as string) || '')
      : user.establishmentId;
    if (row.establishment_id !== eid) throw { status: 404, message: 'Comando não encontrado.' };
  }
  return row;
}

router.put('/frota-comandos/:id', async (req, res) => {
  try {
    await assertFrotaComandoAccess(req, req.params.id);
    const { tracker_model, categoria, titulo, comando, cor } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE frota_sms_commands SET
         tracker_model=COALESCE($1,tracker_model), categoria=COALESCE($2,categoria),
         titulo=COALESCE($3,titulo), comando=COALESCE($4,comando), cor=COALESCE($5,cor),
         updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [tracker_model, categoria, titulo, comando, cor, req.params.id]
    );
    res.json(rows[0]);
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

router.delete('/frota-comandos/:id', async (req, res) => {
  try {
    await assertFrotaComandoAccess(req, req.params.id);
    await pool.query(`DELETE FROM frota_sms_commands WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// POST /agenda/frota/comandos/enviar-massa — body: { vehicle_ids: string[], comando: string }
// Manda um comando SMS bruto (pode conter [ID], trocado pelo imei_rastreador
// de cada veículo) direto pro telefone do chip (tracker_phone) de vários
// veículos de uma vez — equivalente ao "Comandos em Massa" do CODESMS.
// Vai só por SMS (não tenta 4G/GPSWOX) — é justamente o caso de uso de mandar
// rápido pra muitos de uma vez, sem esperar resposta de catálogo por device.
router.post('/frota/comandos/enviar-massa', async (req, res) => {
  try {
    const eid = estabId(req);
    const { vehicle_ids, comando } = req.body || {};
    if (!Array.isArray(vehicle_ids) || vehicle_ids.length === 0) {
      return res.status(400).json({ error: 'vehicle_ids deve ser uma lista não vazia.' });
    }
    if (!comando || typeof comando !== 'string') {
      return res.status(400).json({ error: 'comando é obrigatório.' });
    }

    const { rows: veiculos } = await pool.query(
      `SELECT id, placa, cliente_nome, tracker_phone, imei_rastreador FROM agenda_frota
       WHERE establishment_id=$1 AND id = ANY($2::uuid[])`,
      [eid, vehicle_ids]
    );

    const detalhes: Array<{ vehicle_id: string; placa?: string | null; cliente_nome?: string | null; status: string; error: string | null }> = [];
    for (const veh of veiculos) {
      const comandoFinal = comando.replace(/\[ID\]/g, veh.imei_rastreador || '');
      let status = 'sent';
      let errorMessage: string | null = null;
      if (!veh.tracker_phone) {
        status = 'failed';
        errorMessage = 'Veículo sem telefone do chip cadastrado.';
      } else {
        try {
          await sendSms(veh.tracker_phone, comandoFinal, { establishmentId: eid, action: 'frota.comando.massa' });
        } catch (smsErr: any) {
          status = 'failed';
          errorMessage = smsErr.message;
        }
      }
      await pool.query(
        `INSERT INTO agenda_frota_commands (agenda_frota_id, establishment_id, action, status, error_message, channel, failover)
         VALUES ($1,$2,'massa',$3,$4,'sms',false)`,
        [veh.id, eid, status, errorMessage]
      );
      detalhes.push({ vehicle_id: veh.id, placa: veh.placa, cliente_nome: veh.cliente_nome, status, error: errorMessage });
    }

    const encontrados = new Set(veiculos.map((v: any) => v.id));
    for (const vid of vehicle_ids) {
      if (!encontrados.has(vid)) detalhes.push({ vehicle_id: vid, status: 'failed', error: 'Veículo não encontrado.' });
    }

    const sucesso = detalhes.filter(d => d.status === 'sent').length;
    res.json({ total: detalhes.length, sucesso, falha: detalhes.length - sucesso, detalhes });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Mapa de comandos: tipo GPSWOX (4G, usado só como PALPITE de reserva —
// ver Fix de produção 54) + palavras-chave pra achar o comando de verdade
// no catálogo do dispositivo + código SMS de fallback direto pro chip do
// rastreador — portado de vehicle-commands.js do Águia Auto.
const FROTA_COMMAND_MAP: Record<string, { gpswoxType: string; keywords: string[]; smsCode: string; label: string }> = {
  bloquear:    { gpswoxType: 'engineStop',     keywords: ['enginestop', 'engine_stop', 'stop', 'bloque', 'block'],        smsCode: 'RELAY,1#', label: 'Bloquear motor' },
  desbloquear: { gpswoxType: 'engineResume',   keywords: ['engineresume', 'engine_resume', 'resume', 'desbloque', 'unblock'], smsCode: 'RELAY,0#', label: 'Desbloquear motor' },
  // Fix de produção 65 — Carlos pediu pra trocar o fallback SMS de "atualizar"
  // de WHERE# pra RESET# (nos rastreadores que ele usa, RESET# é o que de
  // fato força o dispositivo a reconectar e mandar posição atualizada; WHERE#
  // não estava sendo reconhecido).
  atualizar:   { gpswoxType: 'positionSingle', keywords: ['position', 'locate', 'localiz', 'update'],                      smsCode: 'RESET#',  label: 'Atualizar localização' },
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
    let resolvedType = command.gpswoxType;
    let fromCatalog = false;

    try {
      // Fix de produção 54 — antes disso a gente mandava um `type` genérico
      // fixo (`engine_stop` etc.), que a API aceitava e gravava no
      // histórico (por isso sempre "sucesso"), mas o protocolo do
      // rastreador não reconhecia — nada chegava no veículo de verdade.
      // Agora busca o catálogo REAL de comandos desse dispositivo
      // (get_device_commands) e casa por palavra-chave; só cai pro palpite
      // fixo se o catálogo não estiver disponível.
      const resolved = await resolveGpswoxCommandType(
        eid, veh.gpswox_device_id, command.keywords, command.gpswoxType
      );
      resolvedType = resolved.type;
      fromCatalog = resolved.fromCatalog;
      console.log(`[frota-comando] veiculo_id=${veh.id} action=${action} type_resolvido=${resolvedType} via_catalogo=${fromCatalog}`);
      await sendGpswoxCommand(eid, veh.gpswox_device_id, resolvedType);
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
    res.json({
      success: true, action, status, channel, failover, label: command.label,
      // Fix de produção 54 — transparência: qual `type` foi realmente
      // mandado pro GPSWOX e se veio do catálogo real do dispositivo ou do
      // palpite de reserva (útil pra depurar se um modelo específico ainda
      // não reagir).
      gpswox_command_type: resolvedType, tipo_via_catalogo: fromCatalog,
    });
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

    // Fix de produção 50 — mesmo tratamento best-effort do Asaas acima, mas
    // pro GPSWOX: o Carlos pediu que o cliente cadastrado aqui já vire um
    // "client" no GPSWOX também, não só o veículo. Precisa de e-mail (é o
    // único identificador aceito pelo POST /api/admin/client); sem e-mail,
    // fica só local mesmo (dá pra criar depois, editando o cliente).
    let gpswoxClientId: string | null = null;
    if (email) {
      try {
        const createdGpswox = await createGpswoxClient(eid, { email, phoneNumber: telefone });
        gpswoxClientId = createdGpswox?.id || null;
      } catch (gpswoxErr: any) {
        console.warn(`[clientes] não foi possível criar no GPSWOX (${gpswoxErr.message}) — seguindo só local.`);
      }
    }

    const userId = await findOrCreateClienteUser(nome.trim(), telefone, email);

    const r = await pool.query(
      `INSERT INTO agenda_clientes
         (establishment_id, nome, telefone, email, cpf_cnpj, asaas_customer_id, observacoes, origem, user_id,
          data_nascimento, contato_emergencia_nome, contato_emergencia_telefone, gpswox_client_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11,$12) RETURNING *`,
      [eid, nome.trim(), telefone || null, email || null, cpf_cnpj || null, asaasCustomerId, observacoes || null, userId,
       data_nascimento || null, contato_emergencia_nome || null, contato_emergencia_telefone || null, gpswoxClientId]
    );
    res.status(201).json({ ...r.rows[0], asaas_sincronizado: !!asaasCustomerId, login_disponivel: !!userId, gpswox_sincronizado: !!gpswoxClientId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /agenda/clientes/:id
router.put('/clientes/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, telefone, email, cpf_cnpj, observacoes, data_nascimento, contato_emergencia_nome, contato_emergencia_telefone } = req.body;

    const atual = await pool.query(`SELECT nome, user_id, gpswox_client_id FROM agenda_clientes WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    if (!atual.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    // Se ainda não tinha login vinculado e agora tem telefone/e-mail, tenta vincular.
    let userId = atual.rows[0].user_id;
    if (!userId && (telefone || email)) {
      userId = await findOrCreateClienteUser(nome || atual.rows[0].nome, telefone, email);
    }

    // Fix de produção 50 — mesma lógica do POST: se o cliente ainda não tinha
    // sido criado no GPSWOX (ex: foi cadastrado sem e-mail) e agora um e-mail
    // foi preenchido na edição, tenta criar agora.
    let gpswoxClientId = atual.rows[0].gpswox_client_id;
    if (!gpswoxClientId && email) {
      try {
        const createdGpswox = await createGpswoxClient(eid, { email, phoneNumber: telefone });
        gpswoxClientId = createdGpswox?.id || null;
      } catch (gpswoxErr: any) {
        console.warn(`[clientes] não foi possível criar no GPSWOX (${gpswoxErr.message}) — seguindo só local.`);
      }
    }

    const r = await pool.query(
      `UPDATE agenda_clientes SET nome=COALESCE($1,nome), telefone=$2, email=$3, cpf_cnpj=$4, observacoes=$5, user_id=$6,
         data_nascimento=$7, contato_emergencia_nome=$8, contato_emergencia_telefone=$9, gpswox_client_id=$10, updated_at=NOW()
       WHERE id=$11 AND establishment_id=$12 RETURNING *`,
      [nome || null, telefone || null, email || null, cpf_cnpj || null, observacoes || null, userId,
       data_nascimento || null, contato_emergencia_nome || null, contato_emergencia_telefone || null, gpswoxClientId, req.params.id, eid]
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
    // Fix de produção 51 — atualiza o dono do dispositivo lá no GPSWOX também, se já existir.
    await tentarAtualizarDonoGpswox(eid, r.rows[0].gpswox_device_id, req.params.id);
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