/**
 * ROTAS DE BILLING DA PLATAFORMA — AguiaON (Fase 5)
 * Prefixo: /admin/billing
 *
 * SUPERADMIN gerencia o catálogo de planos comerciais, atribui plano a cada
 * empresa, acompanha status de cobrança e pode desbloquear acesso a qualquer
 * momento. O lojista tem uma visão somente-leitura do próprio plano/fatura em
 * /admin/billing/mine (mesma convenção de /admin/sms/mine).
 *
 * IMPORTANTE: as rotas "/mine" usam requireAuth + checagem manual de role, e
 * NÃO requireRole — de propósito. requireRole('LOJISTA') aplica o bloqueio de
 * billing (ver authMiddleware.ts), e o lojista precisa conseguir ver a fatura
 * e pagar mesmo estando com o acesso bloqueado.
 */

import { Router, Request, Response } from 'express';
import { requireAdmin, requireAuth } from '../shared/authMiddleware';
import pool from '../shared/db';
import {
  listPlans,
  upsertPlan,
  deletePlan,
  generateInvoice,
  listInvoices,
  unblockEstablishment,
} from '../shared/platformBilling';

const router = Router();

// ═══════════════════════════════════════════════════
// CATÁLOGO DE PLANOS (SUPERADMIN)
// ═══════════════════════════════════════════════════

router.get('/plans', requireAdmin, async (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.all === '1';
    const plans = await listPlans(includeInactive);
    res.json({ plans });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/plans', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id, slug, name, price, billing_cycle_days, limits, active } = req.body || {};
    if (!slug || !name || price === undefined) {
      return res.status(400).json({ error: 'slug, name e price são obrigatórios.' });
    }
    const plan = await upsertPlan({ id, slug, name, price: Number(price), billing_cycle_days, limits, active });
    res.status(id ? 200 : 201).json({ plan });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/plans/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    await deletePlan(req.params.id);
    res.json({ ok: true });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// EMPRESAS — status de cobrança (SUPERADMIN)
// ═══════════════════════════════════════════════════

router.get('/establishments', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const r = await pool.query(`
      SELECT e.id, e.name, e.slug, e.billing_status, e.billing_warning_since,
             e.current_period_ends_at, p.id AS plan_id, p.name AS plan_name, p.price AS plan_price
      FROM establishments e
      LEFT JOIN platform_plans p ON p.id = e.platform_plan_id
      ORDER BY e.billing_status DESC, e.name ASC
    `);
    res.json({ establishments: r.rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/establishments/:id/plan', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { plan_id } = req.body || {};
    const r = await pool.query(
      `UPDATE establishments SET platform_plan_id=$1 WHERE id=$2 RETURNING id`,
      [plan_id || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/establishments/:id/generate-invoice', requireAdmin, async (req: Request, res: Response) => {
  try {
    const invoice = await generateInvoice(req.params.id);
    res.status(201).json({ invoice });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

router.get('/establishments/:id/invoices', requireAdmin, async (req: Request, res: Response) => {
  try {
    const invoices = await listInvoices(req.params.id, Number(req.query.limit) || 20);
    res.json({ invoices });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/establishments/:id/unblock', requireAdmin, async (req: Request, res: Response) => {
  try {
    await unblockEstablishment(req.params.id);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// AUTOATENDIMENTO DO LOJISTA (só leitura — sem requireRole, ver nota acima)
// ═══════════════════════════════════════════════════

router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  if (req.user!.role !== 'LOJISTA') return res.status(403).json({ error: 'Acesso negado.' });
  const estId = req.user!.establishmentId;
  if (!estId) return res.status(400).json({ error: 'Empresa não identificada.' });
  try {
    const r = await pool.query(`
      SELECT e.billing_status, e.billing_warning_since, e.current_period_ends_at,
             p.id AS plan_id, p.name AS plan_name, p.price AS plan_price, p.limits AS plan_limits
      FROM establishments e
      LEFT JOIN platform_plans p ON p.id = e.platform_plan_id
      WHERE e.id = $1
    `, [estId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa não encontrada.' });

    const invoices = await listInvoices(estId, 5);
    res.json({ ...r.rows[0], invoices });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
