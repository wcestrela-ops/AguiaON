/**
 * ROTAS DE DELIVERY — AG-ON
 * Prefixo: /delivery
 *
 * Cobre:
 *  - Configurações de entrega da loja (tax, zones, tipo)
 *  - Complementos/opcionais de produto (product_options / product_option_items)
 *  - Variantes de produto (tamanho/sabor com preço diferente)
 *  - Mesas de restaurante (restaurant_tables)
 *  - Pedidos (delivery_orders) — CRUD + troca de status + tempo real
 *  - Rastreamento público de pedido
 *  - Mensagem de motoboy
 *  - Catálogo JSON para a Ágata
 *
 * Autenticação:
 *  - Rotas de gestão: LOJISTA ou SUPERADMIN
 *  - Criação e rastreamento de pedido: público (clientes sem login)
 */

import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import pool from '../shared/db';
import { requireAuth, requireRole } from '../shared/authMiddleware';
import { generatePix } from '../shared/pixService';
import { decrypt } from '../shared/cryptoUtil';
import { checkStoreOpen } from '../shared/businessHours';
import { PostgresRateLimitStore } from '../shared/rateLimitStore';
import {
  sendWhatsAppMessage,
  getOwnerWhatsApp,
  msgNovosPedidoLojista,
  msgConfirmacaoCliente,
  msgStatusClienteAsync,
  msgEntregador,
  invalidateWAConfigCache,
} from '../shared/waSender';
import { logActivity } from '../shared/activityLogger';

const router = Router();

// ── Migração de colunas (executa na inicialização) ────────────
(async () => {
  try {
    await pool.query(`ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7)`);
    await pool.query(`ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7)`);
    await pool.query(`ALTER TABLE user_addresses  ADD COLUMN IF NOT EXISTS lat DECIMAL(10,7)`);
    await pool.query(`ALTER TABLE user_addresses  ADD COLUMN IF NOT EXISTS lng DECIMAL(10,7)`);
  } catch (e) { console.error('[delivery] migration error:', e); }
})();

// Rate limit para rotas de lookup de cliente — 5 req/5min por IP+phone
const lookupRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: { error: 'Muitas consultas. Aguarde alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore(),
  keyGenerator: (req) => {
    const ip = ipKeyGenerator(req.ip ?? '127.0.0.1');
    const phone = (req.body?.phone || req.query?.phone || '').replace(/\D/g, '');
    return `lookup:${ip}:${phone}`;
  },
});

// Rate limit: máximo 10 pedidos por IP a cada 10 minutos (anti-bot/flood)
const orderRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos para fazer um novo pedido.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore(),
  keyGenerator: (req) => {
    // Isola por IP + establishment_id — não penaliza IPs que pedem em lojas diferentes
    const ip = ipKeyGenerator(req.ip ?? '127.0.0.1');
    const estId = req.body?.establishment_id || 'unknown';
    return `order:${ip}:${estId}`;
  },
});

// ─── Helper tenant ────────────────────────────────────────────
function getEstId(req: Request): string {
  const user = req.user!;
  if (user.role === 'LOJISTA' || user.role === 'STAFF') return user.establishmentId!;
  return (req.body?.establishment_id as string) || (req.query.establishment_id as string) || '';
}

// ─── SSE: Notificações em tempo real para lojistas ───────────
// Map: establishment_id → Set de res (clientes SSE conectados)
const sseClients = new Map<string, Set<Response>>();

function sseSubscribe(estId: string, res: Response) {
  if (!sseClients.has(estId)) sseClients.set(estId, new Set());
  sseClients.get(estId)!.add(res);
}

function sseUnsubscribe(estId: string, res: Response) {
  sseClients.get(estId)?.delete(res);
}

function sseEmit(estId: string, payload: object) {
  const clients = sseClients.get(estId);
  if (!clients?.size) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(res => {
    try { res.write(data); } catch { sseUnsubscribe(estId, res); }
  });
}

export function sseEmitNewOrder(estId: string, order: any) {
  sseEmit(estId, { type: 'new_order', order });
}

export function sseEmitEvent(estId: string, payload: object) {
  sseEmit(estId, payload);
}

// GET /delivery/orders/sse — stream SSE de novos pedidos
// Aceita token via cookie (preferido) ou query param como fallback
router.get('/orders/sse', (req: Request, res: Response) => {
  // Query param tem prioridade: o cliente JS sempre o envia explicitamente com o token correto.
  // Cookie é fallback (pode ser de outro papel se o usuário também acessou a vitrine como cliente).
  const rawToken = (req.query.token as string) || (req.cookies?.auth_token as string) || '';
  let estId = (req.query.establishment_id as string) || '';
  try {
    const secret = process.env.JWT_SECRET!;
    const payload = require('jsonwebtoken').verify(rawToken, secret) as any;
    if (!['LOJISTA', 'SUPERADMIN'].includes(payload.role)) {
      return res.status(403).end();
    }
    if (payload.role === 'LOJISTA') estId = payload.establishmentId;
  } catch {
    return res.status(401).end();
  }
  if (!estId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // desativa buffer do Nginx
  res.flushHeaders();

  // Envia ping inicial para confirmar conexão
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  sseSubscribe(estId, res);

  // Keep-alive a cada 25s (evita timeout do proxy)
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseUnsubscribe(estId, res);
  });
});

// ═══════════════════════════════════════════════════
// CONFIGURAÇÕES DE ENTREGA
// ═══════════════════════════════════════════════════

router.get('/config', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const [estRes, zonesRes] = await Promise.all([
      pool.query(
        `SELECT delivery_tax, free_delivery_over, estimated_time, delivery_type, min_order, zone_type
         FROM establishments WHERE id = $1`, [estId]),
      pool.query(
        `SELECT * FROM delivery_zones WHERE establishment_id = $1 ORDER BY city ASC, name ASC`, [estId]),
    ]);
    res.json({ ...(estRes.rows[0] || {}), zones: zonesRes.rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/config', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  const { delivery_tax, free_delivery_over, estimated_time, delivery_type, min_order, zone_type } = req.body;
  try {
    await pool.query(
      `UPDATE establishments SET
         delivery_tax=$1, free_delivery_over=$2, estimated_time=$3,
         delivery_type=$4, min_order=$5, zone_type=$6, updated_at=NOW()
       WHERE id=$7`,
      [delivery_tax ?? 0, free_delivery_over ?? 0, estimated_time || '30-45 min',
       delivery_type || 'both', min_order ?? 0, zone_type || 'neighborhood', estId]
    );
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// ZONAS DE ENTREGA
// ═══════════════════════════════════════════════════

router.post('/zones', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { id, name, city, delivery_tax, estimated_time, is_active } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório.' });
  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE delivery_zones SET name=$1, city=$2, delivery_tax=$3, estimated_time=$4, is_active=$5
         WHERE id=$6 AND establishment_id=$7 RETURNING *`,
        [name, city || null, delivery_tax ?? 0, estimated_time || null, is_active !== false, id, estId]
      );
    } else {
      result = await pool.query(
        `INSERT INTO delivery_zones (establishment_id, name, city, delivery_tax, estimated_time, is_active)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [estId, name, city || null, delivery_tax ?? 0, estimated_time || null, is_active !== false]
      );
    }
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/zones/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    await pool.query(`DELETE FROM delivery_zones WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// MESAS DE RESTAURANTE
// ═══════════════════════════════════════════════════

// GET /delivery/tables — lista mesas do estabelecimento
router.get('/tables', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const result = await pool.query(
      `SELECT t.*,
              (SELECT COALESCE(SUM(o2.total),0) FROM delivery_orders o2
               WHERE o2.table_id=t.id AND o2.establishment_id=t.establishment_id
                 AND o2.status NOT IN ('cancelled','delivered')) AS order_total,
              (SELECT COUNT(*) FROM delivery_orders o3
               WHERE o3.table_id=t.id AND o3.establishment_id=t.establishment_id
                 AND o3.status NOT IN ('cancelled','delivered')) AS order_count
       FROM restaurant_tables t
       WHERE t.establishment_id = $1
       ORDER BY t.table_number ASC`,
      [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/tables/public/:establishment_id — mapa de mesas público (totem/garçom)
router.get('/tables/public/:establishment_id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, table_number, status, seats FROM restaurant_tables
       WHERE establishment_id = $1 ORDER BY table_number ASC`,
      [req.params.establishment_id]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/tables — criar ou editar mesa
router.post('/tables', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { id, table_number, seats } = req.body;
  if (!table_number) return res.status(400).json({ error: 'table_number obrigatório.' });
  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE restaurant_tables SET table_number=$1, seats=$2, updated_at=NOW()
         WHERE id=$3 AND establishment_id=$4 RETURNING *`,
        [table_number, seats ?? 4, id, estId]
      );
    } else {
      result = await pool.query(
        `INSERT INTO restaurant_tables (establishment_id, table_number, seats)
         VALUES ($1,$2,$3) RETURNING *`,
        [estId, table_number, seats ?? 4]
      );
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Número de mesa já existe.' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /delivery/tables/:id/status — atualiza status da mesa (livre/ocupada/conta_solicitada)
router.patch('/tables/:id/status', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { status, current_order_id } = req.body;
  const valid = ['livre', 'ocupada', 'conta_solicitada'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  try {
    const result = await pool.query(
      `UPDATE restaurant_tables
       SET status=$1, current_order_id=$2, updated_at=NOW()
       WHERE id=$3 AND establishment_id=$4 RETURNING *`,
      [status, current_order_id || null, req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mesa não encontrada.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /delivery/tables/:id
router.delete('/tables/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    await pool.query(
      `DELETE FROM restaurant_tables WHERE id=$1 AND establishment_id=$2`,
      [req.params.id, estId]
    );
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/tables/:id/orders — todos os pedidos de uma mesa (lojista/staff/público via token)
router.get('/tables/:id/orders', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT o.*, t.table_number
       FROM delivery_orders o
       JOIN restaurant_tables t ON t.id = o.table_id
       WHERE o.table_id = $1 AND o.establishment_id = $2
         AND o.status NOT IN ('cancelled')
       ORDER BY o.created_at ASC`,
      [req.params.id, estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/public/tables/:id/request-bill — cliente pede a conta (público)
router.post('/public/tables/:id/request-bill', async (req: Request, res: Response) => {
  const { establishment_id, customer_name } = req.body;
  if (!establishment_id) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const r = await pool.query(
      `UPDATE restaurant_tables SET status='conta_solicitada', updated_at=NOW()
       WHERE id=$1 AND establishment_id=$2 RETURNING *`,
      [req.params.id, establishment_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Mesa não encontrada.' });
    const billPayload = {
      table_id:     req.params.id,
      table_number: r.rows[0].table_number,
      customer_name: customer_name || r.rows[0].customer_name || 'Cliente',
    };
    // Emite via SSE (loja.html) e Socket.io (garcom.html)
    sseEmit(establishment_id, { type: 'table_bill_requested', ...billPayload });
    const { emitToStore } = await import('../shared/socketio');
    emitToStore(establishment_id, 'table_bill_requested', billPayload);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/public/tables/:id — dados básicos da mesa (público, para cliente)
router.get('/public/tables/:id', async (req: Request, res: Response) => {
  const { establishment_id } = req.query as Record<string, string>;
  if (!establishment_id) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const r = await pool.query(
      `SELECT t.id, t.table_number, t.status, t.seats, t.customer_name,
              e.name AS store_name
       FROM restaurant_tables t
       JOIN establishments e ON e.id = t.establishment_id
       WHERE t.id=$1 AND t.establishment_id=$2`,
      [req.params.id, establishment_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Mesa não encontrada.' });
    res.json(r.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/public/tables/:id/orders — pedidos da mesa (público, para cliente ver)
// Filtra pelo session_id do cliente — cada visita só vê os próprios pedidos
router.get('/public/tables/:id/orders', async (req: Request, res: Response) => {
  const { establishment_id, session_id } = req.query as Record<string, string>;
  if (!establishment_id) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  if (!session_id)       return res.status(400).json({ error: 'session_id obrigatório.' });
  try {
    const result = await pool.query(
      `SELECT id, order_number, daily_code, status, items, subtotal, delivery_tax, total,
              customer_name, payment_method, notes, created_at
       FROM delivery_orders
       WHERE table_id=$1 AND establishment_id=$2 AND session_id=$3 AND status NOT IN ('cancelled')
       ORDER BY created_at ASC`,
      [req.params.id, establishment_id, session_id]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/tables/:id/open — finaliza todos os pedidos e libera a mesa
router.post('/tables/:id/open', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    // Marca todos os pedidos ativos da mesa como entregue
    await pool.query(
      `UPDATE delivery_orders SET status='delivered', updated_at=NOW()
       WHERE table_id=$1 AND establishment_id=$2 AND status NOT IN ('delivered','cancelled')`,
      [req.params.id, estId]
    );
    // Libera a mesa
    const r = await pool.query(
      `UPDATE restaurant_tables
       SET status='livre', current_order_id=NULL, customer_name=NULL, updated_at=NOW()
       WHERE id=$1 AND establishment_id=$2 RETURNING *`,
      [req.params.id, estId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Mesa não encontrada.' });
    // Notifica lojista via SSE para atualizar lista de mesas
    sseEmit(estId, { type: 'table_updated', table: r.rows[0] });
    res.json({ success: true, table: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// VARIANTES DE PRODUTO (tamanho/sabor com preço diferente)
// ═══════════════════════════════════════════════════

// GET /delivery/variants/:product_id
router.get('/variants/:product_id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM product_variants
       WHERE product_id=$1 AND is_active=true
       ORDER BY type ASC, order_index ASC`,
      [req.params.product_id]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/variants — criar ou editar variante
router.post('/variants', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const { id, product_id, type, name, price_adjustment, is_required, order_index } = req.body;
  if (!product_id || !name) return res.status(400).json({ error: 'product_id e name obrigatórios.' });
  const validTypes = ['tamanho', 'sabor', 'adicional'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'type deve ser: tamanho, sabor ou adicional.' });
  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE product_variants
         SET type=$1, name=$2, price_adjustment=$3, is_required=$4, order_index=$5
         WHERE id=$6 RETURNING *`,
        [type, name, price_adjustment ?? 0, is_required ?? false, order_index ?? 0, id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO product_variants (product_id, type, name, price_adjustment, is_required, order_index)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [product_id, type, name, price_adjustment ?? 0, is_required ?? false, order_index ?? 0]
      );
      // Marca produto como tendo variantes
      await pool.query(`UPDATE products SET has_variants=true WHERE id=$1`, [product_id]);
    }
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /delivery/variants/:id
router.delete('/variants/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  try {
    const varRes = await pool.query(`DELETE FROM product_variants WHERE id=$1 RETURNING product_id`, [req.params.id]);
    if (varRes.rows.length) {
      // Se não sobrou variante, desmarca has_variants
      const remaining = await pool.query(
        `SELECT 1 FROM product_variants WHERE product_id=$1 AND is_active=true LIMIT 1`,
        [varRes.rows[0].product_id]
      );
      if (!remaining.rows.length) {
        await pool.query(`UPDATE products SET has_variants=false WHERE id=$1`, [varRes.rows[0].product_id]);
      }
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// OPCIONAIS / COMPLEMENTOS
// ═══════════════════════════════════════════════════

router.get('/options/:product_id', async (req: Request, res: Response) => {
  try {
    const pid = req.params.product_id;

    // Carrega os dois sistemas em paralelo
    const [optRes, addonRes] = await Promise.all([
      pool.query(
        `SELECT * FROM product_options WHERE product_id=$1 ORDER BY order_index ASC`, [pid]
      ),
      pool.query(
        `SELECT ag.id, ag.name, ag.min_qty, ag.max_qty, ag.is_required, pag.sort_order,
                agi.id AS item_id, agi.name AS item_name, agi.price AS item_price, agi.sort_order AS item_sort
         FROM product_addon_groups pag
         JOIN addon_groups ag ON ag.id = pag.addon_group_id
         JOIN addon_group_items agi ON agi.addon_group_id = ag.id AND agi.is_active = true
         WHERE pag.product_id = $1
         ORDER BY pag.sort_order ASC, agi.sort_order ASC`,
        [pid]
      ).catch(() => ({ rows: [] as any[] })),
    ]);

    // Monta product_options com seus itens
    const options = optRes.rows;
    if (options.length) {
      const ids = options.map((o: any) => o.id);
      const itemsRes = await pool.query(
        `SELECT * FROM product_option_items WHERE option_id = ANY($1) AND is_active=true ORDER BY order_index ASC`,
        [ids]
      );
      const itemsByOption: Record<string, any[]> = {};
      itemsRes.rows.forEach((it: any) => {
        if (!itemsByOption[it.option_id]) itemsByOption[it.option_id] = [];
        itemsByOption[it.option_id].push(it);
      });
      options.forEach((o: any) => { o.items = itemsByOption[o.id] || []; });
    }

    // Normaliza addon_groups para o mesmo formato de product_options
    // { id, name, min_options, max_options, is_required, items: [{id, name, additional_price}] }
    const addonGroupsMap: Record<string, any> = {};
    addonRes.rows.forEach((row: any) => {
      if (!addonGroupsMap[row.id]) {
        addonGroupsMap[row.id] = {
          id:          row.id,
          name:        row.name,
          min_options: row.min_qty  || 0,
          max_options: row.max_qty  || 1,
          is_required: row.is_required,
          sort_order:  row.sort_order,
          items: [],
        };
      }
      addonGroupsMap[row.id].items.push({
        id:               row.item_id,
        name:             row.item_name,
        additional_price: +row.item_price || 0,
        order_index:      row.item_sort,
      });
    });

    // Retorna product_options primeiro, depois addon_groups normalizados
    const merged = [
      ...options,
      ...Object.values(addonGroupsMap).sort((a: any, b: any) => a.sort_order - b.sort_order),
    ];

    res.json(merged);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/options', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const { id, product_id, name, min_options, max_options, is_required, order_index } = req.body;
  if (!product_id || !name) return res.status(400).json({ error: 'product_id e name obrigatórios.' });
  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE product_options SET name=$1, min_options=$2, max_options=$3, is_required=$4, order_index=$5
         WHERE id=$6 RETURNING *`,
        [name, min_options ?? 0, max_options ?? 1, is_required ?? false, order_index ?? 0, id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO product_options (product_id, name, min_options, max_options, is_required, order_index)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [product_id, name, min_options ?? 0, max_options ?? 1, is_required ?? false, order_index ?? 0]
      );
    }
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/options/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  try {
    await pool.query(`DELETE FROM product_options WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/option-items', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const { id, option_id, name, additional_price, is_active, order_index } = req.body;
  if (!option_id || !name) return res.status(400).json({ error: 'option_id e name obrigatórios.' });
  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE product_option_items SET name=$1, additional_price=$2, is_active=$3, order_index=$4
         WHERE id=$5 RETURNING *`,
        [name, additional_price ?? 0, is_active !== false, order_index ?? 0, id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO product_option_items (option_id, name, additional_price, is_active, order_index)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [option_id, name, additional_price ?? 0, is_active !== false, order_index ?? 0]
      );
    }
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/option-items/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  try {
    await pool.query(`DELETE FROM product_option_items WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// PEDIDOS
// ═══════════════════════════════════════════════════

// GET /delivery/orders/realtime — pedidos ativos em tempo real para o painel do lojista
// ATENÇÃO: deve vir ANTES de /orders/:id para não conflitar
router.get('/orders/realtime', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT * FROM delivery_orders
       WHERE establishment_id=$1
         AND status NOT IN ('delivered','cancelled')
       ORDER BY
         CASE source WHEN 'agata_wa' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 100`,
      [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/orders — lista pedidos com filtros
router.get('/orders', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { status, date, source, from, to } = req.query as Record<string, string>;
  try {
    const conditions = ['o.establishment_id=$1'];
    const params: any[] = [estId];
    if (status) { params.push(status); conditions.push(`o.status=$${params.length}`); }
    if (date)   { params.push(date);   conditions.push(`o.created_at::date=$${params.length}`); }
    if (from)   { params.push(from);   conditions.push(`o.created_at::date >= $${params.length}`); }
    if (to)     { params.push(to);     conditions.push(`o.created_at::date <= $${params.length}`); }
    if (source) { params.push(source); conditions.push(`o.source=$${params.length}`); }

    // Entregador: só vê pedidos de delivery/pickup atribuídos a ele (ou pendentes sem atribuição)
    const user = req.user!;
    if (user.role === 'STAFF' && user.memberRole === 'entregador') {
      conditions.push(`o.delivery_type IN ('delivery','pickup','scheduled_pickup')`);
      conditions.push(`o.status NOT IN ('delivered','cancelled')`);
      params.push(user.userId);
      conditions.push(`(o.assigned_to=$${params.length} OR o.assigned_to IS NULL)`);
    }

    const result = await pool.query(
      `SELECT o.*, t.table_number
       FROM delivery_orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.created_at DESC LIMIT 200`,
      params
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/orders/:id/track — rastreamento público (sem autenticação)
router.get('/orders/:id/track', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, order_number, customer_name, status, delivery_type,
              subtotal, delivery_tax, total, notes, source,
              created_at, updated_at
       FROM delivery_orders WHERE id=$1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const order = result.rows[0];
    // Mapa de status com labels amigáveis para o cliente
    const statusLabels: Record<string, string> = {
      pending:    'Aguardando confirmação',
      confirmed:  'Confirmado',
      preparing:  'Preparando seu pedido',
      delivering: 'Saiu para entrega',
      delivered:  'Entregue',
      cancelled:  'Cancelado',
    };
    res.json({ ...order, status_label: statusLabels[order.status] || order.status });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/orders/:id/receipt — cupom térmico HTML (80mm) para impressão
// Aceita token via query param (?token=...) para abrir em nova aba sem header Authorization
router.get('/orders/:id/receipt', async (req: Request, res: Response) => {
  // Valida token — header Authorization ou ?token=
  const rawToken = (req.headers.authorization?.split(' ')[1]) || (req.query.token as string);
  if (!rawToken) return res.status(401).send('<p>Token não fornecido.</p>');
  let estId: string;
  try {
    const secret = process.env.JWT_SECRET!;
    const payload = require('jsonwebtoken').verify(rawToken, secret) as any;
    estId = payload.role === 'LOJISTA' ? payload.establishmentId
          : (req.query.establishment_id as string) || '';
    if (!estId) return res.status(400).send('<p>establishment_id obrigatório para SUPERADMIN.</p>');
  } catch {
    return res.status(401).send('<p>Token inválido.</p>');
  }
  try {
    const result = await pool.query(
      `SELECT o.*, e.name AS store_name, e.owner_whatsapp, t.table_number
       FROM delivery_orders o
       JOIN establishments e ON e.id = o.establishment_id
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       WHERE o.id=$1 AND o.establishment_id=$2`,
      [req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).send('Pedido não encontrado.');

    const o = result.rows[0];
    const items: any[] = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    const now = new Date().toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const payLabel: Record<string, string> = {
      pix: 'PIX', cartao: 'Cartão', na_entrega: 'Na entrega',
    };

    const itemRows = items.map((it: any) => {
      // selected_options: pedidos da vitrine (preço base + adicionais separados)
      // addons: pedidos do PDV (it.price já é o preço combinado)
      const opts = (it.selected_options || it.options || []);
      const pdvAddons = (it.addons || []);
      const optNames = opts
        .map((op: any) => typeof op === 'string' ? op : op.name)
        .filter(Boolean);
      const pdvAddonNames = pdvAddons
        .map((a: any) => a.name)
        .filter(Boolean);
      const allAddonNames = [...optNames, ...pdvAddonNames].join(', ');
      // Para PDV: it.price já inclui addons → não somar novamente
      const addonsTotal = opts.reduce((s: number, op: any) => s + +(op.additional_price || 0), 0);
      const variant = it.variant ? ` (${it.variant})` : '';
      const unitPrice = +(it.price || 0) + addonsTotal;
      const subtotalItem = (unitPrice * +(it.quantity || 1)).toFixed(2).replace('.', ',');
      return `
        <tr>
          <td>${it.quantity || 1}x ${it.name}${variant}</td>
          <td class="r">R$${subtotalItem}</td>
        </tr>
        ${it.added_by_store ? `<tr><td colspan="2" class="obs obs-store">★ Adicionado pelo lojista</td></tr>` : ''}
        ${allAddonNames ? `<tr><td colspan="2" class="obs">+ ${allAddonNames}</td></tr>` : ''}
        ${it.note ? `<tr><td colspan="2" class="obs obs-note">${it.note}</td></tr>` : ''}`;
    }).join('');

    const discount = +o.discount > 0
      ? `<tr><td>Desconto${o.coupon_code ? ` (${o.coupon_code})` : ''}</td><td class="r">-R$${(+o.discount).toFixed(2).replace('.', ',')}</td></tr>`
      : '';

    const deliveryRow = +o.delivery_tax > 0
      ? `<tr><td>Taxa de entrega</td><td class="r">R$${(+o.delivery_tax).toFixed(2).replace('.', ',')}</td></tr>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Pedido #${o.order_number}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    width: 302px;        /* 80mm a 96dpi */
    padding: 8px 10px;
    color: #000;
    background: #fff;
  }
  h1  { font-size: 14px; text-align: center; margin-bottom: 2px; }
  .center { text-align: center; }
  .sep  { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td    { padding: 1px 0; vertical-align: top; font-size: 11px; }
  td.r  { text-align: right; white-space: nowrap; }
  td.obs { font-size: 10px; color: #555; padding-left: 10px; }
  td.obs-store { font-size: 10px; color: #0369a1; padding-left: 10px; font-style: italic; font-weight: bold; }
  td.obs-note  { font-size: 10px; color: #a16207; padding-left: 10px; font-style: italic; }
  .total td { font-size: 13px; font-weight: bold; border-top: 1px solid #000; padding-top: 4px; }
  .footer { margin-top: 8px; font-size: 10px; text-align: center; color: #555; }
  @media print {
    @page { margin: 0; size: 80mm auto; }
    body  { width: 100%; padding: 4px 6px; }
  }
</style>
</head>
<body>

<h1>${o.store_name}</h1>
${o.daily_code ? `<p class="center" style="font-size:13px;font-weight:bold">${o.daily_code.toUpperCase()}</p>` : ''}
<p class="center" style="font-size:11px;margin-bottom:4px">#${o.order_number} &nbsp;|&nbsp; ${now}</p>

<hr class="sep">

<p><strong>Cliente:</strong> ${o.customer_name}</p>
${o.customer_phone ? `<p><strong>Tel:</strong> ${o.customer_phone}</p>` : ''}
<p><strong>${
    o.table_number                ? `🪑 Mesa ${o.table_number}`
    : o.delivery_type === 'scheduled_pickup'
        ? `🕐 Retirada Agendada: ${o.scheduled_pickup_time ? new Date(o.scheduled_pickup_time).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'}`
    : o.delivery_type === 'pickup' ? '🏪 Retirada na loja'
    : `📍 ${o.customer_address || 'Endereço não informado'}`
}</strong></p>
${o.notes ? `<p style="margin-top:3px"><strong>Obs:</strong> ${o.notes}</p>` : ''}

<hr class="sep">

<table>
${itemRows}
</table>

<hr class="sep">

<table>
  ${deliveryRow}
  ${discount}
  <tr class="total">
    <td>TOTAL</td>
    <td class="r">R$${(+o.total).toFixed(2).replace('.', ',')}</td>
  </tr>
  <tr><td>Pagamento</td><td class="r">${payLabel[o.payment_method] || o.payment_method}</td></tr>
  ${o.payment_method === 'dinheiro' && o.change_for
    ? `<tr><td>Troco para</td><td class="r">R$${(+o.change_for).toFixed(2).replace('.', ',')}</td></tr>
       <tr><td><b>Troco a devolver</b></td><td class="r"><b>R$${Math.max(0, +o.change_for - +o.total).toFixed(2).replace('.', ',')}</b></td></tr>`
    : o.payment_method === 'dinheiro' ? `<tr><td colspan="2" class="obs">Sem troco necessário</td></tr>` : ''}
</table>

<p class="footer">AG-ON Food &bull; Obrigado pela preferência!</p>

<script>
  window.onload = function() {
    window.print();
    setTimeout(function() { window.close(); }, 800);
  };
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err: any) { res.status(500).send(err.message); }
});

// GET /delivery/orders/:id/motoboy — gera mensagem para o entregador
router.get('/orders/:id/motoboy', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT o.*, e.name AS store_name
       FROM delivery_orders o
       JOIN establishments e ON e.id = o.establishment_id
       WHERE o.id=$1 AND o.establishment_id=$2`,
      [req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const o = result.rows[0];
    const mapsLink = o.customer_address
      ? `https://maps.google.com/?q=${encodeURIComponent(o.customer_address)}`
      : null;

    const lines = [
      `📍 Entrega ${o.store_name}`,
      `#${o.order_number || o.id.slice(0, 8).toUpperCase()}`,
      ``,
      `👤 Cliente: ${o.customer_name}`,
      `📞 Telefone: ${o.customer_phone || 'Não informado'}`,
      `📦 Endereço: ${o.customer_address || 'Retirada na loja'}`,
      `💰 Total a receber: R$ ${Number(o.total).toFixed(2).replace('.', ',')}`,
      `💳 Pagamento: ${o.payment_method === 'na_entrega' ? 'Na entrega' : o.payment_method}`,
    ];
    if (o.notes) lines.push(`📝 Obs: ${o.notes}`);
    if (mapsLink) lines.push(``, `🗺️ Google Maps: ${mapsLink}`);

    const message = lines.join('\n');
    res.json({ message, whatsapp_url: `https://wa.me/?text=${encodeURIComponent(message)}` });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/orders/:id — detalhe do pedido (lojista)
router.get('/orders/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT * FROM delivery_orders WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/orders — cria pedido (rota pública)
router.post('/orders', orderRateLimit, async (req: Request, res: Response) => {
  const {
    establishment_id, customer_name, customer_phone, customer_address,
    delivery_type, items, notes, zone_id, table_id, source, payment_method, coupon_code, change_for,
    scheduled_pickup_time, staff_name, session_id, lat, lng,
  } = req.body;

  if (!establishment_id || !customer_name || !items?.length) {
    return res.status(400).json({ error: 'establishment_id, customer_name e items são obrigatórios.' });
  }

  try {
    // Valida horário de funcionamento (PDV/garçom/retirada agendada sempre podem criar — Ágata já verifica antes)
    if (source !== 'agata_wa' && source !== 'pdv' && source !== 'garcom' && delivery_type !== 'scheduled_pickup') {
      const storeStatus = await checkStoreOpen(establishment_id);
      if (!storeStatus.is_open) {
        return res.status(400).json({ error: storeStatus.message, store_closed: true });
      }
    }

    const estRes = await pool.query(
      `SELECT delivery_tax, free_delivery_over, min_order FROM establishments WHERE id=$1`, [establishment_id]
    );
    const est = estRes.rows[0] || {};

    const subtotal: number = items.reduce((acc: number, it: any) => {
      const extras = (it.selected_options || []).reduce((s: number, o: any) => s + (+o.additional_price || 0), 0);
      const variantAdj = +(it.variant?.price_adjustment || 0);
      return acc + (+it.price + extras + variantAdj) * (it.quantity || 1);
    }, 0);

    let tax = 0;
    if (delivery_type !== 'pickup' && !table_id) {
      if (zone_id) {
        const zoneRes = await pool.query(
          `SELECT delivery_tax FROM delivery_zones WHERE id=$1 AND establishment_id=$2`,
          [zone_id, establishment_id]
        );
        if (zoneRes.rows.length) {
          tax = +(zoneRes.rows[0].delivery_tax || 0);
        } else {
          // zone_id inválido — cai na taxa padrão
          tax = +(est.delivery_tax || 0);
        }
      } else {
        tax = +(est.delivery_tax || 0);
      }
      if (+est.free_delivery_over > 0 && subtotal >= +est.free_delivery_over) tax = 0;
    }
    console.log(`[delivery] zone_id=${zone_id} tax=${tax} subtotal=${subtotal} delivery_type=${delivery_type}`);

    // Aplica cupom se informado
    let discount = 0;
    let appliedCouponCode: string | null = null;
    if (coupon_code) {
      try {
        const couponResult = await applyCoupon(establishment_id, coupon_code, subtotal);
        discount = couponResult.discount;
        appliedCouponCode = coupon_code.toUpperCase();
        // Incrementa uso do cupom
        await pool.query(
          `UPDATE coupons SET uses_count = uses_count + 1 WHERE establishment_id=$1 AND UPPER(code)=UPPER($2)`,
          [establishment_id, coupon_code]
        );
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
    }

    const total = subtotal + tax - discount;

    if (est.min_order && subtotal < +est.min_order) {
      return res.status(400).json({
        error: `Pedido mínimo de R$ ${(+est.min_order).toFixed(2).replace('.', ',')} não atingido.`
      });
    }

    // Número sequencial global e código diário (ex: "sex 3")
    const [seqRes, dailySeqRes, defaultDriverRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(MAX(order_number), 0) + 1 AS next FROM delivery_orders WHERE establishment_id=$1`,
        [establishment_id]
      ),
      pool.query(
        `SELECT COUNT(*) + 1 AS seq FROM delivery_orders
         WHERE establishment_id=$1
           AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date
             = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
        [establishment_id]
      ),
      // Busca entregador padrão da loja
      pool.query(
        `SELECT em.user_id, u.whatsapp FROM establishment_members em
         JOIN users u ON u.id = em.user_id
         WHERE em.establishment_id=$1 AND em.is_default=true AND em.is_active=true
         LIMIT 1`,
        [establishment_id]
      ),
    ]);

    const orderNumber = seqRes.rows[0].next;
    const dayNames = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    // Usa fuso de Brasília para evitar virada de dia errada em UTC
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dailyCode = `${dayNames[nowBR.getDay()]} ${dailySeqRes.rows[0].seq}`;

    // Auto-atribui ao entregador padrão (se for delivery e houver um)
    const defaultDriver = defaultDriverRes.rows[0] || null;
    const assignedTo = (delivery_type !== 'pickup' && defaultDriver)
      ? defaultDriver.user_id
      : null;

    const result = await pool.query(
      `INSERT INTO delivery_orders
         (establishment_id, customer_name, customer_phone, customer_address,
          delivery_type, items, subtotal, delivery_tax, discount, total, notes,
          zone_id, table_id, source, order_number, payment_method, daily_code, assigned_to, coupon_code, change_for, scheduled_pickup_time, staff_name, session_id, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
      [establishment_id, customer_name, customer_phone || null, customer_address || null,
       delivery_type || 'delivery', JSON.stringify(items),
       subtotal, tax, discount, total, notes || null,
       zone_id || null, table_id || null,
       source || 'web', orderNumber,
       payment_method || 'na_entrega', dailyCode, assignedTo, appliedCouponCode,
       (payment_method === 'dinheiro' && change_for) ? +change_for : null,
       scheduled_pickup_time || null,
       staff_name || null,
       session_id || null,
       lat ? +lat : null,
       lng ? +lng : null]
    );

    const newOrder = result.rows[0];

    // Log de atividade
    pool.query(`SELECT name FROM establishments WHERE id = $1`, [establishment_id])
      .then(r => {
        logActivity({
          type: 'ORDER_NEW',
          actor_role: 'CLIENT',
          actor_name: customer_name || 'Cliente',
          establishment_id,
          establishment_name: r.rows[0]?.name || establishment_id,
          description: `Novo pedido #${dailyCode} (${delivery_type || 'delivery'}) em "${r.rows[0]?.name || establishment_id}" — R$ ${(+total).toFixed(2).replace('.', ',')}`,
          metadata: { order_id: newOrder.id, order_number: orderNumber, total, payment_method, delivery_type },
        });
      }).catch(() => {});

    // Notifica lojistas conectados via SSE
    sseEmitNewOrder(establishment_id, newOrder);

    // Notifica app de impressão via Socket.io
    const { emitToStore } = await import('../shared/socketio');
    emitToStore(establishment_id, 'new_order', newOrder);

    // Pre-cadastra / atualiza cliente
    if (customer_phone) {
      upsertStoreCustomer(establishment_id, customer_phone, customer_name,
        customer_address || null, payment_method || null, total).catch(() => {});
    }

    // Se veio de uma mesa, marca como ocupada e salva nome do cliente
    if (table_id) {
      await pool.query(
        `UPDATE restaurant_tables
         SET status='ocupada', current_order_id=$1, customer_name=COALESCE($4, customer_name), updated_at=NOW()
         WHERE id=$2 AND establishment_id=$3`,
        [newOrder.id, table_id, establishment_id, customer_name || null]
      );
    }

    res.status(201).json(newOrder);

    // ── Notificações em background (não bloqueia resposta) ────
    (async () => {
      try {
        const estRes = await pool.query(`SELECT name, owner_whatsapp FROM establishments WHERE id=$1`, [establishment_id]);
        const est = estRes.rows[0];
        if (!est) return;

        const baseUrl = process.env.BASE_URL || '';

        // 1. Notifica lojista sobre novo pedido
        if (est.owner_whatsapp) {
          await sendWhatsAppMessage(establishment_id, est.owner_whatsapp, msgNovosPedidoLojista(newOrder, est.name));
        }

        // 2. Confirma recebimento ao cliente (se tiver telefone e não for pedido via Ágata WA
        //    pois a Ágata já enviou a confirmação na mesma conversa)
        if (newOrder.customer_phone && newOrder.source !== 'agata_wa') {
          const confirmMsg = await msgConfirmacaoCliente(newOrder, est.name, baseUrl, establishment_id);
          await sendWhatsAppMessage(establishment_id, newOrder.customer_phone, confirmMsg);
        }
      } catch (err: any) {
        console.error('[delivery notify] novo pedido:', err.message);
      }
    })();
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /delivery/orders/:id/status — atualiza status
router.patch('/orders/:id/status', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { status } = req.body;
  const valid = ['pending', 'confirmed', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Status inválido.' });

  // Entregador só pode marcar 'delivering' ou 'delivered'
  const user = req.user!;
  if (user.role === 'STAFF' && user.memberRole === 'entregador') {
    if (!['delivering', 'delivered'].includes(status)) {
      return res.status(403).json({ error: 'Entregador só pode marcar saiu para entrega ou entregue.' });
    }
  }
  try {
    const result = await pool.query(
      `UPDATE delivery_orders SET status=$1, updated_at=NOW()
       WHERE id=$2 AND establishment_id=$3 RETURNING *`,
      [status, req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const order = result.rows[0];

    // Se entregue ou cancelado, libera a mesa
    if (['delivered', 'cancelled'].includes(status) && order.table_id) {
      await pool.query(
        `UPDATE restaurant_tables SET status='livre', current_order_id=NULL, updated_at=NOW()
         WHERE id=$1 AND establishment_id=$2`,
        [order.table_id, estId]
      );
    }

    // Log de mudança de status
    const STATUS_LABELS: Record<string, string> = {
      confirmed: 'confirmado', preparing: 'em preparo', delivering: 'saiu p/ entrega',
      delivered: 'entregue', cancelled: 'cancelado', ready: 'pronto p/ retirada',
    };
    pool.query(`SELECT name FROM establishments WHERE id = $1`, [estId])
      .then(r => {
        logActivity({
          type: 'ORDER_STATUS',
          actor_role: user.role,
          actor_id: user.userId,
          establishment_id: estId,
          establishment_name: r.rows[0]?.name || estId,
          description: `Pedido #${order.daily_code || order.order_number} → ${STATUS_LABELS[status] || status} em "${r.rows[0]?.name || estId}"`,
          metadata: { order_id: order.id, status, previous_status: order.status },
        });
      }).catch(() => {});

    // ── Notificações de status em background ─────────────────
    (async () => {
      try {
        // Notifica cliente a cada mudança de status relevante (usa template do lojista se houver)
        if (order.customer_phone && ['confirmed','preparing','ready','delivering','delivered','cancelled'].includes(status)) {
          const estRes2 = await pool.query(`SELECT name FROM establishments WHERE id=$1`, [estId]);
          const sName = estRes2.rows[0]?.name || '';

          // Enriquece com dados do entregador quando sai para entrega
          if (status === 'delivering' && order.assigned_to) {
            const driverRes = await pool.query(`SELECT full_name, whatsapp FROM users WHERE id=$1`, [order.assigned_to]);
            const driver = driverRes.rows[0];
            if (driver) {
              order.driver_name  = driver.full_name;
              order.driver_phone = driver.whatsapp;
            }
          }

          const msg = await msgStatusClienteAsync(order, status, sName, estId);
          if (msg) await sendWhatsAppMessage(estId, order.customer_phone, msg);
        }

        // Quando confirma + PIX: envia código de pagamento
        if (status === 'confirmed' && order.payment_method === 'pix' && order.customer_phone) {
          const pix = await generatePix(estId, order.id, order.order_number, +order.total, order.customer_name);
          if (pix) {
            // Mensagem descritiva + código PIX isolado (copiável com 1 toque)
            await sendWhatsAppMessage(estId, order.customer_phone, pix.message);
            await sendWhatsAppMessage(estId, order.customer_phone, pix.code);
            console.log(`💸 PIX enviado para pedido #${order.order_number} (${pix.provider})`);
          }
        }

        // Quando sai para entrega: notifica entregador atribuído
        if (status === 'delivering' && order.assigned_to) {
          const estRes = await pool.query(`SELECT name FROM establishments WHERE id=$1`, [estId]);
          const storeName = estRes.rows[0]?.name || '';
          const driverRes = await pool.query(`SELECT whatsapp FROM users WHERE id=$1`, [order.assigned_to]);
          const driverPhone = driverRes.rows[0]?.whatsapp;
          if (driverPhone) {
            await sendWhatsAppMessage(estId, driverPhone, msgEntregador(order, storeName));
            console.log(`🛵 Entregador notificado para pedido #${order.order_number}`);
          }
        }
      } catch (err: any) {
        console.error('[status notify] erro:', err.message);
      }
    })();

    res.json(order);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /delivery/orders/:id/items — adiciona itens a pedido existente (PDV/garçom mesa)
router.patch('/orders/:id/items', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { items } = req.body; // array de itens a ADICIONAR
  if (!items?.length) return res.status(400).json({ error: 'items obrigatório.' });
  try {
    const r = await pool.query(
      `SELECT items, subtotal, delivery_tax, discount FROM delivery_orders
       WHERE id=$1 AND establishment_id=$2`,
      [req.params.id, estId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const current = r.rows[0];
    const taggedItems = items.map((it: any) => ({ ...it, added_by_store: true }));
    const merged: any[] = [...(current.items || []), ...taggedItems];
    const subtotal = merged.reduce((acc: number, it: any) => {
      const extras = (it.selected_options || []).reduce((s: number, o: any) => s + (+o.additional_price || 0), 0);
      return acc + (+it.price + extras) * (it.quantity || 1);
    }, 0);
    const total = subtotal + +(current.delivery_tax || 0) - +(current.discount || 0);

    const updated = await pool.query(
      `UPDATE delivery_orders
       SET items=$1, subtotal=$2, total=$3, updated_at=NOW()
       WHERE id=$4 AND establishment_id=$5 RETURNING *`,
      [JSON.stringify(merged), subtotal, total, req.params.id, estId]
    );
    res.json(updated.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /delivery/orders/:id/items — substitui lista completa de itens (garçom pode remover itens)
router.put('/orders/:id/items', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { items } = req.body; // array completo de itens (substitui)
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items deve ser um array.' });
  try {
    const r = await pool.query(
      `SELECT delivery_tax, discount FROM delivery_orders WHERE id=$1 AND establishment_id=$2`,
      [req.params.id, estId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });

    const { delivery_tax, discount } = r.rows[0];
    const subtotal = items.reduce((acc: number, it: any) => {
      const extras = (it.selected_options || []).reduce((s: number, o: any) => s + (+o.additional_price || 0), 0);
      return acc + (+it.price + extras) * (it.quantity || 1);
    }, 0);
    const total = subtotal + +(delivery_tax || 0) - +(discount || 0);

    const updated = await pool.query(
      `UPDATE delivery_orders SET items=$1, subtotal=$2, total=$3, updated_at=NOW()
       WHERE id=$4 AND establishment_id=$5 RETURNING *`,
      [JSON.stringify(items), subtotal, total, req.params.id, estId]
    );
    res.json(updated.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// CATÁLOGO PARA A ÁGATA (JSON compacto para o prompt da IA)
// ═══════════════════════════════════════════════════

/**
 * Gera o texto exato que é injetado no prompt da Ágata.
 * Reutilizado por /catalog-for-ai e /agata-preview.
 */
export async function buildAgataPromptText(establishment_id: string): Promise<string> {
  const [productsRes, varRes, optRes] = await Promise.all([
    pool.query(
      `SELECT p.id, p.name, p.price, p.description, c.name AS category,
              (p.settings->>'upsell')::boolean AS upsell
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.establishment_id=$1 AND p.active=true
       ORDER BY c.order_index ASC NULLS LAST, p.name ASC`,
      [establishment_id]
    ),
    pool.query(
      `SELECT pv.product_id, pv.type, pv.name, pv.price_adjustment, pv.is_required
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE p.establishment_id=$1 AND pv.is_active=true
       ORDER BY pv.type ASC, pv.order_index ASC`,
      [establishment_id]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT pag.product_id, ag.name AS group_name, ag.is_required,
              agi.name AS item_name, agi.price AS additional_price
       FROM product_addon_groups pag
       JOIN addon_groups ag ON ag.id = pag.addon_group_id
       JOIN addon_group_items agi ON agi.addon_group_id = ag.id AND agi.is_active = true
       JOIN products p ON p.id = pag.product_id
       WHERE p.establishment_id=$1
       ORDER BY pag.sort_order ASC, agi.sort_order ASC`,
      [establishment_id]
    ).catch(() => ({ rows: [] })),
  ]);

  if (!productsRes.rows.length) return '(Nenhum produto cadastrado ainda)';

  const varMap: Record<string, string[]> = {};
  varRes.rows.forEach((v: any) => {
    if (!varMap[v.product_id]) varMap[v.product_id] = [];
    const adj = +v.price_adjustment !== 0 ? ` (+R$${(+v.price_adjustment).toFixed(2)})` : '';
    varMap[v.product_id].push(`${v.name}${adj}${v.is_required ? '*' : ''}`);
  });

  const optMap: Record<string, string[]> = {};
  optRes.rows.forEach((o: any) => {
    if (!optMap[o.product_id]) optMap[o.product_id] = [];
    const price = +o.additional_price > 0 ? ` +R$${(+o.additional_price).toFixed(2)}` : '';
    optMap[o.product_id].push(`${o.group_name}: ${o.item_name}${price}${o.is_required ? '*' : ''}`);
  });

  const mainProducts  = productsRes.rows.filter((p: any) => !p.upsell);
  const upsellProducts = productsRes.rows.filter((p: any) => p.upsell);

  const formatProduct = (p: any) => {
    let line = `- ${p.name} | R$${(+p.price).toFixed(2)}`;
    if (p.category) line += ` [${p.category}]`;
    if (p.description) line += ` — ${p.description}`;
    if (varMap[p.id]?.length) line += `\n  Tamanhos/Sabores: ${varMap[p.id].join(', ')}`;
    if (optMap[p.id]?.length) line += `\n  Opcionais: ${optMap[p.id].join('; ')}`;
    return line;
  };

  let result = mainProducts.map(formatProduct).join('\n') + '\n\n* = obrigatório';

  if (upsellProducts.length) {
    result += '\n\nSUGESTÕES PARA OFERECER (Up-Sell):\n';
    result += 'Sempre ofereça estes itens quando o cliente estiver finalizando o pedido:\n';
    result += upsellProducts.map(formatProduct).join('\n');
  }

  return result;
}

// GET /delivery/agata-preview/:establishment_id
// Retorna o texto EXATO injetado no prompt da Ágata — para o painel do lojista
router.get('/agata-preview/:establishment_id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId! : req.params.establishment_id;
  try {
    const [text, countRes] = await Promise.all([
      buildAgataPromptText(estId),
      pool.query(
        `SELECT COUNT(*) AS total FROM products WHERE establishment_id=$1 AND active=true`,
        [estId]
      ),
    ]);
    res.json({
      preview: text,
      total_produtos: parseInt(countRes.rows[0].total, 10),
      atualizado_em: new Date().toISOString(),
      info: 'Este é o cardápio exato que a Ágata recebe em cada conversa. Qualquer edição no cardápio reflete automaticamente na próxima mensagem.',
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/catalog-for-ai/:establishment_id
router.get('/catalog-for-ai/:establishment_id', async (req: Request, res: Response) => {
  const { establishment_id } = req.params;
  try {
    const [catsRes, productsRes] = await Promise.all([
      pool.query(`SELECT id, name FROM categories WHERE establishment_id=$1 ORDER BY order_index ASC`, [establishment_id]),
      pool.query(
        `SELECT p.id, p.name, p.description, p.price, p.slug, p.has_variants,
                p.category_id, p.active
         FROM products p
         WHERE p.establishment_id=$1 AND p.active=true
         ORDER BY p.name ASC`,
        [establishment_id]
      ),
    ]);

    const productIds = productsRes.rows.map(p => p.id);
    let variantsMap: Record<string, any[]> = {};
    let optionsMap: Record<string, any[]> = {};

    if (productIds.length) {
      const [varRes, optRes] = await Promise.all([
        pool.query(
          `SELECT product_id, type, name, price_adjustment, is_required
           FROM product_variants WHERE product_id=ANY($1) AND is_active=true ORDER BY order_index ASC`,
          [productIds]
        ),
        pool.query(
          `SELECT po.product_id, po.name AS group_name, po.is_required,
                  poi.name AS item_name, poi.additional_price
           FROM product_options po
           JOIN product_option_items poi ON poi.option_id = po.id AND poi.is_active=true
           WHERE po.product_id=ANY($1)
           ORDER BY po.order_index ASC, poi.order_index ASC`,
          [productIds]
        ),
      ]);

      varRes.rows.forEach(v => {
        if (!variantsMap[v.product_id]) variantsMap[v.product_id] = [];
        variantsMap[v.product_id].push({ type: v.type, name: v.name, price_adj: +v.price_adjustment, required: v.is_required });
      });
      optRes.rows.forEach(o => {
        if (!optionsMap[o.product_id]) optionsMap[o.product_id] = [];
        optionsMap[o.product_id].push({ group: o.group_name, item: o.item_name, price: +o.additional_price, required: o.is_required });
      });
    }

    const catMap: Record<string, string> = {};
    catsRes.rows.forEach(c => { catMap[c.id] = c.name; });

    const catalog = productsRes.rows.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: +p.price,
      category: catMap[p.category_id] || 'Outros',
      slug: p.slug,
      variants: variantsMap[p.id] || [],
      options: optionsMap[p.id] || [],
    }));

    res.json(catalog);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// HORÁRIO DE FUNCIONAMENTO
// ═══════════════════════════════════════════════════

// GET /delivery/business-hours — lê horários da loja
router.get('/business-hours', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT * FROM business_hours WHERE establishment_id=$1 ORDER BY day_of_week ASC`,
      [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/business-hours/public/:establishment_id — status atual (aberto/fechado)
router.get('/business-hours/public/:establishment_id', async (req: Request, res: Response) => {
  try {
    const status = await checkStoreOpen(req.params.establishment_id);
    res.json(status);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/business-hours — salva horários (upsert por dia da semana)
router.post('/business-hours', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  // Aceita array de dias ou um único dia
  const days: Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }> =
    Array.isArray(req.body) ? req.body : [req.body];

  try {
    for (const day of days) {
      const { day_of_week, open_time, close_time, is_closed } = day;
      if (day_of_week < 0 || day_of_week > 6) continue;
      await pool.query(
        `INSERT INTO business_hours (establishment_id, day_of_week, open_time, close_time, is_closed)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (establishment_id, day_of_week)
           DO UPDATE SET open_time=$3, close_time=$4, is_closed=$5`,
        [estId, day_of_week, open_time || '09:00', close_time || '22:00', is_closed || false]
      );
    }
    const result = await pool.query(
      `SELECT * FROM business_hours WHERE establishment_id=$1 ORDER BY day_of_week ASC`, [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// EQUIPE — ENTREGADORES E MEMBROS DA LOJA
// ═══════════════════════════════════════════════════

// GET /delivery/staff — lista membros da equipe
router.get('/staff', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT em.id, em.member_role, em.member_roles, em.is_active, em.is_default, em.created_at,
              u.id AS user_id, u.full_name, u.whatsapp, u.email
       FROM establishment_members em
       JOIN users u ON u.id = em.user_id
       WHERE em.establishment_id = $1
       ORDER BY u.full_name ASC`,
      [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/staff — vincula membro pelo WhatsApp (ele já deve ter cadastro no portal)
router.post('/staff', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { whatsapp, member_role, member_roles } = req.body;

  if (!whatsapp) return res.status(400).json({ error: 'WhatsApp do membro obrigatório.' });

  // Normaliza roles: aceita array (member_roles) ou string legada (member_role)
  const rolesArray: string[] = Array.isArray(member_roles) && member_roles.length
    ? member_roles
    : [member_role || 'entregador'];
  const primaryRole = rolesArray[0];

  const phone = whatsapp.replace(/\D/g, '');
  try {
    // Busca usuário pelo WhatsApp — ele precisa ter se cadastrado no portal
    const userRes = await pool.query(
      `SELECT id, full_name, whatsapp, email FROM users WHERE whatsapp = $1`, [phone]
    );
    if (!userRes.rows.length) {
      return res.status(404).json({
        error: 'Usuário não encontrado. Peça para ele se cadastrar no portal primeiro.',
        hint: `${process.env.BASE_URL || ''}/portal`,
      });
    }

    const user = userRes.rows[0];

    const result = await pool.query(
      `INSERT INTO establishment_members (establishment_id, user_id, member_role, member_roles)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (establishment_id, user_id)
         DO UPDATE SET member_role = $3, member_roles = $4, is_active = true
       RETURNING *`,
      [estId, user.id, primaryRole, rolesArray]
    );

    res.status(201).json({ ...result.rows[0], user });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /delivery/staff/:id/roles — atualiza as funções de um membro
router.patch('/staff/:id/roles', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { member_roles } = req.body;
  if (!Array.isArray(member_roles) || !member_roles.length) {
    return res.status(400).json({ error: 'member_roles deve ser um array com ao menos uma função.' });
  }
  const primaryRole = member_roles[0];
  try {
    const result = await pool.query(
      `UPDATE establishment_members
       SET member_role = $1, member_roles = $2
       WHERE id = $3 AND establishment_id = $4 RETURNING *`,
      [primaryRole, member_roles, req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Membro não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /delivery/staff/:id/set-default — define entregador padrão da loja
router.patch('/staff/:id/set-default', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    // Remove padrão atual
    await pool.query(
      `UPDATE establishment_members SET is_default=false WHERE establishment_id=$1`,
      [estId]
    );
    // Define o novo padrão
    const result = await pool.query(
      `UPDATE establishment_members SET is_default=true
       WHERE id=$1 AND establishment_id=$2 RETURNING *`,
      [req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Membro não encontrado.' });
    res.json({ ...result.rows[0], message: 'Entregador padrão definido. Novos pedidos serão atribuídos automaticamente.' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /delivery/staff/:id/status — ativar ou desativar membro
router.patch('/staff/:id/status', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE establishment_members SET is_active = $1
       WHERE id = $2 AND establishment_id = $3 RETURNING *`,
      [is_active !== false, req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Membro não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /delivery/staff/:id — remove membro da equipe
router.delete('/staff/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    await pool.query(
      `DELETE FROM establishment_members WHERE id = $1 AND establishment_id = $2`,
      [req.params.id, estId]
    );
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /delivery/orders/:id/assign — atribui entregador ao pedido
router.patch('/orders/:id/assign', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { user_id } = req.body; // user_id do entregador

  if (!user_id) return res.status(400).json({ error: 'user_id do entregador obrigatório.' });

  try {
    // Valida que o usuário é membro ativo da equipe
    const memberCheck = await pool.query(
      `SELECT 1 FROM establishment_members
       WHERE establishment_id = $1 AND user_id = $2 AND is_active = true`,
      [estId, user_id]
    );
    if (!memberCheck.rows.length) {
      return res.status(400).json({ error: 'Usuário não é membro ativo desta loja.' });
    }

    const result = await pool.query(
      `UPDATE delivery_orders SET assigned_to = $1, updated_at = NOW()
       WHERE id = $2 AND establishment_id = $3 RETURNING *`,
      [user_id, req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// CUPONS DE DESCONTO
// ═══════════════════════════════════════════════════

/**
 * Valida e aplica um cupom. Retorna o valor do desconto ou lança erro.
 * Exportada para uso no webhook da Ágata.
 */
export async function applyCoupon(
  estId: string,
  code: string,
  subtotal: number
): Promise<{ discount: number; coupon_id: string; description: string }> {
  const res = await pool.query(
    `SELECT * FROM coupons
     WHERE establishment_id=$1 AND UPPER(code)=UPPER($2) AND is_active=true`,
    [estId, code.trim()]
  );
  if (!res.rows.length) throw new Error('Cupom inválido ou inexistente.');

  const c = res.rows[0];
  const now = new Date();

  if (c.valid_from && now < new Date(c.valid_from)) throw new Error('Cupom ainda não está válido.');
  if (c.valid_until && now > new Date(c.valid_until)) throw new Error('Cupom expirado.');
  if (c.max_uses !== null && c.uses_count >= c.max_uses) throw new Error('Cupom esgotado.');
  if (c.min_order && subtotal < +c.min_order) {
    throw new Error(`Pedido mínimo de R$ ${(+c.min_order).toFixed(2).replace('.', ',')} para usar este cupom.`);
  }

  const discount = c.discount_type === 'percent'
    ? Math.min(subtotal, (subtotal * +c.discount_value) / 100)
    : Math.min(subtotal, +c.discount_value);

  return {
    discount: Math.round(discount * 100) / 100,
    coupon_id: c.id,
    description: c.description || `${c.discount_type === 'percent' ? c.discount_value + '%' : 'R$ ' + (+c.discount_value).toFixed(2)} de desconto`,
  };
}

// GET /delivery/coupons — lista cupons da loja
router.get('/coupons', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `SELECT * FROM coupons WHERE establishment_id=$1 ORDER BY created_at DESC`, [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/coupons — cria ou edita cupom
router.post('/coupons', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { id, code, description, discount_type, discount_value, min_order, max_uses, valid_from, valid_until } = req.body;

  if (!code || !discount_value || !discount_type) {
    return res.status(400).json({ error: 'code, discount_type e discount_value são obrigatórios.' });
  }
  if (!['percent', 'fixed'].includes(discount_type)) {
    return res.status(400).json({ error: 'discount_type deve ser percent ou fixed.' });
  }
  if (discount_type === 'percent' && (+discount_value < 1 || +discount_value > 100)) {
    return res.status(400).json({ error: 'Desconto percentual deve ser entre 1 e 100.' });
  }

  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE coupons SET code=UPPER($1), description=$2, discount_type=$3, discount_value=$4,
          min_order=$5, max_uses=$6, valid_from=$7, valid_until=$8
         WHERE id=$9 AND establishment_id=$10 RETURNING *`,
        [code, description || null, discount_type, discount_value,
         min_order || 0, max_uses || null, valid_from || null, valid_until || null, id, estId]
      );
    } else {
      result = await pool.query(
        `INSERT INTO coupons (establishment_id, code, description, discount_type, discount_value,
           min_order, max_uses, valid_from, valid_until)
         VALUES ($1, UPPER($2), $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [estId, code, description || null, discount_type, discount_value,
         min_order || 0, max_uses || null, valid_from || null, valid_until || null]
      );
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um cupom com este código.' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /delivery/coupons/:id/toggle — ativa/desativa
router.patch('/coupons/:id/toggle', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const result = await pool.query(
      `UPDATE coupons SET is_active = NOT is_active WHERE id=$1 AND establishment_id=$2 RETURNING *`,
      [req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cupom não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /delivery/coupons/:id
router.delete('/coupons/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    await pool.query(`DELETE FROM coupons WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/coupons/validate — valida cupom publicamente (antes de finalizar pedido)
router.post('/coupons/validate', async (req: Request, res: Response) => {
  const { establishment_id, code, subtotal } = req.body;
  if (!establishment_id || !code || subtotal === undefined) {
    return res.status(400).json({ error: 'establishment_id, code e subtotal são obrigatórios.' });
  }
  try {
    const result = await applyCoupon(establishment_id, code, +subtotal);
    res.json(result);
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// CONFIG PÚBLICA (vitrine)
// ═══════════════════════════════════════════════════

// ── Utilitário: upsert de cliente da loja ─────────────────────
async function upsertStoreCustomer(
  estId: string, phone: string, name: string,
  address: string | null, payment: string | null,
  orderTotal: number
) {
  await pool.query(
    `INSERT INTO store_customers
       (establishment_id, phone, name, last_address, last_payment,
        total_orders, total_spent, first_order_at, last_order_at)
     VALUES ($1,$2,$3,$4,$5, 1,$6, NOW(), NOW())
     ON CONFLICT (establishment_id, phone) DO UPDATE SET
       name          = COALESCE(EXCLUDED.name, store_customers.name),
       last_address  = COALESCE(EXCLUDED.last_address, store_customers.last_address),
       last_payment  = COALESCE(EXCLUDED.last_payment, store_customers.last_payment),
       total_orders  = store_customers.total_orders + 1,
       total_spent   = store_customers.total_spent + EXCLUDED.total_spent,
       last_order_at = NOW()`,
    [estId, phone, name, address || null, payment || null, orderTotal]
  );
}

// POST /delivery/public/pix-generate — gera PIX após pedido (público, sem auth)
router.post('/public/pix-generate', async (req: Request, res: Response) => {
  const { order_id, establishment_id } = req.body;
  if (!order_id || !establishment_id) return res.status(400).json({ error: 'order_id e establishment_id obrigatórios.' });
  try {
    const orderRes = await pool.query(
      `SELECT id, order_number, total, customer_name FROM delivery_orders
       WHERE id=$1 AND establishment_id=$2`, [order_id, establishment_id]
    );
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const order = orderRes.rows[0];
    console.log(`[pix-generate] est=${establishment_id} order=${order.id} total=${order.total}`);
    const pix = await generatePix(establishment_id, order.id, order.order_number, +order.total, order.customer_name);
    console.log(`[pix-generate] resultado: ${pix ? `provider=${pix.provider} code=${pix.code?.slice(0,30)}...` : 'null'}`);
    if (!pix) return res.status(422).json({ error: 'PIX não configurado para esta loja.' });
    res.json({ code: pix.code, provider: pix.provider });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/public/card-payment — processa pagamento com cartão via MP SDK V2
router.post('/public/card-payment', async (req: Request, res: Response) => {
  const { order_id, establishment_id, token, installments, payment_method_id, issuer_id, payer } = req.body;
  if (!order_id || !establishment_id || !token) {
    return res.status(400).json({ error: 'order_id, establishment_id e token são obrigatórios.' });
  }
  try {
    // Busca pedido e token MP do lojista
    const [orderRes, estRes] = await Promise.all([
      pool.query(`SELECT id, order_number, total, customer_name FROM delivery_orders WHERE id=$1 AND establishment_id=$2`, [order_id, establishment_id]),
      pool.query(`SELECT mp_access_token, name FROM establishments WHERE id=$1`, [establishment_id]),
    ]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (!estRes.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });

    const order = orderRes.rows[0];
    const accessToken = decrypt(estRes.rows[0].mp_access_token || '');
    if (!accessToken) return res.status(422).json({ error: 'Mercado Pago não configurado nesta loja.' });

    // Cria pagamento na API do MP
    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-Idempotency-Key': order_id,
      },
      body: JSON.stringify({
        transaction_amount: parseFloat(order.total),
        token,
        description: `Pedido #${order.order_number} — ${estRes.rows[0].name}`,
        installments: installments || 1,
        payment_method_id,
        issuer_id: issuer_id || undefined,
        external_reference: order_id,
        payer: {
          email: payer?.email || `cliente_${order_id.slice(0, 8)}@agonfood.com`,
          identification: payer?.identification || undefined,
        },
      }),
    });

    const payment = await mpRes.json() as any;
    console.log(`[card-payment] status=${payment.status} detail=${payment.status_detail}`);

    if (payment.status === 'approved') {
      await pool.query(
        `UPDATE delivery_orders SET payment_status='paid', status='confirmed', updated_at=NOW() WHERE id=$1`,
        [order_id]
      );
      return res.json({ status: 'approved', payment_id: payment.id });
    }

    if (payment.status === 'in_process' || payment.status === 'pending') {
      return res.json({ status: 'pending', payment_id: payment.id });
    }

    // Rejeitado
    const detail = payment.status_detail || 'rejected';
    return res.status(422).json({ error: 'Pagamento recusado', status_detail: detail });

  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/public/customer-lookup — retorna dados do cliente para auto-preenchimento
router.post('/public/customer-lookup', lookupRateLimit, async (req: Request, res: Response) => {
  const { phone, establishment_id } = req.body;
  if (!phone || !establishment_id) return res.status(400).json({ error: 'phone e establishment_id obrigatórios.' });
  try {
    // Valida que a loja existe antes de consultar dados do cliente
    const estCheck = await pool.query(`SELECT id FROM establishments WHERE id=$1 LIMIT 1`, [establishment_id]);
    if (!estCheck.rows.length) return res.json({ found: false });

    const r = await pool.query(
      `SELECT name, last_address, last_payment FROM store_customers
       WHERE establishment_id=$1 AND phone=$2`,
      [establishment_id, phone.replace(/\D/g, '')]
    );
    if (!r.rows.length) return res.json({ found: false });
    res.json({ found: true, ...r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/public/customer-addresses — endereços salvos do cliente (por telefone, para sugestão no checkout)
router.get('/public/customer-addresses', lookupRateLimit, async (req: Request, res: Response) => {
  const { phone } = req.query as Record<string, string>;
  if (!phone) return res.status(400).json({ error: 'phone obrigatório.' });
  try {
    const wa = phone.replace(/\D/g, '');
    // Busca user pelo WA e retorna seus endereços salvos
    const userRes = await pool.query(`SELECT id FROM users WHERE whatsapp=$1 LIMIT 1`, [wa]);
    if (!userRes.rows.length) return res.json([]);

    const addrRes = await pool.query(
      `SELECT id, label, address, street, number, neighborhood, city, reference, is_default, lat, lng
       FROM user_addresses WHERE user_id=$1 ORDER BY is_default DESC, created_at ASC`,
      [userRes.rows[0].id]
    ).catch(() => ({ rows: [] }));

    res.json(addrRes.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/public/save-address — salva/atualiza endereço do cliente vinculado ao telefone
// Requer order_id de um pedido recente do mesmo telefone como prova de posse
router.post('/public/save-address', lookupRateLimit, async (req: Request, res: Response) => {
  const { phone, order_id, label = 'Casa', address, street, number, neighborhood, city, reference, lat, lng } = req.body;
  if (!phone || !address || !order_id) return res.status(400).json({ error: 'phone, order_id e address obrigatórios.' });
  try {
    const wa = phone.replace(/\D/g, '');

    // Valida posse: o pedido deve pertencer a esse telefone e ter sido criado nos últimos 30min
    const orderCheck = await pool.query(
      `SELECT id FROM delivery_orders
       WHERE id=$1 AND customer_phone=$2
         AND created_at > NOW() - INTERVAL '30 minutes' LIMIT 1`,
      [order_id, wa]
    );
    if (!orderCheck.rows.length) return res.json({ saved: false });

    const userRes = await pool.query(`SELECT id FROM users WHERE whatsapp=$1 LIMIT 1`, [wa]);
    if (!userRes.rows.length) return res.json({ saved: false });

    const userId = userRes.rows[0].id;
    await pool.query(
      `INSERT INTO user_addresses (user_id, label, address, street, number, neighborhood, city, reference, lat, lng, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
       ON CONFLICT (user_id, label) DO UPDATE SET
         address=$3, street=$4, number=$5, neighborhood=$6, city=$7, reference=$8, lat=$9, lng=$10, updated_at=NOW()`,
      [userId, label, address, street||null, number||null, neighborhood||null, city||null, reference||null,
       lat ? +lat : null, lng ? +lng : null]
    );
    res.json({ saved: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/public/customer-orders — histórico de pedidos do cliente (por loja)
router.get('/public/customer-orders', lookupRateLimit, async (req: Request, res: Response) => {
  const { phone, establishment_id } = req.query as Record<string, string>;
  if (!phone || !establishment_id) return res.status(400).json({ error: 'phone e establishment_id obrigatórios.' });
  try {
    const r = await pool.query(
      `SELECT id, order_number, daily_code, status, total, items, created_at, delivery_type, payment_method
       FROM delivery_orders
       WHERE establishment_id=$1 AND customer_phone=$2
       ORDER BY created_at DESC LIMIT 20`,
      [establishment_id, phone.replace(/\D/g, '')]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /delivery/public/my-orders — todos os pedidos do telefone em qualquer loja (para o portal AG-ON)
router.get('/public/my-orders', lookupRateLimit, async (req: Request, res: Response) => {
  const { phone } = req.query as Record<string, string>;
  if (!phone) return res.status(400).json({ error: 'phone obrigatório.' });
  try {
    const r = await pool.query(
      `SELECT o.id, o.order_number, o.daily_code, o.status, o.total, o.items,
              o.created_at, o.delivery_type, o.payment_method, o.establishment_id,
              e.name AS store_name, e.slug AS store_slug
       FROM delivery_orders o
       JOIN establishments e ON e.id = o.establishment_id
       WHERE o.customer_phone=$1
       ORDER BY o.created_at DESC LIMIT 50`,
      [phone.replace(/\D/g, '')]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── UP-SELLING ────────────────────────────────────────────────────────────────

// GET /delivery/upsell — lista produtos de upsell da loja
router.get('/upsell', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const r = await pool.query(
      `SELECT u.id, u.product_id, u.position, p.name, p.price, p.image_base64, p.description
       FROM upsell_products u
       JOIN products p ON p.id = u.product_id
       WHERE u.establishment_id=$1 AND u.is_active=true
       ORDER BY u.position ASC`, [estId]
    );
    res.json(r.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /delivery/upsell — adiciona produto ao upsell
router.post('/upsell', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id obrigatório.' });
  try {
    const posRes = await pool.query(
      `SELECT COALESCE(MAX(position),0)+1 AS next FROM upsell_products WHERE establishment_id=$1`, [estId]
    );
    await pool.query(
      `INSERT INTO upsell_products (establishment_id, product_id, position)
       VALUES ($1,$2,$3) ON CONFLICT (establishment_id, product_id) DO UPDATE SET is_active=true`,
      [estId, product_id, posRes.rows[0].next]
    );
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /delivery/upsell/:id — remove registro de upsell pelo seu próprio id
router.delete('/upsell/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const result = await pool.query(
      `DELETE FROM upsell_products WHERE id=$1 AND establishment_id=$2`,
      [req.params.id, estId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/public-config/:establishment_id', async (req: Request, res: Response) => {
  try {
    // Resolve slug → UUID
    const slugRes = await pool.query(
      `SELECT id FROM establishments WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [req.params.establishment_id]
    );
    if (!slugRes.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    const estId = slugRes.rows[0].id;

    const [estRes, zonesRes, hoursRes, upsellRes] = await Promise.all([
      pool.query(
        `SELECT delivery_tax, free_delivery_over, estimated_time, delivery_type, min_order, zone_type
         FROM establishments WHERE id=$1 AND is_active=true`, [estId]
      ),
      pool.query(
        `SELECT id, name, city, delivery_tax, estimated_time FROM delivery_zones
         WHERE establishment_id=$1 AND is_active=true ORDER BY city ASC, name ASC`, [estId]
      ),
      pool.query(
        `SELECT day_of_week, open_time, close_time, is_closed FROM business_hours
         WHERE establishment_id=$1 ORDER BY day_of_week ASC`, [estId]
      ).catch(() => ({ rows: [] as any[] })),
      pool.query(
        `SELECT u.product_id AS id, p.name, p.price, p.image_base64, p.description
         FROM upsell_products u
         JOIN products p ON p.id = u.product_id
         WHERE u.establishment_id=$1 AND u.is_active=true
         ORDER BY u.position ASC`,
        [estId]
      ).catch(() => ({ rows: [] as any[] })),
    ]);
    if (!estRes.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    res.json({ ...estRes.rows[0], zones: zonesRes.rows, business_hours: hoursRes.rows, upsell: upsellRes.rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /delivery/reports — relatórios avançados para o lojista
// Query params: period=today|7d|30d|custom  &  from=YYYY-MM-DD  &  to=YYYY-MM-DD
// ═══════════════════════════════════════════════════════════════════
router.get('/reports', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  try {
    const { period = '30d', from, to } = req.query as Record<string, string>;

    // Resolve intervalo de datas em fuso America/Sao_Paulo
    let dateFrom: string;
    let dateTo: string;
    const nowBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

    if (period === 'custom' && from && to) {
      dateFrom = from;
      dateTo   = to;
    } else if (period === 'today') {
      dateFrom = dateTo = nowBR.toISOString().slice(0, 10);
    } else if (period === '7d') {
      const d = new Date(nowBR); d.setDate(d.getDate() - 6);
      dateFrom = d.toISOString().slice(0, 10);
      dateTo   = nowBR.toISOString().slice(0, 10);
    } else {
      // 30d (default)
      const d = new Date(nowBR); d.setDate(d.getDate() - 29);
      dateFrom = d.toISOString().slice(0, 10);
      dateTo   = nowBR.toISOString().slice(0, 10);
    }

    const tz = 'America/Sao_Paulo';
    // Apenas pedidos não cancelados dentro do período
    const baseWhere = `
      establishment_id = $1
      AND status <> 'cancelled'
      AND (created_at AT TIME ZONE '${tz}')::date BETWEEN $2::date AND $3::date
    `;
    const params = [estId, dateFrom, dateTo];

    const [kpiRes, byDayRes, byPayRes, byTypeRes, byHourRes, topItemsRes, topClientsRes] = await Promise.all([

      // ── 1. KPIs gerais ──────────────────────────────────────────────
      pool.query(`
        SELECT
          COUNT(*)                        AS total_orders,
          COALESCE(SUM(total), 0)         AS total_revenue,
          COALESCE(AVG(total), 0)         AS avg_ticket,
          COUNT(DISTINCT customer_phone)  AS unique_customers
        FROM delivery_orders
        WHERE ${baseWhere}
      `, params),

      // ── 2. Faturamento por dia ──────────────────────────────────────
      pool.query(`
        SELECT
          (created_at AT TIME ZONE '${tz}')::date AS day,
          COUNT(*)                                 AS orders,
          COALESCE(SUM(total), 0)                  AS revenue
        FROM delivery_orders
        WHERE ${baseWhere}
        GROUP BY 1
        ORDER BY 1
      `, params),

      // ── 3. Distribuição por método de pagamento ─────────────────────
      pool.query(`
        SELECT
          COALESCE(payment_method, 'desconhecido') AS method,
          COUNT(*)                                  AS orders,
          COALESCE(SUM(total), 0)                   AS revenue
        FROM delivery_orders
        WHERE ${baseWhere}
        GROUP BY 1
        ORDER BY 2 DESC
      `, params),

      // ── 4. Distribuição por tipo de entrega ─────────────────────────
      pool.query(`
        SELECT
          COALESCE(delivery_type, 'outros') AS dtype,
          COUNT(*)                           AS orders,
          COALESCE(SUM(total), 0)            AS revenue
        FROM delivery_orders
        WHERE ${baseWhere}
        GROUP BY 1
        ORDER BY 2 DESC
      `, params),

      // ── 5. Horários de pico (pedidos por hora do dia) ───────────────
      pool.query(`
        SELECT
          EXTRACT(HOUR FROM created_at AT TIME ZONE '${tz}')::int AS hour,
          COUNT(*) AS orders
        FROM delivery_orders
        WHERE ${baseWhere}
        GROUP BY 1
        ORDER BY 1
      `, params),

      // ── 6. Produtos mais vendidos ───────────────────────────────────
      pool.query(`
        SELECT
          item->>'name'                       AS name,
          SUM((item->>'quantity')::numeric)   AS qty,
          SUM((item->>'price')::numeric * (item->>'quantity')::numeric) AS revenue
        FROM delivery_orders,
             jsonb_array_elements(items) AS item
        WHERE ${baseWhere}
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 10
      `, params),

      // ── 7. Top clientes ─────────────────────────────────────────────
      pool.query(`
        SELECT
          customer_name                    AS name,
          customer_phone                   AS phone,
          COUNT(*)                         AS orders,
          COALESCE(SUM(total), 0)          AS total_spent,
          MAX(created_at AT TIME ZONE '${tz}') AS last_order
        FROM delivery_orders
        WHERE ${baseWhere}
        GROUP BY customer_name, customer_phone
        ORDER BY total_spent DESC
        LIMIT 10
      `, params),
    ]);

    res.json({
      period: { from: dateFrom, to: dateTo },
      kpi:         kpiRes.rows[0],
      by_day:      byDayRes.rows,
      by_payment:  byPayRes.rows,
      by_type:     byTypeRes.rows,
      by_hour:     byHourRes.rows,
      top_items:   topItemsRes.rows,
      top_clients: topClientsRes.rows,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
