/**
 * Rotas admin do Gateway de SMS — /admin/sms
 *
 * SUPERADMIN gerencia o(s) gateway(s) compartilhado(s) da plataforma
 * (establishment_id = NULL). Um lojista (LOJISTA) pode opcionalmente
 * cadastrar o próprio gateway (OWN) — nesse caso a cadeia de failover
 * prioriza o dele antes de cair pro compartilhado.
 */

import { Router, Request } from 'express';
import { requireAdmin, requireAuth, requireRole } from '../shared/authMiddleware';
import {
  PROVIDER_TYPES,
  listProviders,
  createProviderConfig,
  updateProviderConfig,
  deleteProviderConfig,
  testProviderConnection,
  listDispatches,
  sendSms,
} from '../shared/smsSender';

const router = Router();

// ─── Catálogo de provedores suportados (pra montar o form) ──────
// Não é dado sensível (só define os campos do formulário) — liberado pra
// LOJISTA também, já que o painel dele usa esse mesmo catálogo pro gateway
// próprio (OWN).
router.get('/providers/schema', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), (_req, res) => {
  res.json({ types: PROVIDER_TYPES });
});

// ─── CRUD — plataforma (SUPERADMIN, establishment_id = NULL) ────
router.get('/', requireAdmin, async (_req, res) => {
  try {
    const providers = await listProviders(null);
    res.json({ providers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { provider, label, config, priority } = req.body || {};
    if (!provider || !PROVIDER_TYPES[provider as keyof typeof PROVIDER_TYPES]) {
      return res.status(400).json({ error: 'Provedor inválido.' });
    }
    const created = await createProviderConfig({ establishment_id: null, provider, label, config: config || {}, priority });
    res.status(201).json({ provider: created });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await updateProviderConfig(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Provedor não encontrado.' });
    res.json({ provider: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await deleteProviderConfig(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await testProviderConnection(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Envio manual (admin) ───────────────────────────────────────
router.post('/send', requireAdmin, async (req, res) => {
  try {
    const { phone, message, establishment_id } = req.body || {};
    if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios.' });
    const result = await sendSms(phone, message, { establishmentId: establishment_id || null, action: 'manual' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Histórico de envios ─────────────────────────────────────────
router.get('/dispatches', requireAdmin, async (req, res) => {
  try {
    const establishmentId = (req.query.establishment_id as string) || null;
    const dispatches = await listDispatches(establishmentId, Number(req.query.limit) || 50);
    res.json({ dispatches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Escopo lojista — cadastrar/gerenciar gateway próprio (OWN) ──
// LOJISTA usa o establishmentId do próprio token; SUPERADMIN pode operar
// qualquer loja (mesmo padrão de getEstId/estabId usado em vehicles.ts,
// agenda/index.ts etc.) — via establishment_id no body (POST/PUT) ou query (GET).
function estIdFromReq(req: Request): string {
  const user = req.user!;
  if (user.role === 'LOJISTA') return user.establishmentId!;
  return (req.body?.establishment_id as string) || (req.query.establishment_id as string) || '';
}

router.get('/mine', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req, res) => {
  try {
    const estId = estIdFromReq(req);
    if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
    const providers = await listProviders(estId);
    res.json({ providers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mine', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req, res) => {
  try {
    const estId = estIdFromReq(req);
    if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
    const { provider, label, config, priority } = req.body || {};
    if (!provider || !PROVIDER_TYPES[provider as keyof typeof PROVIDER_TYPES]) {
      return res.status(400).json({ error: 'Provedor inválido.' });
    }
    const created = await createProviderConfig({ establishment_id: estId, provider, label, config: config || {}, priority });
    res.status(201).json({ provider: created });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: garante que o provider pertence ao establishment de quem está chamando
// (mesma disciplina de posse já usada em todo o resto do projeto — ver Fase 1)
async function assertOwnProvider(establishmentId: string, providerId: string): Promise<void> {
  const providers = await listProviders(establishmentId);
  const owns = providers.some(p => p.id === providerId && p.establishment_id === establishmentId);
  if (!owns) throw { status: 404, message: 'Gateway não encontrado.' };
}

router.put('/mine/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req, res) => {
  try {
    const estId = estIdFromReq(req);
    if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
    await assertOwnProvider(estId, req.params.id);
    const updated = await updateProviderConfig(req.params.id, req.body || {});
    res.json({ provider: updated });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/mine/:id', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req, res) => {
  try {
    const estId = estIdFromReq(req);
    if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
    await assertOwnProvider(estId, req.params.id);
    await deleteProviderConfig(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/mine/:id/test', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req, res) => {
  try {
    const estId = estIdFromReq(req);
    if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
    await assertOwnProvider(estId, req.params.id);
    const result = await testProviderConnection(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/mine/dispatches', requireAuth, requireRole('LOJISTA', 'SUPERADMIN'), async (req, res) => {
  try {
    const estId = estIdFromReq(req);
    if (!estId) return res.status(400).json({ error: 'establishment_id obrigatório.' });
    const dispatches = await listDispatches(estId, Number(req.query.limit) || 50);
    res.json({ dispatches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
