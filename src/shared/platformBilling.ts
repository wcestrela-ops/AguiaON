/**
 * BILLING DA PLATAFORMA — AguiaON (Fase 5)
 *
 * O que a EMPRESA (establishment) paga a VOCÊS pra usar o AguiaON — diferente
 * do pixService.ts, que gera cobrança pro CLIENTE FINAL na conta da própria
 * empresa. Aqui a cobrança é sempre feita na conta DA PLATAFORMA (credenciais
 * em variável de ambiente), nunca na conta configurada pelo lojista.
 *
 * Regras de enforcement (decisão de produto, ver AguiaON-ROADMAP.md Fase 5):
 *
 *  - Limite de uso do plano (ex: máx. de veículos): bloqueio IMEDIATO e pontual
 *    via checkLimit() — só a ação que estouraria o limite é recusada (402), o
 *    resto do painel continua funcionando. É um teto de crescimento, não uma
 *    punição, então não tem carência.
 *
 *  - Fatura vencida: dá um aviso (billing_status='warning') e só bloqueia o
 *    painel inteiro do lojista depois de 2 dias sem pagamento
 *    (billing_status='blocked', enforced em authMiddleware.ts/requireRole).
 *    O SUPERADMIN pode reabrir o acesso a qualquer momento via
 *    unblockEstablishment() — a fatura em atraso continua registrada, só o
 *    acesso é liberado de novo.
 */

import pool from './db';

export interface PlatformPlan {
  id: string;
  slug: string;
  name: string;
  price: number;
  billing_cycle_days: number;
  limits: Record<string, number>;
  active: boolean;
}

const GRACE_PERIOD_MS = 2 * 24 * 60 * 60 * 1000; // 2 dias — decisão confirmada com o usuário

// ─── Migração idempotente (mesmo padrão do smsSender.ts/gpswoxClient.ts) ──────
let _migrated = false;
export async function ensureTables(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_plans (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug                TEXT UNIQUE NOT NULL,
      name                TEXT NOT NULL,
      price               NUMERIC(10,2) NOT NULL DEFAULT 0,
      billing_cycle_days  INTEGER NOT NULL DEFAULT 30,
      limits              JSONB NOT NULL DEFAULT '{}'::jsonb,
      active              BOOLEAN NOT NULL DEFAULT true,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS platform_plan_id UUID REFERENCES platform_plans(id)`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'active'`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS billing_warning_since TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS current_period_ends_at DATE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_invoices (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id    UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
      plan_id             UUID REFERENCES platform_plans(id),
      amount              NUMERIC(10,2) NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      provider            TEXT,
      pix_code            TEXT,
      due_date            DATE,
      paid_at             TIMESTAMPTZ,
      period_start        DATE,
      period_end          DATE,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_invoices_est_status ON platform_invoices(establishment_id, status)`);
}

// ═══════════════════════════════════════════════════
// PLANOS (CRUD usado pelas rotas admin)
// ═══════════════════════════════════════════════════

export async function listPlans(includeInactive = false): Promise<PlatformPlan[]> {
  await ensureTables();
  const where = includeInactive ? '' : 'WHERE active = true';
  const r = await pool.query(`SELECT * FROM platform_plans ${where} ORDER BY price ASC`);
  return r.rows;
}

export async function upsertPlan(data: {
  id?: string; slug: string; name: string; price: number;
  billing_cycle_days?: number; limits?: Record<string, number>; active?: boolean;
}): Promise<PlatformPlan> {
  await ensureTables();
  if (data.id) {
    const r = await pool.query(
      `UPDATE platform_plans SET slug=$1, name=$2, price=$3, billing_cycle_days=$4, limits=$5, active=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [data.slug, data.name, data.price, data.billing_cycle_days || 30, JSON.stringify(data.limits || {}), data.active ?? true, data.id]
    );
    if (!r.rows.length) throw new Error('Plano não encontrado.');
    return r.rows[0];
  }
  const r = await pool.query(
    `INSERT INTO platform_plans (slug, name, price, billing_cycle_days, limits, active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [data.slug, data.name, data.price, data.billing_cycle_days || 30, JSON.stringify(data.limits || {}), data.active ?? true]
  );
  return r.rows[0];
}

export async function deletePlan(id: string): Promise<void> {
  await ensureTables();
  try {
    await pool.query(`DELETE FROM platform_plans WHERE id=$1`, [id]);
  } catch (err: any) {
    if (err.code === '23503') throw new Error('Este plano está em uso por uma ou mais empresas e não pode ser excluído.');
    throw err;
  }
}

// ═══════════════════════════════════════════════════
// LIMITES DE USO (bloqueio imediato e pontual)
// ═══════════════════════════════════════════════════

export async function getPlanLimits(estId: string): Promise<Record<string, number>> {
  await ensureTables();
  const r = await pool.query(
    `SELECT p.limits FROM establishments e LEFT JOIN platform_plans p ON p.id = e.platform_plan_id WHERE e.id = $1`,
    [estId]
  );
  return r.rows[0]?.limits || {};
}

/**
 * Decide se uma nova unidade do recurso `key` pode ser criada, dado o mapa de
 * limites do plano e a contagem atual (contagem feita por fora — SQL varia por
 * recurso — pra manter esta função pura e testável sem banco).
 * Retorna null se estiver dentro do limite (ou sem limite definido = ilimitado),
 * ou uma mensagem de erro pronta pra devolver ao cliente se estourar.
 */
export function checkLimit(limits: Record<string, number>, key: string, currentCount: number): string | null {
  const max = limits[key];
  if (max === undefined || max === null) return null;
  if (currentCount >= max) {
    return `Limite do plano atingido (${max}). Faça upgrade do plano para adicionar mais.`;
  }
  return null;
}

// ═══════════════════════════════════════════════════
// STATUS DE COBRANÇA (aviso → bloqueio após 2 dias → desbloqueio manual)
// ═══════════════════════════════════════════════════

const statusCache: Record<string, { blocked: boolean; ts: number }> = {};
const CACHE_TTL_MS = 30_000;

export async function isBillingBlocked(estId: string): Promise<boolean> {
  const cached = statusCache[estId];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.blocked;

  await ensureTables();
  const r = await pool.query(`SELECT billing_status FROM establishments WHERE id = $1`, [estId]);
  const blocked = r.rows[0]?.billing_status === 'blocked';
  statusCache[estId] = { blocked, ts: Date.now() };
  return blocked;
}

export function invalidateBillingCache(estId?: string): void {
  if (estId) delete statusCache[estId];
  else for (const key in statusCache) delete statusCache[key];
}

/**
 * Reavalia o status de cobrança de UMA empresa a partir da fatura mais recente
 * em aberto. Chamada pelo job diário (billingJob.ts) e sob demanda (depois de
 * gerar fatura nova ou confirmar pagamento).
 */
export async function evaluateBillingHealth(estId: string): Promise<void> {
  await ensureTables();
  const est = await pool.query(`SELECT billing_status, billing_warning_since FROM establishments WHERE id = $1`, [estId]);
  if (!est.rows.length) return;
  const { billing_status, billing_warning_since } = est.rows[0];

  const overdue = await pool.query(
    `SELECT 1 FROM platform_invoices WHERE establishment_id = $1 AND status = 'pending' AND due_date < CURRENT_DATE LIMIT 1`,
    [estId]
  );

  if (overdue.rows.length) {
    if (billing_status === 'active') {
      await pool.query(`UPDATE establishments SET billing_status='warning', billing_warning_since=NOW() WHERE id=$1`, [estId]);
    } else if (billing_status === 'warning' && billing_warning_since) {
      const elapsed = Date.now() - new Date(billing_warning_since).getTime();
      if (elapsed >= GRACE_PERIOD_MS) {
        await pool.query(`UPDATE establishments SET billing_status='blocked' WHERE id=$1`, [estId]);
      }
    }
    // já 'blocked' → mantém até pagamento ou desbloqueio manual do SUPERADMIN
  } else if (billing_status !== 'active') {
    await pool.query(`UPDATE establishments SET billing_status='active', billing_warning_since=NULL WHERE id=$1`, [estId]);
  }
  invalidateBillingCache(estId);
}

/** Ação do SUPERADMIN: reabre o acesso imediatamente. A fatura em atraso, se existir, continua pendente. */
export async function unblockEstablishment(estId: string): Promise<void> {
  await ensureTables();
  await pool.query(`UPDATE establishments SET billing_status='active', billing_warning_since=NULL WHERE id=$1`, [estId]);
  invalidateBillingCache(estId);
}

// ═══════════════════════════════════════════════════
// GERAÇÃO DE FATURA + COBRANÇA PIX (conta da plataforma)
// ═══════════════════════════════════════════════════

export interface InvoiceResult {
  id: string;
  pix_code: string | null;
  amount: number;
  due_date: string;
}

async function generatePlatformAsaasPix(amount: number, estName: string, invoiceId: string): Promise<string | null> {
  const apiKey = process.env.PLATFORM_ASAAS_API_KEY;
  if (!apiKey) return null;
  try {
    const baseUrl = 'https://api.asaas.com/v3';

    const customerSearch = await fetch(`${baseUrl}/customers?name=${encodeURIComponent(estName)}&limit=1`, {
      headers: { access_token: apiKey },
    });
    const customerData = await customerSearch.json() as any;
    let customerId: string;

    if (customerData.data?.length) {
      customerId = customerData.data[0].id;
    } else {
      const createCustomer = await fetch(`${baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: apiKey },
        body: JSON.stringify({ name: estName }),
      });
      const newCustomer = await createCustomer.json() as any;
      customerId = newCustomer.id;
    }
    if (!customerId) return null;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 3);

    const chargeRes = await fetch(`${baseUrl}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: apiKey },
      body: JSON.stringify({
        customer: customerId,
        billingType: 'PIX',
        value: amount,
        dueDate: dueDate.toISOString().split('T')[0],
        description: `AguiaON — mensalidade ${estName}`,
        externalReference: `platform_${invoiceId}`,
      }),
    });
    const charge = await chargeRes.json() as any;
    if (!charge.id) return null;

    const pixRes = await fetch(`${baseUrl}/payments/${charge.id}/pixQrCode`, {
      headers: { access_token: apiKey },
    });
    const pixData = await pixRes.json() as any;
    return pixData.payload || null;
  } catch (err: any) {
    console.error('[platformBilling] Asaas error:', err.message);
    return null;
  }
}

/** Fallback manual: chave PIX fixa da plataforma, copia-e-cola (mesmo espírito do modo manual_pix do pixService.ts). */
function manualPixFallback(): string | null {
  return process.env.PLATFORM_PIX_KEY_VALUE || null;
}

/** Gera a fatura do ciclo atual + tenta emitir cobrança PIX. Sempre grava a fatura mesmo se o PIX falhar (fica 'provider: none', cobrança manual). */
export async function generateInvoice(estId: string): Promise<InvoiceResult> {
  await ensureTables();
  const estRes = await pool.query(
    `SELECT e.name, p.id AS plan_id, p.price, p.billing_cycle_days
     FROM establishments e LEFT JOIN platform_plans p ON p.id = e.platform_plan_id
     WHERE e.id = $1`,
    [estId]
  );
  if (!estRes.rows.length) throw new Error('Empresa não encontrada.');
  const est = estRes.rows[0];
  if (!est.plan_id) throw new Error('Empresa sem plano da plataforma definido.');

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 3);
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + (est.billing_cycle_days || 30));

  const dueDateStr = dueDate.toISOString().split('T')[0];
  const periodEndStr = periodEnd.toISOString().split('T')[0];

  const insertRes = await pool.query(
    `INSERT INTO platform_invoices (establishment_id, plan_id, amount, status, due_date, period_start, period_end)
     VALUES ($1,$2,$3,'pending',$4,CURRENT_DATE,$5) RETURNING id, due_date`,
    [estId, est.plan_id, est.price, dueDateStr, periodEndStr]
  );
  const invoice = insertRes.rows[0];

  let provider = 'asaas';
  let pixCode = await generatePlatformAsaasPix(Number(est.price), est.name, invoice.id);
  if (!pixCode) {
    pixCode = manualPixFallback();
    provider = pixCode ? 'manual' : 'none';
  }

  await pool.query(`UPDATE platform_invoices SET provider=$1, pix_code=$2 WHERE id=$3`, [provider, pixCode, invoice.id]);
  await pool.query(`UPDATE establishments SET current_period_ends_at=$1 WHERE id=$2`, [periodEndStr, estId]);

  await evaluateBillingHealth(estId);

  return { id: invoice.id, pix_code: pixCode, amount: Number(est.price), due_date: invoice.due_date };
}

/** Chamado pelo webhook do Asaas quando a fatura `platform_<id>` é confirmada. */
export async function markInvoicePaid(invoiceId: string): Promise<void> {
  await ensureTables();
  const r = await pool.query(
    `UPDATE platform_invoices SET status='paid', paid_at=NOW() WHERE id=$1 AND status='pending' RETURNING establishment_id`,
    [invoiceId]
  );
  if (r.rows.length) {
    const estId = r.rows[0].establishment_id;
    await evaluateBillingHealth(estId);
  }
}

export async function listInvoices(estId: string, limit = 20): Promise<any[]> {
  await ensureTables();
  const r = await pool.query(
    `SELECT * FROM platform_invoices WHERE establishment_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [estId, limit]
  );
  return r.rows;
}
