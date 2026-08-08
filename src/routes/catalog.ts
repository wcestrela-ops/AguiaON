import { Router, Request, Response } from 'express';
import pool from '../shared/db';
import { requireAuth, requireRole } from '../shared/authMiddleware';
import { syncAgataContext } from '../shared/syncAgata';

const router = Router();

// ── Migração: coluna internal_only ───────────────────────────
(async () => {
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_only BOOLEAN NOT NULL DEFAULT false`);
  } catch {}
})();

// Gera slug a partir do nome do produto
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// ─────────────────────────────────────────────────────────────
// GET /api/catalog/addon-groups — lista grupos de adicionais do estabelecimento
// IMPORTANTE: deve vir ANTES de /:establishment_id para não ser capturada como UUID
// ─────────────────────────────────────────────────────────────
router.get('/addon-groups', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId : req.query.establishment_id as string;
  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });
  try {
    const groups = await pool.query(
      `SELECT ag.*, json_agg(agi ORDER BY agi.sort_order) FILTER (WHERE agi.id IS NOT NULL) AS items
       FROM addon_groups ag
       LEFT JOIN addon_group_items agi ON agi.addon_group_id = ag.id
       WHERE ag.establishment_id = $1
       GROUP BY ag.id
       ORDER BY ag.sort_order ASC, ag.name ASC`,
      [estId]
    );
    res.json(groups.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// POST /api/catalog/addon-groups — criar ou atualizar grupo + seus itens
// ─────────────────────────────────────────────────────────────
router.post('/addon-groups', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId : req.body.establishment_id;
  const { id, name, min_qty = 0, max_qty = 1, is_required = false, items = [] } = req.body;
  if (!name || !estId) return res.status(400).json({ error: 'name e establishment_id são obrigatórios.' });
  try {
    let groupId: string;
    if (id) {
      const r = await pool.query(
        `UPDATE addon_groups SET name=$1, min_qty=$2, max_qty=$3, is_required=$4, updated_at=NOW()
         WHERE id=$5 AND establishment_id=$6 RETURNING id`,
        [name, min_qty, max_qty, is_required, id, estId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Grupo não encontrado.' });
      groupId = id;
      await pool.query(`DELETE FROM addon_group_items WHERE addon_group_id=$1`, [groupId]);
    } else {
      const r = await pool.query(
        `INSERT INTO addon_groups (establishment_id, name, min_qty, max_qty, is_required)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [estId, name, min_qty, max_qty, is_required]
      );
      groupId = r.rows[0].id;
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.name) continue;
      await pool.query(
        `INSERT INTO addon_group_items (addon_group_id, name, price, is_active, sort_order)
         VALUES ($1,$2,$3,true,$4)`,
        [groupId, item.name, parseFloat(item.price) || 0, i]
      );
    }
    const result = await pool.query(
      `SELECT ag.*, json_agg(agi ORDER BY agi.sort_order) FILTER (WHERE agi.id IS NOT NULL) AS items
       FROM addon_groups ag LEFT JOIN addon_group_items agi ON agi.addon_group_id = ag.id
       WHERE ag.id=$1 GROUP BY ag.id`,
      [groupId]
    );
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/catalog/addon-groups/:id
// ─────────────────────────────────────────────────────────────
router.delete('/addon-groups/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId : req.query.establishment_id as string;
  try {
    await pool.query(`DELETE FROM addon_groups WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/catalog/items/:id/addon-groups — vincula grupos a um produto
// ─────────────────────────────────────────────────────────────
router.put('/items/:id/addon-groups', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId : req.body.establishment_id;
  const { id } = req.params;
  const { addon_group_ids = [] }: { addon_group_ids: string[] } = req.body;
  try {
    const prod = await pool.query(`SELECT id FROM products WHERE id=$1 AND establishment_id=$2`, [id, estId]);
    if (!prod.rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    await pool.query(`DELETE FROM product_addon_groups WHERE product_id=$1`, [id]);
    for (let i = 0; i < addon_group_ids.length; i++) {
      await pool.query(
        `INSERT INTO product_addon_groups (product_id, addon_group_id, sort_order) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [id, addon_group_ids[i], i]
      );
    }
    res.json({ success: true, linked: addon_group_ids.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * GET /api/catalog/:establishment_id
 * Retorna categorias e produtos agrupados para a vitrine, incluindo variantes e opcionais.
 */
router.get('/:establishment_id', async (req: Request, res: Response) => {
  const { establishment_id } = req.params;
  try {
    // Resolve slug → UUID (aceita UUID direto ou slug amigável)
    const estRes = await pool.query(
      `SELECT id FROM establishments WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [establishment_id]
    );
    if (!estRes.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    const estId = estRes.rows[0].id;

    const [catsRes, productsRes] = await Promise.all([
      pool.query(
        `SELECT * FROM categories WHERE establishment_id=$1 ORDER BY order_index ASC, name ASC`,
        [estId]
      ),
      pool.query(
        `SELECT * FROM products WHERE establishment_id=$1 AND active=true AND internal_only=false ORDER BY name ASC`,
        [estId]
      ),
    ]);

    const productIds = productsRes.rows.map(p => p.id);

    // Carrega variantes e opcionais de todos os produtos em paralelo
    let variantsMap: Record<string, any[]> = {};
    let optionsMap: Record<string, any[]> = {};
    let addonMap: Record<string, any[]> = {};

    if (productIds.length) {
      const [varRes, optRes, addonRes] = await Promise.all([
        pool.query(
          `SELECT * FROM product_variants
           WHERE product_id=ANY($1) AND is_active=true
           ORDER BY type ASC, order_index ASC`,
          [productIds]
        ).catch(() => ({ rows: [] })),
        pool.query(
          `SELECT po.*, poi.id AS item_id, poi.name AS item_name,
                  poi.additional_price, poi.is_active AS item_active, poi.order_index AS item_order
           FROM product_options po
           JOIN product_option_items poi ON poi.option_id = po.id
           WHERE po.product_id=ANY($1) AND poi.is_active=true
           ORDER BY po.order_index ASC, poi.order_index ASC`,
          [productIds]
        ).catch(() => ({ rows: [] })),
        pool.query(
          `SELECT pag.product_id, ag.id, ag.name, ag.min_qty, ag.max_qty, ag.is_required, pag.sort_order,
                  agi.id AS item_id, agi.name AS item_name, agi.price AS item_price, agi.sort_order AS item_sort
           FROM product_addon_groups pag
           JOIN addon_groups ag ON ag.id = pag.addon_group_id
           JOIN addon_group_items agi ON agi.addon_group_id = ag.id AND agi.is_active = true
           WHERE pag.product_id=ANY($1)
           ORDER BY pag.sort_order ASC, agi.sort_order ASC`,
          [productIds]
        ).catch(() => ({ rows: [] })),
      ]);

      varRes.rows.forEach(v => {
        if (!variantsMap[v.product_id]) variantsMap[v.product_id] = [];
        variantsMap[v.product_id].push(v);
      });

      // Agrupamento de opcionais por produto → grupo → itens
      const optionGroups: Record<string, Record<string, any>> = {};
      optRes.rows.forEach(row => {
        if (!optionGroups[row.product_id]) optionGroups[row.product_id] = {};
        if (!optionGroups[row.product_id][row.id]) {
          optionGroups[row.product_id][row.id] = {
            id: row.id, name: row.name, min_options: row.min_options,
            max_options: row.max_options, is_required: row.is_required,
            order_index: row.order_index, items: [],
          };
        }
        optionGroups[row.product_id][row.id].items.push({
          id: row.item_id, name: row.item_name,
          additional_price: row.additional_price, order_index: row.item_order,
        });
      });
      Object.entries(optionGroups).forEach(([pid, groups]) => {
        optionsMap[pid] = Object.values(groups);
      });

      // Agrupa addon_groups por produto
      const addonGroupsTemp: Record<string, Record<string, any>> = {};
      addonRes.rows.forEach((row: any) => {
        if (!addonGroupsTemp[row.product_id]) addonGroupsTemp[row.product_id] = {};
        if (!addonGroupsTemp[row.product_id][row.id]) {
          addonGroupsTemp[row.product_id][row.id] = {
            id: row.id, name: row.name,
            min_qty: row.min_qty, max_qty: row.max_qty,
            is_required: row.is_required, sort_order: row.sort_order, items: [],
          };
        }
        addonGroupsTemp[row.product_id][row.id].items.push({
          id: row.item_id, name: row.item_name, price: row.item_price, sort_order: row.item_sort,
        });
      });
      Object.entries(addonGroupsTemp).forEach(([pid, groups]) => {
        addonMap[pid] = Object.values(groups);
      });
    }

    const products = productsRes.rows.map(p => ({
      ...p,
      variants:     variantsMap[p.id] || [],
      options:      optionsMap[p.id]  || [],
      addon_groups: addonMap[p.id] || [],
    }));

    const catalog = catsRes.rows.map(cat => ({
      ...cat,
      items: products.filter(p => p.category_id === cat.id),
    }));

    const uncatItems = products.filter(p => !p.category_id);
    if (uncatItems.length > 0) {
      catalog.push({ id: null, name: 'Outros', active: true, sort_order: 999, items: uncatItems } as any);
    }

    res.json(catalog);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/catalog/:establishment_id/p/:slug
 * Produto individual por slug (para link direto do Instagram, etc.)
 */
router.get('/:establishment_id/p/:slug', async (req: Request, res: Response) => {
  const { establishment_id, slug } = req.params;
  try {
    const pRes = await pool.query(
      `SELECT * FROM products WHERE establishment_id=$1 AND slug=$2 AND active=true`,
      [establishment_id, slug]
    );
    if (!pRes.rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    const p = pRes.rows[0];

    const [varRes, optRes] = await Promise.all([
      pool.query(
        `SELECT * FROM product_variants WHERE product_id=$1 AND is_active=true ORDER BY type ASC, order_index ASC`,
        [p.id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT po.*, poi.id AS item_id, poi.name AS item_name, poi.additional_price, poi.order_index AS item_order
         FROM product_options po
         JOIN product_option_items poi ON poi.option_id = po.id AND poi.is_active=true
         WHERE po.product_id=$1 ORDER BY po.order_index ASC, poi.order_index ASC`,
        [p.id]
      ).catch(() => ({ rows: [] })),
    ]);

    const optionGroups: Record<string, any> = {};
    optRes.rows.forEach(row => {
      if (!optionGroups[row.id]) {
        optionGroups[row.id] = { id: row.id, name: row.name, min_options: row.min_options, max_options: row.max_options, is_required: row.is_required, items: [] };
      }
      optionGroups[row.id].items.push({ id: row.item_id, name: row.item_name, additional_price: row.additional_price });
    });

    res.json({ ...p, variants: varRes.rows, options: Object.values(optionGroups) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/catalog/categories — criar ou editar categoria
 */
router.post('/categories', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const { id, name, sort_order } = req.body;
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId : req.body.establishment_id;
  if (!name || !estId) return res.status(400).json({ error: 'Nome e establishment_id são obrigatórios.' });

  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE categories SET name=$1, order_index=$2, updated_at=NOW()
         WHERE id=$3 AND establishment_id=$4 RETURNING *`,
        [name, sort_order || 0, id, estId]
      );
    } else {
      result = await pool.query(
        `INSERT INTO categories (establishment_id, name, order_index) VALUES ($1,$2,$3) RETURNING *`,
        [estId, name, sort_order || 0]
      );
    }
    if (!result.rows.length) return res.status(404).json({ error: 'Categoria não encontrada ou sem permissão.' });
    res.json(result.rows[0]);
    syncAgataContext(estId as string).catch(() => {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/catalog/items — criar ou editar produto
 */
router.post('/items', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const {
    id, category_id, name, description, price, type,
    image_base64, video_url, settings, active, internal_only,
  } = req.body;
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId : req.body.establishment_id;

  if (!name || !type || !estId) {
    return res.status(400).json({ error: 'Nome, tipo e establishment_id são obrigatórios.' });
  }
  const validTypes = ['product', 'service', 'plan'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Tipo de item inválido.' });
  if (type === 'plan' && (!settings || !settings.recurrence)) {
    return res.status(400).json({ error: 'Planos exigem recurrence em settings.' });
  }
  if (image_base64 && image_base64.length > 2800000) {
    return res.status(413).json({ error: 'Imagem muito grande (Limite 2MB).' });
  }

  try {
    // Gera slug único se for produto novo ou se o nome mudou
    let slug = toSlug(name);
    // Verifica colisão de slug no mesmo estabelecimento
    const slugCheck = await pool.query(
      `SELECT id FROM products WHERE establishment_id=$1 AND slug=$2 AND ($3::uuid IS NULL OR id<>$3)`,
      [estId, slug, id || null]
    );
    if (slugCheck.rows.length) {
      // Adiciona sufixo numérico para garantir unicidade
      const suffix = Date.now().toString(36);
      slug = `${slug}-${suffix}`;
    }

    let result;
    if (id) {
      result = await pool.query(
        `UPDATE products SET
           category_id=$1, name=$2, description=$3, price=$4,
           type=$5, image_base64=$6, video_url=$7, settings=$8,
           active=$9, slug=$10, internal_only=$11, updated_at=NOW()
         WHERE id=$12 AND establishment_id=$13 RETURNING *`,
        [category_id || null, name, description || '', parseFloat(price) || 0, type,
         image_base64 || null, video_url || null, settings || {},
         active !== false, slug, internal_only === true, id, estId]
      );
    } else {
      result = await pool.query(
        `INSERT INTO products
           (category_id, name, description, price, type,
            image_base64, video_url, settings, active, slug, establishment_id, internal_only)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [category_id || null, name, description || '', parseFloat(price) || 0, type,
         image_base64 || null, video_url || null, settings || {},
         active !== false, slug, estId, internal_only === true]
      );
    }

    if (!result.rows.length) return res.status(404).json({ error: 'Item não encontrado ou sem permissão.' });
    res.json(result.rows[0]);
    // Sincroniza contexto da Ágata em background (não bloqueia resposta)
    syncAgataContext(estId as string).catch(() => {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/catalog/items/:id
 */
router.delete('/items/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const estId = req.user!.role === 'LOJISTA' ? req.user!.establishmentId : req.query.establishment_id;
  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });

  try {
    const result = await pool.query(
      `DELETE FROM products WHERE id=$1 AND establishment_id=$2 RETURNING id`,
      [id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Item não encontrado ou sem permissão.' });
    res.json({ success: true, deleted_id: id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
