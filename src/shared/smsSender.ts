/**
 * Gateway de SMS — Águia-ON / AguiaOn
 *
 * Capability de plataforma, no mesmo espírito do waSender.ts (Evolution/WhatsApp):
 * qualquer módulo do Águia-ON pode chamar `sendSms(...)` sem saber qual gateway
 * físico está por trás. Suporta múltiplos provedores com failover em cadeia
 * e cada lojista pode usar o gateway compartilhado da plataforma (SHARED,
 * establishment_id = NULL) ou o próprio (OWN, establishment_id preenchido) —
 * mesma lógica de credential_mode explorada no módulo de rastreamento da Águia.
 *
 * Provedores suportados:
 *  - fake          → simulado, sempre "sent" (dev/staging)
 *  - android       → celular físico com chip, agente HTTP próprio (formato genérico, não confirmado contra nenhum app real)
 *  - http_gateway   → URL genérica com %NUMBER%/%MESSAGE% (padrão GPSWOX/PHP)
 *  - smsmarket     → smsmarket.com.br, Basic Auth (usuário+senha), URL fixa — Fix de produção 57
 *  - traccar_sms   → app "Traccar SMS Gateway" (celular físico com chip) — Fix de produção 56
 */

import pool from './db';
import { encrypt, decrypt } from './cryptoUtil';

// ─── Tipos ─────────────────────────────────────────────────────
export type SmsProviderType = 'fake' | 'android' | 'http_gateway' | 'smsmarket' | 'traccar_sms';

export interface SmsProviderRow {
  id: string;
  establishment_id: string | null;
  provider: SmsProviderType;
  label: string | null;
  config: Record<string, any>;
  is_primary: boolean;
  priority: number;
  status: string;
  active: boolean;
}

export interface SendResult {
  success: boolean;
  provider: SmsProviderType;
  provider_id: string;
  used_failover: boolean;
  response_time_ms: number;
  external_id?: string | null;
  error?: string | null;
}

// ─── Schema dos provedores (pra montar o form no admin) ────────
export const PROVIDER_TYPES: Record<SmsProviderType, { label: string; description?: string; fields: Array<{ key: string; label: string; type: string; required?: boolean; secret?: boolean; placeholder?: string }> }> = {
  fake: {
    label: 'Simulado (desenvolvimento)',
    fields: [],
  },
  android: {
    label: 'Gateway Android (chip no aparelho)',
    fields: [
      { key: 'base_url', label: 'URL do agente', type: 'url', required: true },
      { key: 'api_key', label: 'Chave do agente', type: 'password', secret: true, required: true },
      { key: 'device_id', label: 'ID do dispositivo Android', type: 'text', required: true },
    ],
  },
  http_gateway: {
    label: 'Gateway HTTP genérico (SMS/WhatsApp)',
    description: 'URL com %NUMBER% e %MESSAGE% — compatível com GPSWOX, modems e gateways PHP.',
    fields: [
      { key: 'url_template', label: 'URL template', type: 'url', required: true, placeholder: 'http://host/sendsms.php?username=USER&password=PASSWORD&number=%NUMBER%&message=%MESSAGE%' },
      { key: 'sender_id', label: 'Usuário (substitui USER na URL)', type: 'text' },
      { key: 'api_key', label: 'Senha (substitui PASSWORD na URL)', type: 'password', secret: true },
      { key: 'http_method', label: 'Método HTTP', type: 'text', placeholder: 'GET' },
    ],
  },
  // Fix de produção 57 — a implementação anterior nunca tinha sido conferida
  // contra a doc oficial (smsmarket.docs.apiary.io) e estava errada em quase
  // tudo (URL configurável pelo usuário, auth Bearer com uma "api_key" só,
  // corpo JSON com campos `to`/`text`). A API real: URL FIXA
  // (https://api.smsmarket.com.br/webservice-rest/send-single, não vem de
  // config nenhuma), autenticação é HTTP Basic com USUÁRIO + SENHA da conta
  // (não uma api_key única), corpo é `application/x-www-form-urlencoded`
  // com `type`/`country_code`/`number`/`content`. Reaproveita os campos
  // `sender_id`/`api_key` já existentes no schema (usuário/senha) em vez de
  // criar campos novos — mesmo padrão que o `http_gateway` já usa pra
  // usuário+senha.
  smsmarket: {
    label: 'SMSMarket (smsmarket.com.br)',
    description: 'Usuário e senha da sua conta SMSMarket — a URL da API é fixa, não precisa preencher.',
    fields: [
      { key: 'sender_id', label: 'Usuário (login SMSMarket)', type: 'text', required: true },
      { key: 'api_key', label: 'Senha (login SMSMarket)', type: 'password', secret: true, required: true },
    ],
  },
  // Fix de produção 56 — app "Traccar SMS Gateway" (Android, grátis, do mesmo
  // time do Traccar). Confirmado contra a doc oficial (traccar.org/http-sms-api/):
  // funciona em 2 modos, com o MESMO formato de requisição nos dois — só muda
  // a URL/token que o app mostra:
  //   1. "Cloud" — URL fixa https://www.traccar.org/sms/ + TOKEN (gerado no
  //      app depois de conectar numa conta Traccar); não precisa expor o
  //      celular na internet, o app puxa da nuvem.
  //   2. "Direto" — URL local do celular (ex.: http://192.168.0.10:8082) +
  //      API key mostrada no app; só funciona se o servidor alcançar essa
  //      URL (mesma rede, VPN, porta liberada etc.).
  traccar_sms: {
    label: 'Traccar SMS Gateway (app Android)',
    description: 'App gratuito da Traccar que transforma um celular com chip em gateway de SMS (traccar.org/sms-gateway). Use a URL e o token/API key exatamente como o app mostra — modo "Cloud" (URL fixa da Traccar) ou "Direto" (URL local do celular), tanto faz.',
    fields: [
      { key: 'base_url', label: 'URL (Cloud ou Direta, conforme o app)', type: 'url', required: true, placeholder: 'https://www.traccar.org/sms/' },
      { key: 'api_key', label: 'Token / API key (mostrado no app)', type: 'password', secret: true, required: true },
    ],
  },
};

const SECRET_FIELDS = ['api_key'];

export function maskProvider(row: SmsProviderRow) {
  const masked: any = { ...row, config: { ...row.config } };
  for (const field of SECRET_FIELDS) {
    if (!masked.config[field]) continue;
    const value = String(masked.config[field]);
    masked.config[field] = value.length <= 4 ? '****' : `${'*'.repeat(Math.min(value.length - 4, 8))}${value.slice(-4)}`;
  }
  return masked;
}

// ─── Migração idempotente (mesmo padrão do activityLogger.ts) ──
let _migrated = false;
export async function ensureTables(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_providers (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id  UUID REFERENCES establishments(id) ON DELETE CASCADE,
      provider          TEXT NOT NULL,
      label             TEXT,
      config            JSONB NOT NULL DEFAULT '{}',
      is_primary        BOOLEAN NOT NULL DEFAULT false,
      priority          INTEGER NOT NULL DEFAULT 100,
      status            TEXT NOT NULL DEFAULT 'unknown',
      active            BOOLEAN NOT NULL DEFAULT true,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_providers_est ON sms_providers(establishment_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_providers_priority ON sms_providers(establishment_id, priority)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_dispatches (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id  UUID REFERENCES establishments(id) ON DELETE CASCADE,
      provider_id       UUID REFERENCES sms_providers(id) ON DELETE SET NULL,
      provider_type     TEXT,
      phone             TEXT NOT NULL,
      message           TEXT NOT NULL,
      action            TEXT DEFAULT 'notification',
      status            TEXT NOT NULL DEFAULT 'processing',
      external_id       TEXT,
      error_message     TEXT,
      used_failover     BOOLEAN NOT NULL DEFAULT false,
      idempotency_key   TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_dispatch_idem ON sms_dispatches(idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_dispatch_est ON sms_dispatches(establishment_id, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_logs (
      id                SERIAL PRIMARY KEY,
      provider_id       UUID REFERENCES sms_providers(id) ON DELETE SET NULL,
      provider_type     TEXT,
      action            TEXT,
      recipient         TEXT,
      success           BOOLEAN NOT NULL,
      response_time_ms  INTEGER,
      error_message     TEXT,
      used_failover     BOOLEAN NOT NULL DEFAULT false,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sms_logs_created ON sms_logs(created_at DESC)`);
}

// ─── Helpers ────────────────────────────────────────────────────
export function normalizePhone(phone: string): string | null {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits || null;
}

function applyGatewayTemplate(template: string, phone: string, message: string): string {
  return template
    .replace(/%NUMBER%/g, encodeURIComponent(phone))
    .replace(/%MESSAGE%/g, encodeURIComponent(message));
}

function decryptConfig(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...config };
  for (const field of SECRET_FIELDS) {
    if (out[field]) out[field] = decrypt(out[field]);
  }
  return out;
}

/** Criptografa os campos secretos antes de persistir (chamar ao salvar via admin) */
export function encryptConfig(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...config };
  for (const field of SECRET_FIELDS) {
    if (out[field]) out[field] = encrypt(String(out[field]));
  }
  return out;
}

// ─── Execução por provedor ───────────────────────────────────────
async function dispatchByProvider(row: SmsProviderRow, phone: string, message: string): Promise<{ ok: boolean; external_id?: string | null; error?: string | null }> {
  const cfg = decryptConfig(row.config);

  switch (row.provider) {
    case 'fake': {
      console.log(`[sms/fake] → ${phone}: ${message}`);
      return { ok: true, external_id: `fake-${Date.now()}` };
    }

    case 'android': {
      const res = await fetch(`${cfg.base_url}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body: JSON.stringify({ device_id: cfg.device_id, number: phone, message }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
      const body: any = await res.json().catch(() => ({}));
      return { ok: true, external_id: body.id || body.message_id || null };
    }

    case 'http_gateway': {
      const url = applyGatewayTemplate(
        cfg.url_template
          .replace('USER', cfg.sender_id || '')
          .replace('PASSWORD', cfg.api_key || ''),
        phone,
        message
      );
      const method = (cfg.http_method || 'GET').toUpperCase();
      const res = await fetch(url, { method });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
      return { ok: true, external_id: null };
    }

    // Fix de produção 57 — reescrito do zero contra a doc oficial
    // (smsmarket.docs.apiary.io). `phone` já chega só em dígitos (via
    // normalizePhone); a API quer DDI (`country_code`) e número LOCAL
    // (`number`) separados, então tira o "55" da frente se já vier
    // embutido (convenção usada no resto do projeto pro WhatsApp).
    // `type=0` = SMS não interativo (só notificação, sem esperar resposta —
    // é sempre esse o uso aqui: lembrete de cobrança, comando de
    // bloqueio/desbloqueio via SMS etc.). A API responde HTTP 200 mesmo em
    // erro lógico (saldo insuficiente, credencial inválida...) — o sucesso
    // de verdade só está no campo `success` do JSON, não no status HTTP.
    case 'smsmarket': {
      const digits = phone.replace(/\D/g, '');
      const localNumber = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
      // Fix de produção 57.2 — trim() pra não deixar espaço/quebra de linha
      // colado por engano virar "usuário/senha inválido" falso.
      const auth = Buffer.from(`${String(cfg.sender_id).trim()}:${String(cfg.api_key).trim()}`).toString('base64');
      const params = new URLSearchParams({
        type: '0',
        country_code: '55',
        number: localNumber,
        content: message,
      });
      const res = await fetch('https://api.smsmarket.com.br/webservice-rest/send-single', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        return { ok: false, error: body?.responseDescription || `HTTP ${res.status}` };
      }
      return { ok: true, external_id: body.id || null };
    }

    // Fix de produção 56 — confirmado contra a doc oficial
    // (traccar.org/http-sms-api/): a `base_url` JÁ É o endpoint completo
    // (sem path extra tipo "/send" — nem a relay `https://www.traccar.org/sms/`
    // do modo Cloud, nem a URL local do modo Direto, levam sufixo nenhum), o
    // header é `Authorization: <token>` sem prefixo "Bearer", e o corpo é só
    // `{ to, message }` (sem `device_id` — esse app não tem esse conceito).
    case 'traccar_sms': {
      const res = await fetch(cfg.base_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: cfg.api_key },
        body: JSON.stringify({ to: phone, message }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
      const body: any = await res.json().catch(() => ({}));
      return { ok: true, external_id: body?.id || null };
    }

    default:
      return { ok: false, error: `Provedor "${row.provider}" não suportado.` };
  }
}

// ─── Cadeia de failover ──────────────────────────────────────────
// Prioriza gateway próprio do estabelecimento (OWN); se não tiver, cai pro
// compartilhado da plataforma (SHARED, establishment_id IS NULL).
async function getProviderChain(establishmentId?: string | null): Promise<SmsProviderRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM sms_providers
     WHERE active = true AND (establishment_id = $1 OR establishment_id IS NULL)
     ORDER BY (establishment_id IS NULL) ASC, priority ASC`,
    [establishmentId || null]
  );
  if (rows.length === 0) {
    throw new Error('Nenhum gateway SMS configurado. Configure em Admin → Integrações → SMS.');
  }
  return rows;
}

// ─── API pública ──────────────────────────────────────────────────

export interface SendSmsOptions {
  establishmentId?: string | null;
  action?: string;
  idempotencyKey?: string;
}

export async function sendSms(phone: string, message: string, options: SendSmsOptions = {}): Promise<SendResult> {
  await ensureTables();
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error('Número de telefone inválido.');
  if (!message) throw new Error('Mensagem SMS obrigatória.');

  const { establishmentId = null, action = 'notification', idempotencyKey } = options;

  if (idempotencyKey) {
    const existing = await pool.query(`SELECT * FROM sms_dispatches WHERE idempotency_key = $1`, [idempotencyKey]);
    if (existing.rows[0] && ['sent', 'accepted', 'processing', 'queued'].includes(existing.rows[0].status)) {
      const d = existing.rows[0];
      return { success: true, provider: d.provider_type, provider_id: d.provider_id, used_failover: false, response_time_ms: 0, external_id: d.external_id };
    }
  }

  const dispatchRes = await pool.query(
    `INSERT INTO sms_dispatches (establishment_id, phone, message, action, status, idempotency_key)
     VALUES ($1,$2,$3,$4,'processing',$5) RETURNING id`,
    [establishmentId, normalizedPhone, message, action, idempotencyKey || null]
  );
  const dispatchId = dispatchRes.rows[0].id;

  const chain = await getProviderChain(establishmentId);
  const errors: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const row = chain[i];
    const usedFailover = i > 0;
    const start = Date.now();
    try {
      const result = await dispatchByProvider(row, normalizedPhone, message);
      const responseTime = Date.now() - start;

      if (!result.ok) throw new Error(result.error || 'Falha no gateway SMS.');

      await pool.query(`UPDATE sms_providers SET status = 'connected', updated_at = NOW() WHERE id = $1`, [row.id]);
      await pool.query(
        `UPDATE sms_dispatches SET provider_id=$1, provider_type=$2, status='sent', external_id=$3, used_failover=$4 WHERE id=$5`,
        [row.id, row.provider, result.external_id || null, usedFailover, dispatchId]
      );
      await pool.query(
        `INSERT INTO sms_logs (provider_id, provider_type, action, recipient, success, response_time_ms, used_failover)
         VALUES ($1,$2,$3,$4,true,$5,$6)`,
        [row.id, row.provider, action, normalizedPhone, responseTime, usedFailover]
      );

      return {
        success: true,
        provider: row.provider,
        provider_id: row.id,
        used_failover: usedFailover,
        response_time_ms: responseTime,
        external_id: result.external_id || null,
      };
    } catch (err: any) {
      const responseTime = Date.now() - start;
      errors.push(`${row.provider}: ${err.message}`);
      await pool.query(`UPDATE sms_providers SET status = 'error', updated_at = NOW() WHERE id = $1`, [row.id]);
      await pool.query(
        `INSERT INTO sms_logs (provider_id, provider_type, action, recipient, success, response_time_ms, error_message, used_failover)
         VALUES ($1,$2,$3,$4,false,$5,$6,$7)`,
        [row.id, row.provider, action, normalizedPhone, responseTime, err.message, usedFailover]
      );
    }
  }

  await pool.query(`UPDATE sms_dispatches SET status='failed', error_message=$1 WHERE id=$2`, [errors.join('; '), dispatchId]);
  throw new Error(`Todos os gateways SMS falharam: ${errors.join('; ')}`);
}

/** Atalho pra lembrete de cobrança — mesmo padrão de sendBillingReminder da Águia */
export async function sendBillingReminderSms(phone: string, data: { valor: string; vencimento: string; link?: string }, establishmentId?: string | null) {
  const text = `💰 Lembrete de cobrança\nValor: R$ ${data.valor}\nVencimento: ${data.vencimento}${data.link ? `\nPague aqui: ${data.link}` : ''}`;
  return sendSms(phone, text, { establishmentId, action: 'billing.reminder' });
}

// ─── CRUD de gateways (admin / lojista) ───────────────────────────

export async function listProviders(establishmentId?: string | null) {
  await ensureTables();
  const { rows } = await pool.query(
    `SELECT * FROM sms_providers WHERE establishment_id = $1 OR establishment_id IS NULL ORDER BY priority ASC`,
    [establishmentId || null]
  );
  return rows.map(maskProvider);
}

export async function createProviderConfig(data: { establishment_id?: string | null; provider: SmsProviderType; label?: string; config: Record<string, any>; priority?: number }) {
  await ensureTables();
  const encrypted = encryptConfig(data.config || {});
  const { rows } = await pool.query(
    `INSERT INTO sms_providers (establishment_id, provider, label, config, priority)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.establishment_id || null, data.provider, data.label || null, JSON.stringify(encrypted), data.priority ?? 100]
  );
  return maskProvider(rows[0]);
}

export async function updateProviderConfig(id: string, data: Partial<{ label: string; config: Record<string, any>; priority: number; active: boolean }>) {
  await ensureTables();
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (data.label !== undefined) { fields.push(`label = $${idx++}`); values.push(data.label); }
  if (data.config !== undefined) {
    // Merge com o config atual em vez de substituir — assim, deixar um campo
    // secreto em branco no formulário de edição ("manter o atual") não apaga
    // a credencial já salva. O update final continua sendo um replace no banco,
    // só que sobre o objeto já mesclado.
    const current = await pool.query(`SELECT config FROM sms_providers WHERE id = $1`, [id]);
    const existingConfig = current.rows[0]?.config || {};
    const merged = { ...existingConfig, ...encryptConfig(data.config) };
    fields.push(`config = $${idx++}`); values.push(JSON.stringify(merged));
  }
  if (data.priority !== undefined) { fields.push(`priority = $${idx++}`); values.push(data.priority); }
  if (data.active !== undefined) { fields.push(`active = $${idx++}`); values.push(data.active); }
  fields.push(`updated_at = NOW()`);

  values.push(id);
  const { rows } = await pool.query(`UPDATE sms_providers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, values);
  return rows[0] ? maskProvider(rows[0]) : null;
}

export async function deleteProviderConfig(id: string) {
  await ensureTables();
  await pool.query(`DELETE FROM sms_providers WHERE id = $1`, [id]);
}

export async function testProviderConnection(id: string) {
  await ensureTables();
  const { rows } = await pool.query(`SELECT * FROM sms_providers WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new Error('Provedor não encontrado.');

  const start = Date.now();
  try {
    if (row.provider === 'fake') {
      await pool.query(`UPDATE sms_providers SET status='connected', updated_at=NOW() WHERE id=$1`, [id]);
      return { ok: true, response_time_ms: Date.now() - start };
    }
    const cfg = decryptConfig(row.config);
    const schema = PROVIDER_TYPES[row.provider as SmsProviderType];
    const missing = (schema?.fields || []).filter(f => f.required && !cfg[f.key]);
    if (missing.length > 0) throw new Error(`Campos obrigatórios ausentes: ${missing.map(f => f.label).join(', ')}`);

    // Fix de produção 57 — SMSMarket tem um endpoint `GET /balance` que só
    // confere as credenciais (Basic user:senha) sem gastar crédito nem
    // mandar SMS de verdade — dá pra testar a conexão de verdade em vez de
    // só validar se os campos foram preenchidos, como os outros provedores
    // (que não têm um jeito barato de testar sem gerar SMS de verdade).
    if (row.provider === 'smsmarket') {
      // Fix de produção 57.2 — copiar/colar credenciais frequentemente traz
      // espaço ou quebra de linha escondida no fim; `trim()` evita um
      // "usuário/senha inválido" falso por causa disso.
      const auth = Buffer.from(`${String(cfg.sender_id).trim()}:${String(cfg.api_key).trim()}`).toString('base64');
      const res = await fetch('https://api.smsmarket.com.br/webservice-rest/balance', {
        headers: { Authorization: `Basic ${auth}` },
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        throw new Error(body?.responseDescription || `HTTP ${res.status}`);
      }
      await pool.query(`UPDATE sms_providers SET status='connected', updated_at=NOW() WHERE id=$1`, [id]);
      return { ok: true, response_time_ms: Date.now() - start };
    }

    // Teste leve pros demais provedores: só valida que a config essencial
    // existe (teste real de envio é custoso/gera SMS de verdade).
    await pool.query(`UPDATE sms_providers SET status='connected', updated_at=NOW() WHERE id=$1`, [id]);
    return { ok: true, response_time_ms: Date.now() - start };
  } catch (err: any) {
    await pool.query(`UPDATE sms_providers SET status='error', updated_at=NOW() WHERE id=$1`, [id]);
    return { ok: false, error: err.message, response_time_ms: Date.now() - start };
  }
}

export async function listDispatches(establishmentId?: string | null, limit = 50) {
  await ensureTables();
  const { rows } = await pool.query(
    `SELECT * FROM sms_dispatches WHERE establishment_id = $1 OR $1 IS NULL ORDER BY created_at DESC LIMIT $2`,
    [establishmentId || null, limit]
  );
  return rows;
}
