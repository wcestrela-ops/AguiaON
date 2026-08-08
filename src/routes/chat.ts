import { Router, Request, Response } from 'express';
import pool from '../shared/db';
import { requireAuth, requireRole } from '../shared/authMiddleware';

const router = Router();

function getEstId(req: Request): string {
  const user = req.user!;
  if (user.role === 'LOJISTA' || user.role === 'STAFF') return user.establishmentId!;
  return (req.body?.establishment_id as string) || (req.query.establishment_id as string) || '';
}

async function getWACfg(estId: string) {
  const [waRes, gRes] = await Promise.all([
    pool.query(`SELECT instance_name FROM whatsapp_configs WHERE establishment_id=$1`, [estId]),
    pool.query(`SELECT key, value FROM global_settings WHERE category='WHATSAPP' AND key IN ('evolution_url','evolution_token')`),
  ]);
  if (!waRes.rows[0]) return null;
  const { decrypt, isSensitiveKey } = await import('../shared/cryptoUtil');
  const map: Record<string, string> = {};
  for (const r of gRes.rows) map[r.key] = isSensitiveKey(r.key) ? decrypt(r.value) : r.value;
  return {
    instance: waRes.rows[0].instance_name as string,
    url:      (map.evolution_url || '').replace(/\/$/, ''),
    token:    map.evolution_token || '',
  };
}

function evHeaders(token: string) {
  return { 'Content-Type': 'application/json', apikey: token };
}

async function evFetch(url: string, token: string, body: object, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: evHeaders(token),
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    return r;
  } finally {
    clearTimeout(tid);
  }
}

function extractText(msg: any): string {
  return msg?.message?.conversation
      || msg?.message?.extendedTextMessage?.text
      || msg?.message?.imageMessage?.caption
      || '';
}

// ─── GET /chat/conversations ──────────────────────────────────
router.get('/conversations', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id ausente.' });

  try {
    const cfg = await getWACfg(estId);
    if (!cfg?.instance) {
      console.warn('[chat/conversations] Sem instância WA configurada para', estId);
      return res.json([]);
    }

    console.log('[chat/conversations] Evolution findChats →', cfg.url, cfg.instance);
    const r = await evFetch(`${cfg.url}/chat/findChats/${cfg.instance}`, cfg.token, {});

    const rawText = await r.text();
    if (!r.ok) {
      console.error('[chat/conversations] Evolution error:', r.status, rawText);
      return res.json([]);
    }

    const raw = JSON.parse(rawText);
    const chats: any[] = Array.isArray(raw) ? raw : (raw.chats || raw.data || raw.records || []);
    console.log('[chat/conversations] chats recebidos:', chats.length);

    const contacts = chats
      .filter((c: any) => (c.id || '').endsWith('@s.whatsapp.net'))
      .map((c: any) => ({
        jid:        c.id as string,
        name:       c.name || c.pushName || c.verifiedName || (c.id as string).replace('@s.whatsapp.net', ''),
        unread:     c.unreadCount || 0,
        lastMsg:    extractText(c.lastMessage),
        lastTs:     c.lastMessage?.messageTimestamp || 0,
        lastFromMe: c.lastMessage?.key?.fromMe ?? false,
      }))
      .sort((a: any, b: any) => b.lastTs - a.lastTs)
      .slice(0, 60);

    res.json(contacts);
  } catch (err: any) {
    console.error('[chat/conversations]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /chat/messages/:jid ──────────────────────────────────
router.get('/messages/:jid', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id ausente.' });

  const jid   = decodeURIComponent(req.params.jid);
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  try {
    const cfg = await getWACfg(estId);
    if (!cfg?.instance) return res.json([]);

    console.log('[chat/messages] Evolution findMessages → jid:', jid);
    const r = await evFetch(`${cfg.url}/chat/findMessages/${cfg.instance}`, cfg.token, { where: { key: { remoteJid: jid } }, limit });

    const rawText = await r.text();
    if (!r.ok) {
      console.error('[chat/messages] Evolution error:', r.status, rawText);
      return res.json([]);
    }

    const raw = JSON.parse(rawText);
    const msgs: any[] = Array.isArray(raw)
      ? raw
      : (raw.messages?.records || raw.records || raw.data || []);

    const result = msgs
      .map((m: any) => ({
        fromMe:    m.key?.fromMe ?? false,
        text:      extractText(m),
        timestamp: m.messageTimestamp || 0,
        type:      Object.keys(m.message || {})[0] || 'conversation',
      }))
      .sort((a: any, b: any) => a.timestamp - b.timestamp);

    res.json(result);
  } catch (err: any) {
    console.error('[chat/messages]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /chat/send ──────────────────────────────────────────
router.post('/send', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: Response) => {
  const estId = getEstId(req);
  const { jid, text } = req.body;
  if (!jid || !text) return res.status(400).json({ error: 'jid e text obrigatórios.' });

  try {
    const cfg = await getWACfg(estId);
    if (!cfg?.instance) return res.status(500).json({ error: 'WhatsApp não configurado.' });

    console.log('[chat/send] Evolution sendText → jid:', jid);
    const r = await evFetch(`${cfg.url}/message/sendText/${cfg.instance}`, cfg.token, { number: jid, text }, 15000);

    const rawText = await r.text();
    if (!r.ok) {
      console.error('[chat/send] Evolution error:', r.status, rawText);
      return res.status(502).json({ error: `Evolution: ${r.status} — ${rawText}` });
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error('[chat/send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
