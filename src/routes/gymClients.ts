/**
 * ROTAS DE CLIENTES DA ACADEMIA — Águia-ON
 * Prefixo: /gym
 *
 * Tabelas:
 *  - gym_clients          — cadastro de alunos/clientes
 *  - gym_subscriptions    — planos de assinatura dos clientes
 *
 * Autenticação: LOJISTA ou SUPERADMIN
 */

import { Router, Request, Response } from 'express';
import pool from '../shared/db';
import { requireAuth, requireRole } from '../shared/authMiddleware';
import { sendWhatsAppMessage } from '../shared/waSender';
import { sseEmitEvent } from './delivery';

const router = Router();

// ── Helper tenant ────────────────────────────────────────────
function getEstId(req: Request): string {
  const user = req.user!;
  if (user.role === 'SUPERADMIN' && req.query.establishment_id)
    return req.query.establishment_id as string;
  if (user.role === 'SUPERADMIN' && (req.body as any)?.establishment_id)
    return (req.body as any).establishment_id;
  return user.establishmentId!;
}

// ── Migração (executa na inicialização) ─────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gym_clients (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        establishment_id UUID NOT NULL,
        name             TEXT NOT NULL,
        email            TEXT,
        whatsapp         TEXT,
        cpf              TEXT,
        birthdate        DATE,
        notes            TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gym_clients_est
        ON gym_clients(establishment_id)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gym_subscriptions (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        establishment_id UUID NOT NULL,
        client_id        UUID NOT NULL REFERENCES gym_clients(id) ON DELETE CASCADE,
        plan_name        TEXT NOT NULL,
        plan_value       NUMERIC(10,2) NOT NULL DEFAULT 0,
        start_date       DATE NOT NULL,
        expiry_date      DATE NOT NULL,
        renewal_cycle    TEXT NOT NULL DEFAULT 'monthly',
        status           TEXT NOT NULL DEFAULT 'active',
        notes            TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gym_subs_client
        ON gym_subscriptions(client_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gym_subs_est
        ON gym_subscriptions(establishment_id)
    `);

    // Coluna photo_base64 adicionada depois (compatibilidade)
    await pool.query(`ALTER TABLE gym_clients ADD COLUMN IF NOT EXISTS photo_base64 TEXT`);

    // Notificações para o portal do cliente
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gym_client_notifications (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        establishment_id UUID NOT NULL,
        client_id        UUID NOT NULL REFERENCES gym_clients(id) ON DELETE CASCADE,
        subscription_id  UUID REFERENCES gym_subscriptions(id) ON DELETE SET NULL,
        type             TEXT NOT NULL,  -- 'expiry_soon' | 'expired' | 'renewed' | 'welcome'
        title            TEXT NOT NULL,
        message          TEXT NOT NULL,
        read             BOOLEAN NOT NULL DEFAULT false,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_gym_notif_client
        ON gym_client_notifications(client_id, read, created_at DESC)
    `);

    // Coluna no gym_clients para ligar ao usuário do portal (user_id)
    await pool.query(`ALTER TABLE gym_clients ADD COLUMN IF NOT EXISTS user_id UUID`);

    // Colunas de configuração de notificações da academia
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS gym_notify_expiry_wa BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS gym_notify_billing_wa BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS gym_notify_billing_email BOOLEAN DEFAULT false`);

    console.log('[gymClients] tabelas gym prontas');
  } catch (err: any) {
    console.error('[gymClients] erro na migração:', err.message);
  }
})();

// ══════════════════════════════════════════════════════════════
// ROTAS PÚBLICAS (vitrine + portal do cliente) — sem auth de lojista
// ══════════════════════════════════════════════════════════════

// GET /gym/public/plans?est=<slug_ou_id> — planos visíveis na vitrine
router.get('/public/plans', async (req: Request, res: Response) => {
  const { est } = req.query as Record<string, string>;
  if (!est) return res.status(400).json({ error: 'est obrigatório.' });
  try {
    const estRes = await pool.query(
      `SELECT id, name, cor_destaque FROM establishments WHERE (id::text=$1 OR slug=$1) AND is_active=true LIMIT 1`,
      [est]
    );
    if (!estRes.rows.length) return res.status(404).json({ error: 'Academia não encontrada.' });
    const estId = estRes.rows[0].id;

    const plans = await pool.query(
      `SELECT id, name, description, price, settings
       FROM products
       WHERE establishment_id=$1 AND active=true AND type='plan'
       ORDER BY price ASC`,
      [estId]
    );
    res.json({ establishment: estRes.rows[0], plans: plans.rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /gym/public/subscribe — cliente assina um plano pela vitrine (requer token de cliente)
router.post('/public/subscribe', requireAuth, requireRole('CLIENT', 'LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const { establishment_id, plan_id, start_date } = req.body;
  if (!establishment_id || !plan_id) return res.status(400).json({ error: 'establishment_id e plan_id são obrigatórios.' });

  const userId = (req as any).user?.userId;
  const userPhone = (req as any).user?.whatsapp || (req as any).user?.phone;

  try {
    // Busca o plano no catálogo
    const planRes = await pool.query(
      `SELECT * FROM products WHERE id=$1 AND establishment_id=$2 AND type='plan' AND active=true LIMIT 1`,
      [plan_id, establishment_id]
    );
    if (!planRes.rows.length) return res.status(404).json({ error: 'Plano não encontrado.' });
    const plan = planRes.rows[0];

    const CYCLE_DAYS: Record<string, number> = {
      weekly:7, monthly:30, bimonthly:60, quarterly:90, semiannual:180, annual:365
    };
    const cycle = plan.settings?.recurrence || 'monthly';
    const days  = CYCLE_DAYS[cycle] || 30;

    const sDate  = start_date ? new Date(start_date + 'T12:00:00') : new Date();
    const eDate  = new Date(sDate);
    eDate.setDate(eDate.getDate() + days - 1);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    // Busca ou cria gym_client vinculado a este user_id
    let clientRow: any;
    const existingClient = await pool.query(
      `SELECT * FROM gym_clients WHERE user_id=$1 AND establishment_id=$2 LIMIT 1`,
      [userId, establishment_id]
    );
    if (existingClient.rows.length) {
      clientRow = existingClient.rows[0];
    } else {
      // Tenta puxar dados do usuário
      const userRes = await pool.query(
        `SELECT full_name, email, whatsapp FROM users WHERE id=$1 LIMIT 1`, [userId]
      );
      const u = userRes.rows[0] || {};
      const ins = await pool.query(
        `INSERT INTO gym_clients (establishment_id, user_id, name, email, whatsapp)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [establishment_id, userId, u.full_name || 'Cliente', u.email || null, u.whatsapp || userPhone || null]
      );
      clientRow = ins.rows[0];
    }

    // Cria a assinatura
    const subRes = await pool.query(
      `INSERT INTO gym_subscriptions
         (establishment_id, client_id, plan_name, plan_value, start_date, expiry_date, renewal_cycle, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,
      [establishment_id, clientRow.id, plan.name, plan.price, fmt(sDate), fmt(eDate), cycle]
    );
    const sub = subRes.rows[0];

    // Notificação de boas-vindas no portal do cliente
    await pool.query(
      `INSERT INTO gym_client_notifications
         (establishment_id, client_id, subscription_id, type, title, message)
       VALUES ($1,$2,$3,'welcome',$4,$5)`,
      [establishment_id, clientRow.id, sub.id,
       `✅ Assinatura ativada: ${plan.name}`,
       `Seu plano ${plan.name} está ativo até ${fmt(eDate)}. Bem-vindo(a)!`]
    );

    // Emite SSE para o painel do lojista
    const estRes = await pool.query(`SELECT name FROM establishments WHERE id=$1 LIMIT 1`, [establishment_id]);
    sseEmitEvent(establishment_id, {
      type: 'new_gym_subscription',
      client_name: clientRow.name,
      plan_name: plan.name,
      plan_value: plan.price,
      expiry_date: fmt(eDate),
    });

    // WA para o lojista (dono da academia) — fire-and-forget
    pool.query(
      `SELECT owner_whatsapp, gym_notify_expiry_wa FROM establishments WHERE id=$1 LIMIT 1`,
      [establishment_id]
    ).then(async r => {
      if (!r.rows.length) return;
      const { owner_whatsapp } = r.rows[0];
      if (owner_whatsapp) {
        const msg = `🏋️ *Nova assinatura!*\n\nCliente: *${clientRow.name}*\nPlano: *${plan.name}*\nValor: R$ ${parseFloat(plan.price).toFixed(2)}\nVencimento: ${fmt(eDate)}\n\nAcesse o painel para ver os detalhes.`;
        sendWhatsAppMessage(establishment_id, owner_whatsapp, msg).catch(() => {});
      }
    }).catch(() => {});

    res.status(201).json({ subscription: sub, client: clientRow });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /gym/public/notifications — notificações do portal do cliente (todas as academias)
router.get('/public/notifications', requireAuth, requireRole('CLIENT', 'LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  const { est } = req.query as Record<string, string>;
  try {
    let notifs;
    if (est) {
      const clientRes = await pool.query(
        `SELECT id FROM gym_clients WHERE user_id=$1 AND establishment_id=$2 LIMIT 1`,
        [userId, est]
      );
      if (!clientRes.rows.length) return res.json([]);
      notifs = await pool.query(
        `SELECT n.* FROM gym_client_notifications n WHERE n.client_id=$1 ORDER BY n.created_at DESC LIMIT 30`,
        [clientRes.rows[0].id]
      );
    } else {
      // Todas as academias vinculadas ao user
      notifs = await pool.query(
        `SELECT n.* FROM gym_client_notifications n
         JOIN gym_clients c ON c.id = n.client_id
         WHERE c.user_id=$1 ORDER BY n.created_at DESC LIMIT 30`,
        [userId]
      );
    }
    res.json(notifs.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /gym/public/notifications/:id/read — marcar como lida
router.patch('/public/notifications/:id/read', requireAuth, requireRole('CLIENT', 'LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const user = req.user!;
  try {
    // Isolamento multi-tenant: só marca como lida se a notificação pertencer
    // ao cliente autenticado (CLIENT) ou a um gym_client do establishment do lojista (LOJISTA)
    let result;
    if (user.role === 'SUPERADMIN') {
      result = await pool.query(`UPDATE gym_client_notifications SET read=true WHERE id=$1 RETURNING id`, [req.params.id]);
    } else if (user.role === 'LOJISTA') {
      result = await pool.query(
        `UPDATE gym_client_notifications n SET read=true
         FROM gym_clients c
         WHERE n.id=$1 AND n.client_id=c.id AND c.establishment_id=$2
         RETURNING n.id`,
        [req.params.id, user.establishmentId]
      );
    } else {
      result = await pool.query(
        `UPDATE gym_client_notifications n SET read=true
         FROM gym_clients c
         WHERE n.id=$1 AND n.client_id=c.id AND c.user_id=$2
         RETURNING n.id`,
        [req.params.id, user.userId]
      );
    }
    if (!result.rows.length) return res.status(404).json({ error: 'Notificação não encontrada.' });
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Middleware: requer LOJISTA ou SUPERADMIN ─────────────────
router.use(requireAuth, requireRole('LOJISTA', 'SUPERADMIN'));

// GET /gym/catalog-plans — retorna planos e serviços do catálogo para uso no modal de assinatura
router.get('/catalog-plans', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT id, name, price, type, settings
       FROM products
       WHERE establishment_id = $1
         AND active = true
         AND type IN ('plan', 'service')
       ORDER BY type DESC, name ASC`,
      [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CLIENTES
// ═══════════════════════════════════════════════════════════════

// GET /gym/clients — lista clientes com status da assinatura ativa
router.get('/clients', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { search, status } = req.query as Record<string, string>;
  try {
    let q = `
      SELECT
        c.*,
        s.id          AS sub_id,
        s.plan_name,
        s.plan_value,
        s.start_date,
        s.expiry_date,
        s.renewal_cycle,
        s.status      AS sub_status
      FROM gym_clients c
      LEFT JOIN LATERAL (
        SELECT * FROM gym_subscriptions
        WHERE client_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) s ON TRUE
      WHERE c.establishment_id = $1
    `;
    const params: any[] = [estId];

    if (search) {
      params.push(`%${search}%`);
      q += ` AND (c.name ILIKE $${params.length} OR c.whatsapp ILIKE $${params.length} OR c.email ILIKE $${params.length})`;
    }
    if (status === 'active')  { q += ` AND s.status = 'active' AND s.expiry_date >= CURRENT_DATE`; }
    if (status === 'expired') { q += ` AND (s.status = 'expired' OR s.expiry_date < CURRENT_DATE)`; }
    if (status === 'none')    { q += ` AND s.id IS NULL`; }

    q += ` ORDER BY c.name ASC`;

    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /gym/clients/:id — cliente + todas as assinaturas
router.get('/clients/:id', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const clientRes = await pool.query(
      `SELECT * FROM gym_clients WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]
    );
    if (!clientRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const subsRes = await pool.query(
      `SELECT * FROM gym_subscriptions WHERE client_id=$1 ORDER BY created_at DESC`, [req.params.id]
    );
    res.json({ ...clientRes.rows[0], subscriptions: subsRes.rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /gym/clients — cadastrar cliente
router.post('/clients', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { name, email, whatsapp, cpf, birthdate, notes, photo_base64 } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
  try {
    const result = await pool.query(
      `INSERT INTO gym_clients (establishment_id, name, email, whatsapp, cpf, birthdate, notes, photo_base64)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [estId, name.trim(), email||null, whatsapp||null, cpf||null, birthdate||null, notes||null, photo_base64||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /gym/clients/:id — atualizar cliente
router.put('/clients/:id', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { name, email, whatsapp, cpf, birthdate, notes, photo_base64 } = req.body;
  try {
    const result = await pool.query(
      `UPDATE gym_clients SET
         name=$3, email=$4, whatsapp=$5, cpf=$6,
         birthdate=$7, notes=$8, photo_base64=$9, updated_at=NOW()
       WHERE id=$1 AND establishment_id=$2 RETURNING *`,
      [req.params.id, estId, name, email||null, whatsapp||null, cpf||null, birthdate||null, notes||null, photo_base64||null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /gym/clients/:id
router.delete('/clients/:id', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    await pool.query(
      `DELETE FROM gym_clients WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]
    );
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ASSINATURAS
// ═══════════════════════════════════════════════════════════════

// GET /gym/clients/:id/subscriptions
router.get('/clients/:id/subscriptions', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT s.* FROM gym_subscriptions s
       JOIN gym_clients c ON c.id = s.client_id
       WHERE s.client_id=$1 AND c.establishment_id=$2
       ORDER BY s.created_at DESC`,
      [req.params.id, estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /gym/clients/:id/subscriptions — adicionar assinatura ao cliente
router.post('/clients/:id/subscriptions', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { plan_name, plan_value, start_date, expiry_date, renewal_cycle, notes } = req.body;
  if (!plan_name?.trim())  return res.status(400).json({ error: 'Nome do plano é obrigatório.' });
  if (!start_date)         return res.status(400).json({ error: 'Data de início é obrigatória.' });
  if (!expiry_date)        return res.status(400).json({ error: 'Data de vencimento é obrigatória.' });

  try {
    // Verifica que o cliente pertence a este estabelecimento
    const clientRes = await pool.query(
      `SELECT id FROM gym_clients WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]
    );
    if (!clientRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const result = await pool.query(
      `INSERT INTO gym_subscriptions
         (establishment_id, client_id, plan_name, plan_value, start_date, expiry_date, renewal_cycle, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8) RETURNING *`,
      [estId, req.params.id, plan_name.trim(), plan_value||0, start_date, expiry_date,
       renewal_cycle||'monthly', notes||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /gym/subscriptions/:subId — atualizar assinatura
router.put('/subscriptions/:subId', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { plan_name, plan_value, start_date, expiry_date, renewal_cycle, status, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE gym_subscriptions SET
         plan_name=$3, plan_value=$4, start_date=$5, expiry_date=$6,
         renewal_cycle=$7, status=$8, notes=$9, updated_at=NOW()
       WHERE id=$1 AND establishment_id=$2 RETURNING *`,
      [req.params.subId, estId, plan_name, plan_value||0, start_date, expiry_date,
       renewal_cycle||'monthly', status||'active', notes||null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Assinatura não encontrada.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /gym/subscriptions/:subId
router.delete('/subscriptions/:subId', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    await pool.query(
      `DELETE FROM gym_subscriptions WHERE id=$1 AND establishment_id=$2`, [req.params.subId, estId]
    );
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /gym/subscriptions/:subId/renew — renovar assinatura (cria novo ciclo)
router.post('/subscriptions/:subId/renew', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const subRes = await pool.query(
      `SELECT * FROM gym_subscriptions WHERE id=$1 AND establishment_id=$2`, [req.params.subId, estId]
    );
    if (!subRes.rows.length) return res.status(404).json({ error: 'Assinatura não encontrada.' });
    const sub = subRes.rows[0];

    // Calcula nova data de vencimento baseado no ciclo
    const CYCLE_DAYS: Record<string, number> = {
      weekly: 7, monthly: 30, bimonthly: 60,
      quarterly: 90, semiannual: 180, annual: 365,
    };
    const days = CYCLE_DAYS[sub.renewal_cycle] || 30;
    const newStart = new Date(sub.expiry_date);
    newStart.setDate(newStart.getDate() + 1);
    const newExpiry = new Date(newStart);
    newExpiry.setDate(newExpiry.getDate() + days - 1);

    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const result = await pool.query(
      `INSERT INTO gym_subscriptions
         (establishment_id, client_id, plan_name, plan_value, start_date, expiry_date, renewal_cycle, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8) RETURNING *`,
      [estId, sub.client_id, sub.plan_name, sub.plan_value,
       fmt(newStart), fmt(newExpiry), sub.renewal_cycle, sub.notes]
    );

    // Marca a anterior como renovada
    await pool.query(
      `UPDATE gym_subscriptions SET status='renewed', updated_at=NOW() WHERE id=$1`, [sub.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /gym/dashboard — resumo de vencimentos para o painel
// GET /gym/settings — configurações de notificação da academia
router.get('/settings', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const r = await pool.query(
      `SELECT gym_notify_expiry_wa, gym_notify_billing_wa, gym_notify_billing_email
       FROM establishments WHERE id=$1`,
      [estId]
    );
    res.json(r.rows[0] || {});
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /gym/settings — salva configurações de notificação da academia
router.put('/settings', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { gym_notify_expiry_wa, gym_notify_billing_wa, gym_notify_billing_email } = req.body;
  try {
    await pool.query(
      `UPDATE establishments SET
         gym_notify_expiry_wa      = COALESCE($1, gym_notify_expiry_wa),
         gym_notify_billing_wa     = COALESCE($2, gym_notify_billing_wa),
         gym_notify_billing_email  = COALESCE($3, gym_notify_billing_email),
         updated_at = NOW()
       WHERE id=$4`,
      [
        gym_notify_expiry_wa      ?? null,
        gym_notify_billing_wa     ?? null,
        gym_notify_billing_email  ?? null,
        estId,
      ]
    );
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/dashboard', async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT c.id)                                             AS total_clients,
        COUNT(DISTINCT CASE WHEN s.status='active' AND s.expiry_date >= CURRENT_DATE THEN c.id END) AS active_subs,
        COUNT(DISTINCT CASE WHEN s.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7 THEN c.id END) AS expiring_soon,
        COUNT(DISTINCT CASE WHEN s.expiry_date < CURRENT_DATE AND s.status='active' THEN c.id END)   AS overdue
      FROM gym_clients c
      LEFT JOIN gym_subscriptions s ON s.client_id = c.id AND s.status IN ('active','expired')
        AND s.id = (SELECT id FROM gym_subscriptions WHERE client_id=c.id ORDER BY created_at DESC LIMIT 1)
      WHERE c.establishment_id = $1
    `, [estId]);
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
