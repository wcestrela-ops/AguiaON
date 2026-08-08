/**
 * ROTAS DE VEÍCULOS — AguiaON (Fase 2, primeira fatia)
 * Prefixo: /veiculos
 *
 * Escopo desta fatia: CRUD de veículo + consulta de posição via GPSWOX.
 * Comandos (bloquear/desbloquear), contratos, histórico e compartilhamento
 * ficam para uma fatia futura — ver AguiaON-ROADMAP.md, Fase 2.
 *
 * Autenticação:
 *  - Gestão (CRUD, config GPSWOX): LOJISTA ou SUPERADMIN
 *  - Consulta da própria posição: CLIENT (dono do veículo)
 */

import { Router, Request, Response } from 'express';
import pool from '../shared/db';
import { requireAuth, requireRole } from '../shared/authMiddleware';
import {
  ensureTables,
  getGpswoxConfig,
  saveGpswoxConfig,
  isGpswoxConfigured,
  getDeviceLocation,
} from '../shared/gpswoxClient';
import { getPlanLimits, checkLimit } from '../shared/platformBilling';

const router = Router();

// ─── Helper tenant (mesmo padrão de delivery.ts / gymClients.ts) ──
function getEstId(req: Request): string {
  const user = req.user!;
  if (user.role === 'LOJISTA') return user.establishmentId!;
  return (req.body?.establishment_id as string) || (req.query.establishment_id as string) || '';
}

// ═══════════════════════════════════════════════════
// CONFIGURAÇÃO GPSWOX (por empresa — LOJISTA ou SUPERADMIN)
// ═══════════════════════════════════════════════════

router.get('/gpswox-config', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const cfg = await getGpswoxConfig(estId);
    // Nunca retorna o api_hash em claro — só se está configurado
    res.json({ url: cfg.url, configured: isGpswoxConfigured(cfg) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/gpswox-config', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  const { url, api_hash } = req.body || {};
  if (!url || !api_hash) return res.status(400).json({ error: 'url e api_hash são obrigatórios.' });
  try {
    await saveGpswoxConfig(estId, url, api_hash);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// CRUD DE VEÍCULOS (LOJISTA ou SUPERADMIN)
// ═══════════════════════════════════════════════════

// GET /veiculos — lista veículos do estabelecimento
router.get('/', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    await ensureTables();
    const result = await pool.query(
      `SELECT v.*, u.full_name AS owner_name, u.whatsapp AS owner_whatsapp
       FROM vehicles v
       LEFT JOIN users u ON u.id = v.user_id
       WHERE v.establishment_id = $1
       ORDER BY v.created_at DESC`,
      [estId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /veiculos — cria ou edita veículo (id no body = edição)
router.post('/', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  const { id, user_id, plate, brand, model, color, gpswox_device_id, status } = req.body || {};
  try {
    await ensureTables();

    // Se vincular a um cliente, garante que o cliente pertence ao mesmo establishment
    if (user_id) {
      const ownerOk = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND establishment_id=$2`, [user_id, estId]);
      if (!ownerOk.rows.length) return res.status(400).json({ error: 'Cliente não pertence a este estabelecimento.' });
    }

    let result;
    if (id) {
      // Isolamento multi-tenant: só edita veículo do próprio establishment
      const own = await pool.query(`SELECT 1 FROM vehicles WHERE id=$1 AND establishment_id=$2`, [id, estId]);
      if (!own.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });

      result = await pool.query(
        `UPDATE vehicles
         SET user_id=$1, plate=$2, brand=$3, model=$4, color=$5, gpswox_device_id=$6,
             status=COALESCE($7, status), updated_at=NOW()
         WHERE id=$8 AND establishment_id=$9 RETURNING *`,
        [user_id || null, plate || null, brand || null, model || null, color || null, gpswox_device_id || null, status || null, id, estId]
      );
    } else {
      // Fase 5 (billing): teto de crescimento por plano — só na criação, nunca na edição
      const limits = await getPlanLimits(estId);
      const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM vehicles WHERE establishment_id=$1`, [estId]);
      const limitError = checkLimit(limits, 'max_vehicles', countRes.rows[0].n);
      if (limitError) return res.status(402).json({ error: limitError });

      result = await pool.query(
        `INSERT INTO vehicles (establishment_id, user_id, plate, brand, model, color, gpswox_device_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, 'pending_installation'))
         RETURNING *`,
        [estId, user_id || null, plate || null, brand || null, model || null, color || null, gpswox_device_id || null, status || null]
      );
    }
    res.status(id ? 200 : 201).json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /veiculos/:id
router.delete('/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const result = await pool.query(`DELETE FROM vehicles WHERE id=$1 AND establishment_id=$2 RETURNING id`, [req.params.id, estId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /veiculos/:id/localizacao — posição via GPSWOX (LOJISTA/SUPERADMIN, qualquer veículo do establishment)
router.get('/:id/localizacao', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
  try {
    const veh = await pool.query(`SELECT gpswox_device_id FROM vehicles WHERE id=$1 AND establishment_id=$2`, [req.params.id, estId]);
    if (!veh.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    if (!veh.rows[0].gpswox_device_id) return res.status(422).json({ error: 'Veículo sem dispositivo GPSWOX vinculado.' });

    const location = await getDeviceLocation(estId, veh.rows[0].gpswox_device_id);
    res.json(location);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// CLIENTE FINAL — vê os próprios veículos (somente leitura)
// ═══════════════════════════════════════════════════

// GET /veiculos/meus — veículos vinculados ao cliente autenticado
router.get('/meus/lista', requireAuth, requireRole('CLIENT'), async (req: Request, res: Response) => {
  try {
    await ensureTables();
    const result = await pool.query(
      `SELECT id, plate, brand, model, color, status FROM vehicles WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /veiculos/meus/:id/localizacao — posição do próprio veículo
router.get('/meus/:id/localizacao', requireAuth, requireRole('CLIENT'), async (req: Request, res: Response) => {
  try {
    // Isolamento: o veículo precisa pertencer ao próprio cliente autenticado
    const veh = await pool.query(
      `SELECT establishment_id, gpswox_device_id FROM vehicles WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user!.userId]
    );
    if (!veh.rows.length) return res.status(404).json({ error: 'Veículo não encontrado.' });
    if (!veh.rows[0].gpswox_device_id) return res.status(422).json({ error: 'Veículo sem dispositivo GPSWOX vinculado.' });

    const location = await getDeviceLocation(veh.rows[0].establishment_id, veh.rows[0].gpswox_device_id);
    res.json(location);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
