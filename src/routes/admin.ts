import { Router } from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import pool from '../shared/db';
import { requireAdmin } from '../shared/authMiddleware';
import { getBlueprint, listBlueprints } from '../verticals/blueprints';
import { encrypt, decrypt, isSensitiveKey } from '../shared/cryptoUtil';
import { loadAIConfig, askAI } from '../shared/aiProvider';
import { logActivity } from '../shared/activityLogger';

const router = Router();

// ── Migração de colunas (executa na inicialização) ────────────
// is_suspended/suspension_reason/suspended_at/activated_until/store_token
// eram usadas neste arquivo (listagem, suspender/ativar loja, criar loja,
// seed de demos) desde antes deste projeto, mas nenhuma delas tinha
// CREATE/ALTER em lugar nenhum do código — só existiam no banco antigo.
// Sem isso, GET /admin/establishments e POST /admin/establishments (criar
// loja) quebram com "column does not exist" em banco novo.
(async () => {
  try {
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS suspension_reason TEXT`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS activated_until DATE`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS store_token TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_establishments_store_token ON establishments(store_token) WHERE store_token IS NOT NULL`);
  } catch (e) { console.error('[admin] migration error:', e); }
})();

// ─────────────────────────────────────────────────────────────
// GET /admin/ai-status — diagnóstico da IA (requer auth admin)
// Mostra quais provedores têm chave configurada sem expô-las
// ─────────────────────────────────────────────────────────────
router.get('/ai-status', requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM global_settings WHERE key = ANY($1)`,
      [['ai_primary_provider','ai_groq_key','ai_openai_key','ai_gemini_key','ai_atmos_key','ai_local_url']]
    );
    const m: Record<string,string> = {};
    result.rows.forEach(r => { m[r.key] = r.value; });

    res.json({
      primary_provider: m.ai_primary_provider || '(não configurado)',
      providers: {
        groq:      { configured: !!(m.ai_groq_key     && m.ai_groq_key.length > 5) },
        openai:    { configured: !!(m.ai_openai_key   && m.ai_openai_key.length > 5) },
        gemini:    { configured: !!(m.ai_gemini_key   && m.ai_gemini_key.length > 5) },
        anthropic: { configured: !!(m.ai_atmos_key    && m.ai_atmos_key.length > 5) },
        local:     { configured: !!(m.ai_local_url    && m.ai_local_url.length > 3) },
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/ai-test — diagnóstico completo por provider (requer auth admin)
// ─────────────────────────────────────────────────────────────
router.get('/ai-test', requireAdmin, async (_req, res) => {
  const TEST_MSG = [{ role: 'user' as const, content: 'Responda apenas: OK' }];
  const results: Record<string, any> = {};

  let cfg: any;
  try {
    cfg = await loadAIConfig();
  } catch (err: any) {
    return res.status(500).json({ error: `loadAIConfig falhou: ${err.message}` });
  }

  // Testa Gemini
  if (cfg.geminiKey) {
    try {
      const text = TEST_MSG.map((m: any) => m.content).join('\n');
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${cfg.geminiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { maxOutputTokens: 10 } }) }
      );
      const body = await r.json() as any;
      results.gemini = { status: r.status, ok: r.ok, response: body.candidates?.[0]?.content?.parts?.[0]?.text || null, error: body.error || null };
    } catch (e: any) { results.gemini = { status: 0, ok: false, error: e.message }; }
  } else { results.gemini = { status: null, ok: false, error: 'Chave não carregada após decrypt' }; }

  // Testa Groq
  if (cfg.groqKey) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.groqKey}` },
        body: JSON.stringify({ model: cfg.groqModel || 'llama3-8b-8192', messages: TEST_MSG, max_tokens: 10 })
      });
      const body = await r.json() as any;
      results.groq = { status: r.status, ok: r.ok, response: body.choices?.[0]?.message?.content || null, error: body.error || null };
    } catch (e: any) { results.groq = { status: 0, ok: false, error: e.message }; }
  } else { results.groq = { status: null, ok: false, error: 'Chave não carregada após decrypt' }; }

  // Testa OpenAI
  if (cfg.openaiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiKey}` },
        body: JSON.stringify({ model: cfg.openaiModel || 'gpt-4o-mini', messages: TEST_MSG, max_tokens: 10 })
      });
      const body = await r.json() as any;
      results.openai = { status: r.status, ok: r.ok, response: body.choices?.[0]?.message?.content || null, error: body.error || null };
    } catch (e: any) { results.openai = { status: 0, ok: false, error: e.message }; }
  } else { results.openai = { status: null, ok: false, error: 'Chave não carregada após decrypt' }; }

  // Testa Anthropic
  if (cfg.anthropicKey) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: TEST_MSG })
      });
      const body = await r.json() as any;
      results.anthropic = { status: r.status, ok: r.ok, response: body.content?.[0]?.text || null, error: body.error || null };
    } catch (e: any) { results.anthropic = { status: 0, ok: false, error: e.message }; }
  } else { results.anthropic = { status: null, ok: false, error: 'Chave não carregada após decrypt' }; }

  res.json({ primary: cfg.primary, results });
});

// Todas as rotas admin exigem o ADMIN_SECRET_KEY no header x-admin-key
router.use(requireAdmin);

// --- SETTINGS (GET) ---
router.get('/settings', async (_req, res) => {
  try {
    const result = await pool.query('SELECT key, value, category FROM global_settings');
    const settings = result.rows.map(row => ({
      key: row.key,
      value: isSensitiveKey(row.key) ? decrypt(row.value) : row.value,
      category: row.category
    }));
    res.json(settings || []);
  } catch (err: any) {
    console.error('❌ ERRO NO GET /SETTINGS:', err.message);
    res.status(500).json({ error: 'Erro ao buscar configurações no banco.' });
  }
});

// --- SETTINGS (UPDATE) ---
router.post('/settings/update', async (req, res) => {
  const { key, value, category } = req.body;

  if (!key) return res.status(400).json({ error: 'Chave (key) não fornecida.' });

  try {
    const oldVal = await pool.query('SELECT value FROM global_settings WHERE key = $1', [key]);
    const oldEncrypted = oldVal.rows[0]?.value || '';
    const oldValue = isSensitiveKey(key) && oldEncrypted ? decrypt(oldEncrypted) : oldEncrypted;

    const storedValue = isSensitiveKey(key) ? encrypt(String(value)) : String(value);

    await pool.query(
      `INSERT INTO global_settings (key, value, category, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, storedValue, category || 'GENERAL']
    );

    pool.query(
      'INSERT INTO system_audit_logs (action, target, old_value, new_value) VALUES ($1, $2, $3, $4)',
      ['UPDATE_SETTING', key, oldValue, String(value)]
    ).catch(e => console.error('Erro na auditoria:', e.message));

    res.json({ success: true, message: `Configuração ${key} salva!` });
  } catch (err: any) {
    console.error('❌ ERRO NO POST /SETTINGS/UPDATE:', err.message);
    res.status(500).json({ error: 'Erro interno ao salvar no banco: ' + err.message });
  }
});

// --- TEST CONFIGS ---
import nodemailer from 'nodemailer';

router.post('/test-config', async (req, res) => {
  const { type, payload } = req.body;

  try {
    if (type === 'smtp') {
      const { host, user, pass, from, to } = payload;
      if (!host || !user || !pass || !from || !to) return res.status(400).json({ error: 'Preencha todos os campos do SMTP e um e-mail de destino.' });
      
      // Porta 587/STARTTLS — mesma configuração usada de verdade pelo envio de
      // OTP/notificações (otp_service.ts, gymExpiryJob.ts). Antes este teste
      // usava 465/SSL direto, uma config DIFERENTE da produção — passava aqui
      // e podia falhar de verdade depois, ou vice-versa.
      const transporter = nodemailer.createTransport({
        host, port: 587, secure: false,
        auth: { user, pass }
      });
      await transporter.sendMail({
        from, to,
        subject: 'Teste de Configuração Águia-ON',
        text: 'Se você recebeu este e-mail, seu SMTP está configurado corretamente no Águia-ON!'
      });
      return res.json({ success: true, message: 'E-mail de teste enviado com sucesso!' });
    }
    
    if (type === 'evolution') {
      const { url, token } = payload;
      if (!url || !token) return res.status(400).json({ error: 'Preencha a URL e o Token.' });
      
      const cleanUrl = url.replace(/\/$/, '');
      // Tenta buscar instâncias
      const reqFetch = await fetch(`${cleanUrl}/instance/fetchInstances`, {
        headers: { apikey: token }
      });
      if (!reqFetch.ok) throw new Error(await reqFetch.text());
      const data = await reqFetch.json();
      return res.json({ success: true, message: `Conexão bem-sucedida! ${data.length || 0} instância(s) encontrada(s).` });
    }

    if (type === 'openai') {
      const { key } = payload;
      if (!key) return res.status(400).json({ error: 'Chave da OpenAI não fornecida.' });
      
      const reqFetch = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'Responda apenas "OK" se estiver funcionando.' }],
          max_tokens: 5
        })
      });
      if (!reqFetch.ok) throw new Error(await reqFetch.text());
      const data = await reqFetch.json();
      
      return res.json({ success: true, message: `OpenAI respondeu: ${data.choices[0].message.content}` });
    }

    if (type === 'mercadopago') {
      const { token } = payload;
      if (!token) return res.status(400).json({ error: 'Access Token não fornecido.' });
      
      const reqFetch = await fetch('https://api.mercadopago.com/users/me', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!reqFetch.ok) throw new Error(await reqFetch.text());
      const data = await reqFetch.json();
      return res.json({ success: true, message: `Mercado Pago OK! Conta: ${data.first_name || data.nickname || data.id}` });
    }

    if (type === 'asaas') {
      const { key } = payload;
      if (!key) return res.status(400).json({ error: 'API Key não fornecida.' });

      const reqFetch = await fetch('https://api.asaas.com/v3/finance/balance', {
        headers: { access_token: key }
      });
      if (!reqFetch.ok) throw new Error(await reqFetch.text());
      const data = await reqFetch.json();
      return res.json({ success: true, message: `Asaas OK! Saldo atual: R$ ${data.balance}` });
    }

    if (type === 'firebase') {
      const { server_key, project_id, sender_id } = payload;
      if (!server_key) return res.status(400).json({ error: 'Server Key não fornecida.' });

      // Valida a Server Key tentando enviar uma mensagem de dry_run para um token fictício
      const reqFetch = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          Authorization: `key=${server_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dry_run: true,
          registration_ids: ['test_token_ag_on'],
          notification: { title: 'Águia-ON Test', body: 'Teste de conectividade FCM' },
        }),
      });
      const data = await reqFetch.json() as any;
      // FCM retorna 200 mesmo para tokens inválidos; erro real = código 401/403
      if (!reqFetch.ok) throw new Error(data.error || `HTTP ${reqFetch.status}`);
      // "InvalidRegistration" significa que a key é válida mas o token é fictício (esperado)
      const detail = data.results?.[0];
      const keyOk  = detail?.error === 'InvalidRegistration' || data.failure === 1;
      if (keyOk || data.success >= 0) {
        return res.json({
          success: true,
          message: `Firebase FCM conectado! Project: ${project_id || '—'} · Sender: ${sender_id || '—'}`,
        });
      }
      throw new Error(JSON.stringify(data));
    }

    if (type === 'wa_otp') {
      const { instance, url, token, to } = payload;
      if (!instance || !url || !token || !to) return res.status(400).json({ error: 'Preencha instância, URL, token e número de destino.' });
      const cleanUrl = url.replace(/\/$/, '');
      const number   = to.replace(/\D/g, '');
      const reqFetch = await fetch(`${cleanUrl}/message/sendText/${instance}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: token },
        body: JSON.stringify({ number, text: '*Águia-ON* — Teste de OTP via WhatsApp funcionando corretamente!' }),
      });
      if (!reqFetch.ok) {
        const err = await reqFetch.text();
        throw new Error(`Evolution HTTP ${reqFetch.status}: ${err.slice(0, 200)}`);
      }
      return res.json({ success: true, message: `Mensagem de teste enviada para ${to} via instância "${instance}"!` });
    }

    return res.status(400).json({ error: 'Tipo de teste desconhecido.' });
  } catch (err: any) {
    const errorMsg = err.message || 'Erro desconhecido';
    return res.status(500).json({ error: `Falha no teste: ${errorMsg}` });
  }
});

// --- SET SUPERADMIN PASSWORD ---
router.post('/set-superadmin-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO global_settings (key, value, category, updated_at)
       VALUES ('superadmin_password_hash', $1, 'SECURITY', NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [hash]
    );
    res.json({ success: true, message: 'Senha do SuperAdmin definida!' });
  } catch (err: any) {
    console.error('❌ ERRO NO SET SUPERADMIN PASSWORD:', err.message);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// --- PERSONALIDADE DA ÁGATA (GET) ---
router.get('/personality', async (_req, res) => {
  try {
    await pool.query(`ALTER TABLE agata_personality ADD COLUMN IF NOT EXISTS photo_url TEXT`);
    await pool.query(`ALTER TABLE agata_personality ADD COLUMN IF NOT EXISTS plus_price NUMERIC(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE agata_personality ADD COLUMN IF NOT EXISTS plus_trial_days INTEGER DEFAULT 7`);
    await pool.query(`ALTER TABLE agata_personality ADD COLUMN IF NOT EXISTS plus_prompt TEXT`);
    
    const result = await pool.query('SELECT * FROM agata_personality LIMIT 1');
    res.json(result.rows[0] || {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- PERSONALIDADE DA ÁGATA (UPDATE) ---
router.post('/personality/update', async (req, res) => {
  const { name, mood, forbidden_topics, photo_url, plus_price, plus_trial_days, plus_prompt } = req.body;
  try {
    await pool.query(
      `INSERT INTO agata_personality (id, name, mood, forbidden_topics, photo_url, plus_price, plus_trial_days, plus_prompt, updated_at)
       VALUES ('00000000-0000-0000-0000-000000000001', $1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         mood = EXCLUDED.mood,
         forbidden_topics = EXCLUDED.forbidden_topics,
         photo_url = EXCLUDED.photo_url,
         plus_price = EXCLUDED.plus_price,
         plus_trial_days = EXCLUDED.plus_trial_days,
         plus_prompt = EXCLUDED.plus_prompt,
         updated_at = NOW()`,
      [name, mood, forbidden_topics, photo_url || null, plus_price || 0, plus_trial_days || 7, plus_prompt || null]
    );
    res.json({ success: true });
  } catch (err: any) {
    console.error('❌ ERRO NO UPDATE PERSONALITY:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- STATS ---
router.get('/stats', async (_req, res) => {
  try {
    const [establishments, leads, clients, users] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM establishments"),
      pool.query("SELECT COUNT(*) FROM users WHERE auth_level = 'LEAD'"),
      pool.query("SELECT COUNT(*) FROM users WHERE auth_level = 'REGISTERED'"),
      pool.query("SELECT COUNT(*) FROM users"),
    ]);
    res.json({
      total_establishments: parseInt(establishments.rows[0].count),
      total_leads: parseInt(leads.rows[0].count),
      total_clients: parseInt(clients.rows[0].count),
      total_users: parseInt(users.rows[0].count),
    });
  } catch {
    res.json({ total_establishments: 0, total_leads: 0, total_clients: 0, total_users: 0 });
  }
});

// --- LOGS DA ÁGATA ---
router.get('/agata-logs', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ai_action_logs ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// --- AUDIT LOGS ---
router.get('/audit-logs', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_audit_logs ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/activity-logs — atividades do sistema (lojistas, usuários, pedidos)
// Query params: limit (default 100), type (filtro), since (ISO timestamp)
// ─────────────────────────────────────────────────────────────
router.get('/activity-logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '100')), 500);
    const type  = req.query.type ? String(req.query.type) : null;
    const since = req.query.since ? String(req.query.since) : null;

    const conditions: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (type) { conditions.push(`type = $${i++}`); vals.push(type); }
    if (since) { conditions.push(`created_at > $${i++}`); vals.push(since); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    vals.push(limit);

    const result = await pool.query(
      `SELECT * FROM system_activity_logs ${where} ORDER BY created_at DESC LIMIT $${i}`,
      vals
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/activity-logs/stream — SSE para tempo real
// ─────────────────────────────────────────────────────────────
router.get('/activity-logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let lastId = 0;

  // Busca o último ID para começar a partir daqui
  pool.query('SELECT COALESCE(MAX(id),0) AS max_id FROM system_activity_logs')
    .then(r => { lastId = parseInt(r.rows[0].max_id) || 0; })
    .catch(() => {});

  const interval = setInterval(async () => {
    try {
      const result = await pool.query(
        `SELECT * FROM system_activity_logs WHERE id > $1 ORDER BY created_at ASC LIMIT 20`,
        [lastId]
      );
      if (result.rows.length > 0) {
        lastId = result.rows[result.rows.length - 1].id;
        for (const row of result.rows) {
          res.write(`data: ${JSON.stringify(row)}\n\n`);
        }
      }
    } catch { /* ignora */ }
  }, 3000);

  req.on('close', () => clearInterval(interval));
});

// --- MÓDULOS (GET) ---
router.get('/modules', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM modules ORDER BY name');
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// --- MÓDULOS (ADD) ---
router.post('/modules/add', async (req, res) => {
  const { name, slug, config_url, admin_url, profissional_url, icon } = req.body;
  if (!name || !slug || !config_url) return res.status(400).json({ error: 'name, slug e config_url são obrigatórios.' });

  try {
    await pool.query(
      `INSERT INTO modules (name, slug, config_url, admin_url, profissional_url, icon, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (slug) DO UPDATE
         SET config_url        = EXCLUDED.config_url,
             admin_url         = EXCLUDED.admin_url,
             profissional_url  = EXCLUDED.profissional_url,
             icon              = EXCLUDED.icon`,
      [name, slug, config_url, admin_url || null, profissional_url || null, icon || 'fa-puzzle-piece']
    );
    res.json({ success: true });
  } catch (err: any) {
    console.error('❌ Erro ao salvar módulo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- MÓDULOS (EDIT) ---
router.put('/modules/:id', async (req, res) => {
  const { name, config_url, admin_url, profissional_url, icon } = req.body;
  if (!name || !config_url) return res.status(400).json({ error: 'name e config_url são obrigatórios.' });

  try {
    const result = await pool.query(
      `UPDATE modules SET name=$1, config_url=$2, admin_url=$3, profissional_url=$4, icon=$5 WHERE id=$6 RETURNING *`,
      [name, config_url, admin_url || null, profissional_url || null, icon || 'fa-puzzle-piece', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Módulo não encontrado.' });
    res.json({ success: true, module: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- MÓDULOS (TOGGLE) ---
router.patch('/modules/:id/toggle', async (req, res) => {
  try {
    const { is_active } = req.body;
    const result = await pool.query(
      `UPDATE modules SET is_active=$1 WHERE id=$2 RETURNING id`,
      [is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Módulo não encontrado.' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- MÓDULOS (DELETE) ---
router.delete('/modules/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE modules SET is_active=false WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Módulo não encontrado.' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- SSO: GERA TOKEN DE ACESSO PARA UM MÓDULO EXTERNO ---
// O admin chama esta rota para obter um token que será passado ao módulo via URL
router.post('/modules/auth/:slug', async (req, res) => {
  const { slug } = req.params;
  const { userId } = req.body;

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET não configurado.' });

  try {
    // Valida que o módulo existe
    const mod = await pool.query('SELECT * FROM modules WHERE slug = $1 AND is_active = true', [slug]);
    if (mod.rows.length === 0) return res.status(404).json({ error: 'Módulo não encontrado.' });

    // Busca o usuário para montar o payload do token
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const u = userResult.rows[0];

    // Token de curta duração específico para este módulo
    const token = jwt.sign(
      {
        userId: u.id,
        whatsapp: u.whatsapp,
        authLevel: u.auth_level,
        establishmentId: u.establishment_id || null,
        module: slug,
      },
      secret,
      { expiresIn: '1h' }
    );

    res.json({ token, module_url: `${mod.rows[0].config_url}?sso_token=${token}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// LEADS (partner_requests)
// ─────────────────────────────────────────────────────────────

router.get('/leads', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM partner_requests ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/leads/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body; // senha inicial para o lojista

  try {
    const leadRes = await pool.query(`SELECT * FROM partner_requests WHERE id = $1`, [id]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = leadRes.rows[0];

    // 1. Cria o estabelecimento
    const slug = (lead.business_name as string)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const estRes = await pool.query(
      `INSERT INTO establishments (name, slug, city, vertical_slug)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [lead.business_name, slug, lead.city || '', lead.vertical_slug || 'generico']
    );
    const estId = estRes.rows[0].id;

    // 2. Cria ou associa o usuário lojista
    const passHash = await bcrypt.hash(password || Math.random().toString(36).slice(-8), 10);
    const clean    = (lead.whatsapp as string)?.replace(/\D/g, '') || null;
    const emailLow = (lead.email as string)?.toLowerCase().trim() || null;

    const existing = await pool.query(
      `SELECT id FROM users WHERE whatsapp = $1 OR (email IS NOT NULL AND lower(email) = $2) LIMIT 1`,
      [clean || '', emailLow || '']
    );

    let userId: string;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await pool.query(
        `UPDATE users SET auth_level='LOJISTA', establishment_id=$1, updated_at=NOW() WHERE id=$2`,
        [estId, userId]
      );
    } else {
      const userRes = await pool.query(
        `INSERT INTO users (full_name, whatsapp, email, password_hash, auth_level, establishment_id, is_confirmed)
         VALUES ($1, $2, $3, $4, 'LOJISTA', $5, true) RETURNING id`,
        [lead.owner_name, clean, emailLow, passHash, estId]
      );
      userId = userRes.rows[0].id;
    }

    // 3. Atualiza status do lead
    await pool.query(
      `UPDATE partner_requests SET status='APPROVED', updated_at=NOW() WHERE id=$1`, [id]
    );

    // 4. Se tem vertical_slug, aplica o blueprint automaticamente
    if (lead.vertical_slug && lead.vertical_slug !== 'generico') {
      try {
        const bp = getBlueprint(lead.vertical_slug);
        await pool.query(
          `UPDATE establishments SET
             active_features=$1, business_config=$2, cor_primaria=$3, cor_destaque=$4, setup_done=true
           WHERE id=$5`,
          [JSON.stringify(bp.features), JSON.stringify(bp.business_config), bp.cor_primaria, bp.cor_destaque, estId]
        );

        for (const s of bp.servicos_padrao) {
          await pool.query(
            `INSERT INTO agenda_servicos (establishment_id, nome, categoria, duracao_minutos, preco, ordem)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [estId, s.nome, s.categoria, s.duracao_minutos, s.preco, s.ordem]
          );
        }
      } catch (bpErr: any) {
        console.warn('Blueprint setup skipped:', bpErr.message);
      }
    }

    res.json({ success: true, establishment_id: estId, user_id: userId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/leads/:id/reject', async (req, res) => {
  try {
    await pool.query(`UPDATE partner_requests SET status='REJECTED', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ESTABELECIMENTOS
// ─────────────────────────────────────────────────────────────

/**
 * POST /admin/establishments — cria loja + lojista diretamente pelo SuperAdmin
 */
router.post('/establishments', requireAdmin, async (req, res) => {
  const {
    name, slug: rawSlug, city,
    owner_name, owner_email, owner_whatsapp, owner_password,
    vertical_slug,
  } = req.body;

  if (!name || !owner_name || (!owner_email && !owner_whatsapp)) {
    return res.status(400).json({ error: 'Nome da loja, nome do responsável e e-mail ou WhatsApp são obrigatórios.' });
  }

  const slug = rawSlug
    ? rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '')
    : name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    // Cria estabelecimento
    const existSlug = await pool.query(`SELECT id FROM establishments WHERE slug = $1`, [slug]);
    const finalSlug = existSlug.rows.length ? `${slug}-${Date.now()}` : slug;

    const estRes = await pool.query(
      `INSERT INTO establishments (name, slug, city, vertical_slug, is_active, is_public, setup_done, store_token)
       VALUES ($1, $2, $3, $4, true, true, false, encode(gen_random_bytes(16), 'hex')) RETURNING id`,
      [name, finalSlug, city || '', vertical_slug || 'generico']
    );
    const estId = estRes.rows[0].id;

    // Aplica blueprint se vertical informado
    const vslug = vertical_slug && vertical_slug !== 'generico' ? vertical_slug : null;
    if (vslug) {
      try {
        const bp = getBlueprint(vslug);
        await pool.query(
          `UPDATE establishments SET
             active_features=$1, business_config=$2,
             cor_primaria=$3, cor_destaque=$4, setup_done=true
           WHERE id=$5`,
          [JSON.stringify(bp.features), JSON.stringify(bp.business_config), bp.cor_primaria, bp.cor_destaque, estId]
        );
        for (const s of bp.servicos_padrao) {
          await pool.query(
            `INSERT INTO agenda_servicos (establishment_id, nome, categoria, duracao_minutos, preco, ordem)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [estId, s.nome, s.categoria, s.duracao_minutos, s.preco, s.ordem]
          );
        }
      } catch (bpErr: any) {
        console.warn('Blueprint parcial:', bpErr.message);
      }
    }

    // Cria usuário lojista
    const clean    = owner_whatsapp?.replace(/\D/g, '') || null;
    const emailLow = owner_email?.toLowerCase().trim()  || null;
    const passHash = await bcrypt.hash(
      owner_password?.trim() || Math.random().toString(36).slice(-8), 10
    );

    const existing = await pool.query(
      `SELECT id FROM users WHERE (whatsapp = $1 AND $1 IS NOT NULL) OR (lower(email) = $2 AND $2 IS NOT NULL) LIMIT 1`,
      [clean, emailLow]
    );

    let userId: string;
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      await pool.query(
        `UPDATE users SET auth_level='LOJISTA', establishment_id=$1, updated_at=NOW() WHERE id=$2`,
        [estId, userId]
      );
    } else {
      const userRes = await pool.query(
        `INSERT INTO users (full_name, whatsapp, email, password_hash, auth_level, establishment_id, is_confirmed)
         VALUES ($1, $2, $3, $4, 'LOJISTA', $5, true) RETURNING id`,
        [owner_name, clean, emailLow, passHash, estId]
      );
      userId = userRes.rows[0].id;
    }

    logActivity({
      type: 'LOJISTA_REGISTER',
      actor_role: 'SUPERADMIN',
      actor_id: estId,
      actor_name: owner_name,
      establishment_id: estId,
      establishment_name: name,
      description: `Nova loja criada: "${name}" (${vertical_slug || 'generico'}) — responsável: ${owner_name}`,
      metadata: { slug: finalSlug, city: city || null },
    });

    res.status(201).json({ success: true, establishment_id: estId, user_id: userId, slug: finalSlug });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/establishments', async (_req, res) => {
  try {
    // Gera token para lojas que ainda não têm
    await pool.query(`
      UPDATE establishments
      SET store_token = encode(gen_random_bytes(16), 'hex')
      WHERE store_token IS NULL
    `);

    const result = await pool.query(`
      SELECT e.id, e.name, e.slug, e.city,
             COALESCE(e.vertical_slug, 'generico') AS vertical_slug,
             COALESCE(e.setup_done, false)          AS setup_done,
             COALESCE(e.is_suspended, false)        AS is_suspended,
             e.suspension_reason, e.suspended_at,
             e.activated_until,
             e.is_public, e.is_active,
             e.created_at,
             e.store_token,
             u.full_name AS owner_name,
             u.email     AS owner_email,
             u.whatsapp  AS owner_whatsapp
      FROM establishments e
      LEFT JOIN users u ON u.establishment_id = e.id AND u.auth_level = 'LOJISTA'
      ORDER BY e.created_at DESC
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/users — lista todos os usuários por role
// ─────────────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  const role   = (req.query.role   as string | undefined)?.toUpperCase();
  const search = (req.query.search as string | undefined) || '';

  const conditions: string[] = [];
  const params: any[] = [];

  if (role && role !== 'ALL') {
    params.push(role);
    conditions.push(`u.auth_level = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = params.length;
    conditions.push(`(u.full_name ILIKE $${p} OR u.email ILIKE $${p} OR u.whatsapp ILIKE $${p})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Query base — sempre funciona (colunas essenciais que existem desde o início)
  const baseQuery = `
    SELECT
      u.id,
      u.full_name,
      u.email,
      u.whatsapp,
      u.auth_level,
      u.is_confirmed,
      u.created_at,
      e.name AS establishment_name,
      e.slug AS establishment_slug
    FROM users u
    LEFT JOIN establishments e ON e.id = u.establishment_id
    ${where}
    ORDER BY u.created_at DESC
    LIMIT 500
  `;

  let rows: any[] = [];
  try {
    const result = await pool.query(baseQuery, params);
    rows = result.rows;
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }

  // Enriquece com colunas LGPD opcionais — cada uma em try separado para máxima resiliência
  const ids = rows.map(r => r.id);
  if (!ids.length) return res.json([]);

  // whatsapp_optout + deleted_at + cpf
  try {
    const lgpdRes = await pool.query(
      `SELECT id,
              COALESCE(whatsapp_optout, false) AS whatsapp_optout,
              deleted_at,
              cpf
       FROM users WHERE id = ANY($1)`,
      [ids]
    );
    const lgpdMap: Record<string, any> = {};
    lgpdRes.rows.forEach(r => { lgpdMap[r.id] = r; });
    rows = rows.map(r => ({ ...r, ...( lgpdMap[r.id] || { whatsapp_optout: false, deleted_at: null, cpf: null }) }));
  } catch {
    rows = rows.map(r => ({ ...r, whatsapp_optout: false, deleted_at: null, cpf: null }));
  }

  // consent_logs
  try {
    const clRes = await pool.query(
      `SELECT user_id,
              json_agg(json_build_object('event', event, 'ip', ip, 'version', version, 'created_at', created_at)
                       ORDER BY created_at DESC) AS logs
       FROM consent_logs
       WHERE user_id = ANY($1)
       GROUP BY user_id`,
      [ids.map(String)]
    );
    const clMap: Record<string, any[]> = {};
    clRes.rows.forEach(r => { clMap[r.user_id] = r.logs; });
    rows = rows.map(r => ({ ...r, consent_logs: clMap[String(r.id)] || null }));
  } catch {
    rows = rows.map(r => ({ ...r, consent_logs: null }));
  }

  return res.json(rows);
});

// ─────────────────────────────────────────────────────────────
// PATCH /admin/users/:id — edita conta de usuário pelo superadmin
// ─────────────────────────────────────────────────────────────
router.patch('/users/:id', requireAdmin, async (req, res) => {
  const { full_name, email, whatsapp, cpf, auth_level, is_confirmed } = req.body;
  try {
    const fields: string[] = [];
    const values: any[]   = [];
    let i = 1;

    if (full_name    !== undefined) { fields.push(`full_name    = $${i++}`); values.push(full_name); }
    if (email        !== undefined) { fields.push(`email        = $${i++}`); values.push(email || null); }
    if (cpf          !== undefined) { fields.push(`cpf          = $${i++}`); values.push(cpf || null); }
    if (auth_level   !== undefined) { fields.push(`auth_level   = $${i++}`); values.push(auth_level); }
    if (is_confirmed !== undefined) { fields.push(`is_confirmed = $${i++}`); values.push(Boolean(is_confirmed)); }

    // WhatsApp: verifica duplicidade e salva histórico
    if (whatsapp !== undefined) {
      const newWa = String(whatsapp).replace(/\D/g, '');
      if (newWa) {
        const dup = await pool.query(`SELECT id FROM users WHERE whatsapp=$1 AND id<>$2`, [newWa, req.params.id]);
        if (dup.rows.length) return res.status(409).json({ error: 'WhatsApp já em uso por outra conta.' });

        const cur = await pool.query(`SELECT whatsapp, whatsapp_history FROM users WHERE id=$1`, [req.params.id]);
        if (cur.rows.length && cur.rows[0].whatsapp && cur.rows[0].whatsapp !== newWa) {
          const history: any[] = cur.rows[0].whatsapp_history || [];
          history.push({ whatsapp: cur.rows[0].whatsapp, changed_at: new Date().toISOString(), changed_by: 'admin' });
          fields.push(`whatsapp_history = $${i++}`);
          values.push(JSON.stringify(history));
        }
        fields.push(`whatsapp = $${i++}`);
        values.push(newWa);
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id=$${i} RETURNING id, full_name, email, whatsapp, cpf, auth_level, is_confirmed`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /admin/establishments/:id/suspend
// ─────────────────────────────────────────────────────────────
router.patch('/establishments/:id/suspend', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  try {
    const r = await pool.query(
      `UPDATE establishments
       SET is_suspended = true, suspension_reason = $1, suspended_at = NOW()
       WHERE id = $2 RETURNING id, name`,
      [reason || 'Inadimplência', req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    res.json({ success: true, message: `"${r.rows[0].name}" suspensa.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /admin/establishments/:id/activate
// ─────────────────────────────────────────────────────────────
router.patch('/establishments/:id/activate', requireAdmin, async (req, res) => {
  const { activated_until } = req.body; // ISO date string or null
  try {
    const r = await pool.query(
      `UPDATE establishments
       SET is_suspended = false, suspension_reason = null, suspended_at = null,
           is_active = true, activated_until = $1
       WHERE id = $2 RETURNING id, name`,
      [activated_until || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    res.json({ success: true, message: `"${r.rows[0].name}" ativada.`, activated_until });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/establishments/:id/regenerate-token
// ─────────────────────────────────────────────────────────────
router.post('/establishments/:id/regenerate-token', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE establishments
       SET store_token = encode(gen_random_bytes(16), 'hex')
       WHERE id = $1 RETURNING store_token`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    res.json({ store_token: r.rows[0].store_token });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /admin/establishments/:id
// ─────────────────────────────────────────────────────────────
router.delete('/establishments/:id', requireAdmin, async (req, res) => {
  try {
    // Busca nome antes de deletar
    const check = await pool.query(`SELECT name FROM establishments WHERE id = $1`, [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    const name = check.rows[0].name;

    // Com ON DELETE CASCADE configurado no banco de dados, basta deletar o estabelecimento.
    // O PostgreSQL cuidará de deletar todos os registros relacionados (filhos) automaticamente!
    await pool.query(`DELETE FROM establishments WHERE id = $1`, [req.params.id]);

    res.json({ success: true, message: `"${name}" excluída permanentemente.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/establishments/:id/setup', async (req, res) => {
  const { vertical_slug } = req.body;
  if (!vertical_slug) return res.status(400).json({ error: 'vertical_slug obrigatório.' });

  let bp: ReturnType<typeof getBlueprint>;
  try { bp = getBlueprint(vertical_slug); }
  catch { return res.status(400).json({ error: `Nicho inválido: ${vertical_slug}` }); }

  try {
    await pool.query(
      `UPDATE establishments SET
         vertical_slug=$1, active_features=$2, business_config=$3,
         cor_primaria=$4, cor_destaque=$5, setup_done=true,
         is_public=true, is_active=true, updated_at=NOW()
       WHERE id=$6`,
      [bp.slug, JSON.stringify(bp.features), JSON.stringify(bp.business_config), bp.cor_primaria, bp.cor_destaque, req.params.id]
    );

    await pool.query(`DELETE FROM agenda_servicos WHERE establishment_id=$1`, [req.params.id]);
    for (const s of bp.servicos_padrao) {
      await pool.query(
        `INSERT INTO agenda_servicos (establishment_id, nome, categoria, duracao_minutos, preco, ordem)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, s.nome, s.categoria, s.duracao_minutos, s.preco, s.ordem]
      );
    }

    res.json({ success: true, features: bp.features, servicos: bp.servicos_padrao.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /admin/blueprints — lista nichos (sem auth pesada, só admin key)
// ─────────────────────────────────────────────────────────────
router.get('/blueprints', (_req, res) => {
  res.json(listBlueprints());
});

// ─────────────────────────────────────────────────────────────
// SEGMENTS CRUD
// ─────────────────────────────────────────────────────────────
// GET /admin/segments — lista todos (ativos e inativos), agrupados por módulo
router.get('/segments', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, module_slug, module_label, module_icon, slug, label, descricao, icon,
              cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais,
              business_config, ativo, ordem, plano_1, plano_2, created_at
       FROM segments ORDER BY module_slug, ordem, label`
    );
    // Agrupa por módulo
    const grouped: Record<string, any> = {};
    for (const row of result.rows) {
      if (!grouped[row.module_slug]) {
        grouped[row.module_slug] = {
          module_slug: row.module_slug,
          module_label: row.module_label,
          module_icon: row.module_icon,
          segments: [],
        };
      }
      grouped[row.module_slug].segments.push(row);
    }
    res.json(Object.values(grouped));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/segments — cria segmento
router.post('/segments', async (req, res) => {
  const {
    module_slug, module_label, module_icon,
    slug, label, descricao, icon,
    cor_primaria, cor_destaque,
    features, servicos_padrao, tipos_profissionais, business_config, ordem, plano_1, plano_2
  } = req.body;

  if (!module_slug || !module_label || !slug || !label) {
    return res.status(400).json({ error: 'module_slug, module_label, slug e label são obrigatórios.' });
  }

  try {
    // Valida JSON fields
    const toJson = (v: any) => typeof v === 'string' ? v : JSON.stringify(v ?? []);

    const result = await pool.query(
      `INSERT INTO segments
         (module_slug, module_label, module_icon, slug, label, descricao, icon,
          cor_primaria, cor_destaque, features, servicos_padrao, tipos_profissionais, business_config, ordem, plano_1, plano_2)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        module_slug, module_label, module_icon || '📦',
        slug.toLowerCase().replace(/\s+/g, '_'), label, descricao || null, icon || '⚙️',
        cor_primaria || '#0f172a', cor_destaque || '#6366f1',
        toJson(features), toJson(servicos_padrao), toJson(tipos_profissionais),
        typeof business_config === 'string' ? business_config : JSON.stringify(business_config ?? {}),
        ordem ?? 0,
        toJson(plano_1 || {nome: "Básico", preco: 49.90, trial_days: 15}),
        toJson(plano_2 || {nome: "Pro", preco: 99.90, trial_days: 15})
      ]
    );
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: `Slug "${slug}" já existe.` });
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/segments/:id — atualiza segmento
router.put('/segments/:id', async (req, res) => {
  const {
    module_slug, module_label, module_icon,
    label, descricao, icon, cor_primaria, cor_destaque,
    features, servicos_padrao, tipos_profissionais, business_config, ativo, ordem, plano_1, plano_2
  } = req.body;

  try {
    const toJson = (v: any) => typeof v === 'string' ? v : JSON.stringify(v);

    const result = await pool.query(
      `UPDATE segments SET
         module_slug=$1, module_label=$2, module_icon=$3,
         label=$4, descricao=$5, icon=$6, cor_primaria=$7, cor_destaque=$8,
         features=$9, servicos_padrao=$10, tipos_profissionais=$11, business_config=$12,
         ativo=$13, ordem=$14, plano_1=$15, plano_2=$16, updated_at=NOW()
       WHERE id=$17 RETURNING id`,
      [
        module_slug, module_label, module_icon || '📦',
        label, descricao || null, icon || '⚙️', cor_primaria, cor_destaque,
        toJson(features), toJson(servicos_padrao), toJson(tipos_profissionais),
        typeof business_config === 'string' ? business_config : JSON.stringify(business_config ?? {}),
        ativo ?? true, ordem ?? 0,
        toJson(plano_1 || {nome: "Básico", preco: 49.90, trial_days: 15}),
        toJson(plano_2 || {nome: "Pro", preco: 99.90, trial_days: 15}),
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Segmento não encontrado.' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/segments/:id/toggle — ativa/desativa segmento
router.patch('/segments/:id/toggle', async (req, res) => {
  try {
    const { ativo } = req.body;
    await pool.query(`UPDATE segments SET ativo=$1, updated_at=NOW() WHERE id=$2`, [ativo, req.params.id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/segments/:id — desativa (não apaga)
router.delete('/segments/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE segments SET ativo=false, updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- ANÚNCIOS (GET) ---
router.get('/announcements', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM announcements ORDER BY display_order ASC, created_at DESC');
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- ANÚNCIOS (SAVE / UPSERT) ---
router.post('/announcements/save', async (req, res) => {
  const { id, title, description, image_url, video_url, link_url, is_active, display_order, starts_at, ends_at } = req.body;
  if (!title) return res.status(400).json({ error: 'Título obrigatório.' });

  try {
    if (id) {
      await pool.query(
        `UPDATE announcements SET title=$1, description=$2, image_url=$3, video_url=$4, link_url=$5,
         is_active=$6, display_order=$7, starts_at=$8, ends_at=$9 WHERE id=$10`,
        [title, description, image_url, video_url || null, link_url, is_active ?? true, display_order ?? 0, starts_at || null, ends_at || null, id]
      );
    } else {
      await pool.query(
        `INSERT INTO announcements (title, description, image_url, video_url, link_url, is_active, display_order, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [title, description, image_url, video_url || null, link_url, is_active ?? true, display_order ?? 0, starts_at || null, ends_at || null]
      );
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- ANÚNCIOS (DELETE) ---
router.delete('/announcements/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/agata-avatar — salva avatar da IA no BANCO DE DADOS
// ─────────────────────────────────────────────────────────────
router.post('/agata-avatar', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'Imagem não fornecida.' });
  try {
    // Salva o próprio Data URI (Base64 completo) no banco, para carregar direto no <img>
    await pool.query(
      `INSERT INTO agata_personality (id, photo_url, updated_at) 
       VALUES ('00000000-0000-0000-0000-000000000001', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET photo_url = EXCLUDED.photo_url, updated_at = NOW()`,
      [imageBase64]
    );

    res.json({ success: true, url: imageBase64 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/favicon — salva favicon global no banco e como arquivo
// ─────────────────────────────────────────────────────────────────────────────
router.post('/favicon', requireAdmin, async (req, res) => {
  const { favicon_base64 } = req.body;
  if (!favicon_base64) return res.status(400).json({ error: 'favicon_base64 é obrigatório.' });
  if (favicon_base64.length > 100000) return res.status(413).json({ error: 'Favicon muito grande. Máximo ~64KB.' });

  const clean = (b64: string) => b64.replace(/^data:image\/[^;]+;base64,/, '');

  try {
    await pool.query(
      `INSERT INTO global_settings (key, value, category, updated_at)
       VALUES ('site_favicon', $1, 'BRANDING', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [favicon_base64]
    );
    // Salva como arquivo para servir estaticamente
    const iconsDir = path.join(__dirname, '../../public/icons');
    if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
    fs.writeFileSync(path.join(iconsDir, 'favicon.png'), Buffer.from(clean(favicon_base64), 'base64'));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/favicon — retorna o favicon global atual
router.get('/favicon', requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query(`SELECT value FROM global_settings WHERE key = 'site_favicon'`);
    res.json({ favicon_base64: r.rows[0]?.value || null });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /admin/icons — salva ícones PWA no banco (global_settings) e como arquivo
// ─────────────────────────────────────────────────────────────────────────────
router.post('/icons', async (req, res) => {
  const { icon192, icon512 } = req.body;
  if (!icon192 || !icon512) {
    return res.status(400).json({ error: 'icon192 e icon512 são obrigatórios.' });
  }

  const clean = (b64: string) => b64.replace(/^data:image\/\w+;base64,/, '');

  try {
    // 1. Salva no banco de dados (global_settings)
    const upsert = async (key: string, value: string) => pool.query(
      `INSERT INTO global_settings (key, value, category, updated_at)
       VALUES ($1, $2, 'PWA', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
    await Promise.all([upsert('pwa_icon_192', icon192), upsert('pwa_icon_512', icon512)]);

    // 2. Salva como arquivo (para ser servido pelo express.static)
    const iconsDir = path.join(__dirname, '../../public/icons');
    if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
    fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), Buffer.from(clean(icon192), 'base64'));
    fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), Buffer.from(clean(icon512), 'base64'));

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/seed-demos — Cria lojas demo para todos os segmentos
// ─────────────────────────────────────────────────────────────
router.post('/seed-demos', requireAdmin, async (_req, res) => {
  const PASSWORD = 'Demo@2025';
  const hash = await bcrypt.hash(PASSWORD, 10);

  const DEMOS = [
    {
      estId: 'de000001-0000-0000-0000-000000000001',
      userId: 'de000001-0000-0000-0000-000000000002',
      name: 'Barbearia Estilo (DEMO)', slug: 'barbearia-demo', city: 'São Paulo',
      vertical_slug: 'barbearia', cor_primaria: '#1a1a1a', cor_destaque: '#d4af37',
      active_features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'bloqueios', 'avaliacoes'],
      business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 2, aceita_pagamento_online: false, intervalo_agenda_minutos: 30 },
      settings: { theme: { primary_color: '#d4af37' }, contact: { whatsapp: '11911110001', email: 'demo@barbearia.com' }, business_hours: _bh('08:00','20:00'), is_open: true },
      owner_name: 'Carlos Barbeiro (DEMO)', email: 'demo@barbearia-ag.com', whatsapp: '11911110001',
      servicos: [
        { nome: 'Corte Masculino',     categoria: 'Cabelo',     dur: 30, preco: 45.00, ordem: 1 },
        { nome: 'Barba Completa',      categoria: 'Barba',      dur: 30, preco: 35.00, ordem: 2 },
        { nome: 'Combo Corte + Barba', categoria: 'Combo',      dur: 60, preco: 70.00, ordem: 3 },
        { nome: 'Sobrancelha',         categoria: 'Estética',   dur: 15, preco: 20.00, ordem: 4 },
        { nome: 'Hidratação Capilar',  categoria: 'Tratamento', dur: 30, preco: 30.00, ordem: 5 },
      ],
    },
    {
      estId: 'de000002-0000-0000-0000-000000000001',
      userId: 'de000002-0000-0000-0000-000000000002',
      name: 'Studio Bella Unhas (DEMO)', slug: 'studio-beleza-demo', city: 'Rio de Janeiro',
      vertical_slug: 'studio_beleza', cor_primaria: '#1a0a1a', cor_destaque: '#e91e8c',
      active_features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'comissao', 'bloqueios', 'avaliacoes'],
      business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 2, comissao_padrao_percentual: 40, intervalo_agenda_minutos: 30 },
      settings: { theme: { primary_color: '#e91e8c' }, contact: { whatsapp: '21922220002', email: 'demo@studio.com' }, business_hours: _bh('09:00','19:00'), is_open: true },
      owner_name: 'Ana Studio (DEMO)', email: 'demo@studio-ag.com', whatsapp: '21922220002',
      servicos: [
        { nome: 'Manicure',                categoria: 'Unhas',       dur: 45, preco: 40.00,  ordem: 1 },
        { nome: 'Pedicure',                categoria: 'Unhas',       dur: 60, preco: 50.00,  ordem: 2 },
        { nome: 'Manicure + Pedicure',     categoria: 'Unhas',       dur: 90, preco: 80.00,  ordem: 3 },
        { nome: 'Design de Sobrancelha',   categoria: 'Sobrancelha', dur: 30, preco: 35.00,  ordem: 4 },
        { nome: 'Depilação Perna Inteira', categoria: 'Depilação',   dur: 40, preco: 60.00,  ordem: 5 },
        { nome: 'Maquiagem Social',        categoria: 'Maquiagem',   dur: 60, preco: 120.00, ordem: 6 },
      ],
    },
    {
      estId: 'de000003-0000-0000-0000-000000000001',
      userId: 'de000003-0000-0000-0000-000000000002',
      name: 'Academia Força Total (DEMO)', slug: 'academia-demo', city: 'Curitiba',
      vertical_slug: 'academia', cor_primaria: '#0d1117', cor_destaque: '#f97316',
      active_features: ['agenda', 'profissionais', 'servicos', 'planos', 'checkin', 'vendas', 'avaliacoes'],
      business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 4, taxa_matricula: 99.90, checkin_habilitado: true, intervalo_agenda_minutos: 60 },
      settings: { theme: { primary_color: '#f97316' }, contact: { whatsapp: '41933330003', email: 'demo@academia.com' }, business_hours: { '0': { active: false, start: '08:00', end: '12:00' }, '1': { active: true, start: '06:00', end: '22:00' }, '2': { active: true, start: '06:00', end: '22:00' }, '3': { active: true, start: '06:00', end: '22:00' }, '4': { active: true, start: '06:00', end: '22:00' }, '5': { active: true, start: '06:00', end: '22:00' }, '6': { active: true, start: '08:00', end: '14:00' } }, is_open: true },
      owner_name: 'Roberto Academia (DEMO)', email: 'demo@academia-ag.com', whatsapp: '41933330003',
      servicos: [
        { nome: 'Plano Mensal',      categoria: 'Planos',   dur: 0,  preco: 89.90,  ordem: 1 },
        { nome: 'Plano Trimestral',  categoria: 'Planos',   dur: 0,  preco: 239.90, ordem: 2 },
        { nome: 'Plano Semestral',   categoria: 'Planos',   dur: 0,  preco: 419.90, ordem: 3 },
        { nome: 'Plano Anual',       categoria: 'Planos',   dur: 0,  preco: 779.90, ordem: 4 },
        { nome: 'Avaliação Física',  categoria: 'Serviços', dur: 60, preco: 80.00,  ordem: 5 },
        { nome: 'Personal Trainer',  categoria: 'Serviços', dur: 60, preco: 120.00, ordem: 6 },
      ],
    },
    {
      estId: 'de000004-0000-0000-0000-000000000001',
      userId: 'de000004-0000-0000-0000-000000000002',
      name: 'Personal Trainer Lucas (DEMO)', slug: 'personal-trainer-demo', city: 'Belo Horizonte',
      vertical_slug: 'personal_trainer', cor_primaria: '#0d1117', cor_destaque: '#10b981',
      active_features: ['agenda', 'servicos', 'planos', 'vendas', 'avaliacoes'],
      business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 2, pode_vincular_academia: false, intervalo_agenda_minutos: 60 },
      settings: { theme: { primary_color: '#10b981' }, contact: { whatsapp: '31944440004', email: 'demo@personal.com' }, business_hours: _bh('06:00','21:00'), is_open: true },
      owner_name: 'Lucas Personal (DEMO)', email: 'demo@personal-ag.com', whatsapp: '31944440004',
      servicos: [
        { nome: 'Sessão Personal (1h)',      categoria: 'Sessões',   dur: 60, preco: 120.00, ordem: 1 },
        { nome: 'Plano Mensal 3x/semana',    categoria: 'Planos',    dur: 0,  preco: 480.00, ordem: 2 },
        { nome: 'Plano Mensal 5x/semana',    categoria: 'Planos',    dur: 0,  preco: 700.00, ordem: 3 },
        { nome: 'Avaliação Física Completa', categoria: 'Avaliação', dur: 60, preco: 150.00, ordem: 4 },
        { nome: 'Programa Online Mensal',    categoria: 'Online',    dur: 0,  preco: 200.00, ordem: 5 },
      ],
    },
    {
      estId: 'de000005-0000-0000-0000-000000000001',
      userId: 'de000005-0000-0000-0000-000000000002',
      name: 'Burguer Top Delivery (DEMO)', slug: 'delivery-demo', city: 'Florianópolis',
      vertical_slug: 'delivery', cor_primaria: '#1a0800', cor_destaque: '#f97316',
      active_features: ['cardapio', 'pedidos', 'cozinha', 'vendas'],
      business_config: { aceita_agendamento: false, taxa_entrega_padrao: 5.00, tempo_preparo_minutos: 30, aceita_retirada: true, aceita_entrega: true, pedido_minimo: 25.00 },
      settings: { theme: { primary_color: '#f97316' }, contact: { whatsapp: '48955550005', email: 'demo@delivery.com' }, business_hours: { '0': { active: true, start: '11:00', end: '23:00' }, '1': { active: true, start: '11:00', end: '23:00' }, '2': { active: true, start: '11:00', end: '23:00' }, '3': { active: true, start: '11:00', end: '23:00' }, '4': { active: true, start: '11:00', end: '23:00' }, '5': { active: true, start: '11:00', end: '00:00' }, '6': { active: true, start: '11:00', end: '00:00' } }, is_open: true },
      owner_name: 'Marcos Delivery (DEMO)', email: 'demo@delivery-ag.com', whatsapp: '48955550005',
      servicos: [
        { nome: 'X-Burguer Clássico',           categoria: 'Hambúrgueres',    dur: 0, preco: 22.90, ordem: 1 },
        { nome: 'X-Bacon Duplo',                categoria: 'Hambúrgueres',    dur: 0, preco: 28.90, ordem: 2 },
        { nome: 'Combo Burguer + Batata + Refri',categoria: 'Combos',         dur: 0, preco: 35.90, ordem: 3 },
        { nome: 'Batata Frita Média',            categoria: 'Acompanhamentos', dur: 0, preco: 12.90, ordem: 4 },
        { nome: 'Refrigerante Lata',             categoria: 'Bebidas',         dur: 0, preco: 6.90,  ordem: 5 },
      ],
    },
    {
      estId: 'de000006-0000-0000-0000-000000000001',
      userId: 'de000006-0000-0000-0000-000000000002',
      name: 'RastreoFácil Gestão (DEMO)', slug: 'rastreamento-demo', city: 'Brasília',
      vertical_slug: 'rastreamento', cor_primaria: '#0a0a1a', cor_destaque: '#3b82f6',
      active_features: ['frota', 'frota_clientes', 'cobranca', 'crm', 'vendas'],
      business_config: { aceita_agendamento: false, show_mapa: false, dia_cobranca: 10, campos_veiculo: ['placa', 'modelo', 'ano', 'cor', 'data_instalacao', 'imei_rastreador'] },
      settings: { theme: { primary_color: '#3b82f6' }, contact: { whatsapp: '61966660006', email: 'demo@rastreamento.com' }, business_hours: _bh('08:00','18:00'), is_open: true },
      owner_name: 'Pedro Rastreamento (DEMO)', email: 'demo@rastreamento-ag.com', whatsapp: '61966660006',
      servicos: [
        { nome: 'Mensalidade Básica',       categoria: 'Planos',   dur: 0,  preco: 49.90,  ordem: 1 },
        { nome: 'Mensalidade Premium',      categoria: 'Planos',   dur: 0,  preco: 89.90,  ordem: 2 },
        { nome: 'Instalação do Rastreador', categoria: 'Serviços', dur: 60, preco: 150.00, ordem: 3 },
      ],
    },
    // ── NOVOS SEGMENTOS ──────────────────────────────────────────
    {
      estId: 'de000007-0000-0000-0000-000000000001',
      userId: 'de000007-0000-0000-0000-000000000002',
      name: 'Salão Glamour Hair (DEMO)', slug: 'salao-demo', city: 'Salvador',
      vertical_slug: 'salao', cor_primaria: '#1a0a0a', cor_destaque: '#c084fc',
      active_features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'comissao', 'bloqueios', 'avaliacoes'],
      business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 2, comissao_padrao_percentual: 50, intervalo_agenda_minutos: 30 },
      settings: { theme: { primary_color: '#c084fc' }, contact: { whatsapp: '71977770007', email: 'demo@salao.com' }, business_hours: _bh('09:00','19:00'), is_open: true },
      owner_name: 'Fernanda Glamour (DEMO)', email: 'demo@salao-ag.com', whatsapp: '71977770007',
      servicos: [
        { nome: 'Corte Feminino',         categoria: 'Cabelo',     dur: 45,  preco: 60.00,  ordem: 1 },
        { nome: 'Escova Progressiva',     categoria: 'Tratamento', dur: 120, preco: 200.00, ordem: 2 },
        { nome: 'Coloração Completa',     categoria: 'Coloração',  dur: 90,  preco: 150.00, ordem: 3 },
        { nome: 'Mechas / Luzes',         categoria: 'Coloração',  dur: 120, preco: 250.00, ordem: 4 },
        { nome: 'Hidratação Profunda',    categoria: 'Tratamento', dur: 60,  preco: 80.00,  ordem: 5 },
        { nome: 'Escova Modeladora',      categoria: 'Cabelo',     dur: 60,  preco: 70.00,  ordem: 6 },
        { nome: 'Cauterização',           categoria: 'Tratamento', dur: 90,  preco: 130.00, ordem: 7 },
        { nome: 'Corte Infantil',         categoria: 'Cabelo',     dur: 30,  preco: 40.00,  ordem: 8 },
      ],
      produtos: [
        { nome: 'Shampoo Liso Intenso 300ml',     categoria: 'Produtos',  preco: 45.00,  ordem: 1 },
        { nome: 'Condicionador Hidra Sedoso 300ml',categoria: 'Produtos', preco: 40.00,  ordem: 2 },
        { nome: 'Máscara Nutrição Intensa 250g',   categoria: 'Produtos', preco: 65.00,  ordem: 3 },
        { nome: 'Óleo de Argan 30ml',              categoria: 'Produtos', preco: 55.00,  ordem: 4 },
      ],
    },
    {
      estId: 'de000008-0000-0000-0000-000000000001',
      userId: 'de000008-0000-0000-0000-000000000002',
      name: 'Clínica Saúde Plena (DEMO)', slug: 'clinica-demo', city: 'Porto Alegre',
      vertical_slug: 'clinica', cor_primaria: '#030f1a', cor_destaque: '#0ea5e9',
      active_features: ['agenda', 'profissionais', 'servicos', 'vendas', 'bloqueios', 'avaliacoes'],
      business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 24, intervalo_agenda_minutos: 60, confirmar_antes: true },
      settings: { theme: { primary_color: '#0ea5e9' }, contact: { whatsapp: '51988880008', email: 'demo@clinica.com' }, business_hours: { '0': { active: false, start: '08:00', end: '18:00' }, '1': { active: true, start: '08:00', end: '18:00' }, '2': { active: true, start: '08:00', end: '18:00' }, '3': { active: true, start: '08:00', end: '18:00' }, '4': { active: true, start: '08:00', end: '18:00' }, '5': { active: true, start: '08:00', end: '18:00' }, '6': { active: true, start: '08:00', end: '12:00' } }, is_open: true },
      owner_name: 'Dra. Paula Saúde (DEMO)', email: 'demo@clinica-ag.com', whatsapp: '51988880008',
      servicos: [
        { nome: 'Consulta Inicial',        categoria: 'Consulta',     dur: 60, preco: 200.00, ordem: 1 },
        { nome: 'Retorno',                 categoria: 'Consulta',     dur: 30, preco: 100.00, ordem: 2 },
        { nome: 'Sessão de Psicologia',    categoria: 'Psicologia',   dur: 50, preco: 180.00, ordem: 3 },
        { nome: 'Consulta Nutricional',    categoria: 'Nutrição',     dur: 60, preco: 160.00, ordem: 4 },
        { nome: 'Sessão de Fisioterapia',  categoria: 'Fisioterapia', dur: 50, preco: 130.00, ordem: 5 },
        { nome: 'Avaliação Postural',      categoria: 'Fisioterapia', dur: 60, preco: 150.00, ordem: 6 },
      ],
      produtos: [],
    },
    {
      estId: 'de000009-0000-0000-0000-000000000001',
      userId: 'de000009-0000-0000-0000-000000000002',
      name: 'PetLove Banho & Tosa (DEMO)', slug: 'petshop-demo', city: 'Recife',
      vertical_slug: 'petshop', cor_primaria: '#051a0f', cor_destaque: '#22c55e',
      active_features: ['agenda', 'profissionais', 'servicos', 'produtos', 'vendas', 'bloqueios', 'avaliacoes'],
      business_config: { aceita_agendamento: true, permite_cancelamento: true, horas_antecedencia_cancelamento: 2, intervalo_agenda_minutos: 30 },
      settings: { theme: { primary_color: '#22c55e' }, contact: { whatsapp: '81999990009', email: 'demo@petshop.com' }, business_hours: _bh('08:00','18:00'), is_open: true },
      owner_name: 'Juliana Pets (DEMO)', email: 'demo@petshop-ag.com', whatsapp: '81999990009',
      servicos: [
        { nome: 'Banho Pequeno Porte',    categoria: 'Banho & Tosa', dur: 60,  preco: 55.00,  ordem: 1 },
        { nome: 'Banho Médio Porte',      categoria: 'Banho & Tosa', dur: 90,  preco: 75.00,  ordem: 2 },
        { nome: 'Banho Grande Porte',     categoria: 'Banho & Tosa', dur: 120, preco: 110.00, ordem: 3 },
        { nome: 'Tosa Higiênica',         categoria: 'Banho & Tosa', dur: 30,  preco: 40.00,  ordem: 4 },
        { nome: 'Tosa Completa',          categoria: 'Banho & Tosa', dur: 60,  preco: 80.00,  ordem: 5 },
        { nome: 'Banho + Tosa Completa',  categoria: 'Banho & Tosa', dur: 120, preco: 130.00, ordem: 6 },
        { nome: 'Consulta Veterinária',   categoria: 'Veterinária',  dur: 30,  preco: 150.00, ordem: 7 },
        { nome: 'Vacina Anual',           categoria: 'Veterinária',  dur: 15,  preco: 120.00, ordem: 8 },
        { nome: 'Hotel Pet (diária)',     categoria: 'Hotel',        dur: 0,   preco: 80.00,  ordem: 9 },
      ],
      produtos: [
        { nome: 'Ração Premium Cão 1kg',     categoria: 'Alimentação', preco: 38.00, ordem: 1 },
        { nome: 'Ração Premium Gato 1kg',    categoria: 'Alimentação', preco: 35.00, ordem: 2 },
        { nome: 'Shampoo Antipulgas 500ml',  categoria: 'Higiene',     preco: 28.00, ordem: 3 },
        { nome: 'Coleira Antipulgas Cão',    categoria: 'Saúde',       preco: 45.00, ordem: 4 },
        { nome: 'Brinquedo Mordedor',        categoria: 'Acessórios',  preco: 22.00, ordem: 5 },
      ],
    },
  ];

  function _bh(start: string, end: string) {
    const h: Record<string, any> = {};
    for (let d = 0; d <= 6; d++) {
      h[String(d)] = d === 0
        ? { active: false, start, end }
        : d === 6
          ? { active: true, start, end: '13:00' }
          : { active: true, start, end };
    }
    return h;
  }

  try {
    const created: string[] = [];

    for (const demo of DEMOS as any[]) {
      // Remove qualquer establishment com o mesmo slug mas ID diferente (evita unique constraint)
      await pool.query(
        `DELETE FROM establishments WHERE slug = $1 AND id != $2`,
        [demo.slug, demo.estId]
      );

      // Establishment (upsert por ID)
      await pool.query(`
        INSERT INTO establishments (
          id, name, slug, city, vertical_slug, setup_done, is_active, is_public,
          active_features, business_config, cor_primaria, cor_destaque,
          settings, niche_data, whatsapp_link, description,
          is_suspended, suspension_reason, activated_until
        ) VALUES ($1,$2,$3,$4,$5,true,true,true,$6,$7,$8,$9,$10,'{}', $11,$12,false,null,null)
        ON CONFLICT (id) DO UPDATE SET
          name             = EXCLUDED.name,
          slug             = EXCLUDED.slug,
          vertical_slug    = EXCLUDED.vertical_slug,
          active_features  = EXCLUDED.active_features,
          business_config  = EXCLUDED.business_config,
          cor_primaria     = EXCLUDED.cor_primaria,
          cor_destaque     = EXCLUDED.cor_destaque,
          settings         = EXCLUDED.settings,
          is_active        = true,
          is_public        = true,
          setup_done       = true,
          is_suspended     = false,
          suspension_reason= null,
          activated_until  = null
      `, [
        demo.estId, demo.name, demo.slug, demo.city, demo.vertical_slug,
        JSON.stringify(demo.active_features), JSON.stringify(demo.business_config),
        demo.cor_primaria, demo.cor_destaque, JSON.stringify(demo.settings),
        demo.settings.contact.whatsapp,
        `Loja demo — segmento ${demo.vertical_slug}.`,
      ]);

      // Usuário
      await pool.query(`
        INSERT INTO users (id, full_name, whatsapp, email, password_hash, auth_level, establishment_id, is_confirmed)
        VALUES ($1,$2,$3,$4,$5,'LOJISTA',$6,true)
        ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, email = EXCLUDED.email
      `, [demo.userId, demo.owner_name, demo.whatsapp, demo.email, hash, demo.estId]);

      // Serviços
      await pool.query(`DELETE FROM agenda_servicos WHERE establishment_id = $1`, [demo.estId]);
      for (const s of demo.servicos) {
        await pool.query(
          `INSERT INTO agenda_servicos (establishment_id, nome, categoria, duracao_minutos, preco, ordem) VALUES ($1,$2,$3,$4,$5,$6)`,
          [demo.estId, s.nome, s.categoria, s.dur, s.preco, s.ordem]
        );
      }

      // Produtos no catálogo (catalog_items / products)
      if (demo.produtos?.length) {
        await pool.query(`DELETE FROM catalog_items WHERE establishment_id = $1 AND type = 'product'`, [demo.estId]);
        for (const p of demo.produtos) {
          await pool.query(
            `INSERT INTO catalog_items (establishment_id, name, category, price, type, is_active, sort_order)
             VALUES ($1,$2,$3,$4,'product',true,$5)`,
            [demo.estId, p.nome, p.categoria, p.preco, p.ordem]
          );
        }
      }

      created.push(demo.slug);
    }

    res.json({
      success: true,
      message: `${DEMOS.length} lojas demo criadas/atualizadas.`,
      senha_demo: PASSWORD,
      lojas: DEMOS.map((d: any) => ({
        segmento: d.vertical_slug,
        nome:     d.name,
        slug:     d.slug,
        email:    d.email,
        whatsapp: d.whatsapp,
        senha:    PASSWORD,
        vitrine:  `/${d.slug}`,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /admin/seed-clients — Cria clientes de teste + agendamentos
// Depende que seed-demos já tenha sido executado
// ─────────────────────────────────────────────────────────────
router.post('/seed-clients', requireAdmin, async (_req, res) => {
  const PASSWORD = 'Cliente@2025';
  const hash = await bcrypt.hash(PASSWORD, 10);

  // UUIDs fixos para idempotência
  const CLIENTS = [
    { id: 'cl000001-0000-0000-0000-000000000001', full_name: 'João Silva (TESTE)',    whatsapp: '11911000101', email: 'joao@teste-ag.com' },
    { id: 'cl000002-0000-0000-0000-000000000002', full_name: 'Maria Souza (TESTE)',   whatsapp: '11922000202', email: 'maria@teste-ag.com' },
    { id: 'cl000003-0000-0000-0000-000000000003', full_name: 'Pedro Costa (TESTE)',   whatsapp: '21933000303', email: 'pedro@teste-ag.com' },
    { id: 'cl000004-0000-0000-0000-000000000004', full_name: 'Ana Lima (TESTE)',      whatsapp: '31944000404', email: 'ana@teste-ag.com' },
    { id: 'cl000005-0000-0000-0000-000000000005', full_name: 'Carlos Rocha (TESTE)',  whatsapp: '41955000505', email: 'carlos@teste-ag.com' },
  ];

  // Lojas demo com agendamentos (precisam existir via seed-demos)
  const AGENDAMENTOS = [
    // Barbearia
    { est: 'de000001-0000-0000-0000-000000000001', client: 'cl000001-0000-0000-0000-000000000001', tel: '11911000101', service: 'Corte Masculino',     dias: -1, hora: '09:00', status: 'confirmado' },
    { est: 'de000001-0000-0000-0000-000000000001', client: 'cl000003-0000-0000-0000-000000000003', tel: '21933000303', service: 'Combo Corte + Barba', dias:  1, hora: '10:00', status: 'pendente'   },
    { est: 'de000001-0000-0000-0000-000000000001', client: 'cl000005-0000-0000-0000-000000000005', tel: '41955000505', service: 'Barba Completa',       dias:  2, hora: '14:00', status: 'pendente'   },
    // Studio Beleza
    { est: 'de000002-0000-0000-0000-000000000001', client: 'cl000002-0000-0000-0000-000000000002', tel: '11922000202', service: 'Manicure + Pedicure', dias: -2, hora: '10:00', status: 'confirmado' },
    { est: 'de000002-0000-0000-0000-000000000001', client: 'cl000004-0000-0000-0000-000000000004', tel: '31944000404', service: 'Maquiagem Social',     dias:  3, hora: '15:00', status: 'pendente'   },
    // Academia
    { est: 'de000003-0000-0000-0000-000000000001', client: 'cl000001-0000-0000-0000-000000000001', tel: '11911000101', service: 'Avaliação Física',    dias: -3, hora: '08:00', status: 'confirmado' },
    { est: 'de000003-0000-0000-0000-000000000001', client: 'cl000005-0000-0000-0000-000000000005', tel: '41955000505', service: 'Personal Trainer',     dias:  1, hora: '07:00', status: 'confirmado' },
    // Personal Trainer
    { est: 'de000004-0000-0000-0000-000000000001', client: 'cl000003-0000-0000-0000-000000000003', tel: '21933000303', service: 'Sessão Personal (1h)', dias:  0, hora: '18:00', status: 'confirmado' },
    // Salão
    { est: 'de000007-0000-0000-0000-000000000001', client: 'cl000002-0000-0000-0000-000000000002', tel: '11922000202', service: 'Escova Progressiva',  dias:  2, hora: '09:00', status: 'pendente'   },
    { est: 'de000007-0000-0000-0000-000000000001', client: 'cl000004-0000-0000-0000-000000000004', tel: '31944000404', service: 'Coloração Completa',   dias: -1, hora: '14:00', status: 'confirmado' },
    // Clínica
    { est: 'de000008-0000-0000-0000-000000000001', client: 'cl000001-0000-0000-0000-000000000001', tel: '11911000101', service: 'Consulta Inicial',     dias:  4, hora: '10:00', status: 'pendente'   },
    { est: 'de000008-0000-0000-0000-000000000001', client: 'cl000003-0000-0000-0000-000000000003', tel: '21933000303', service: 'Sessão de Psicologia',  dias: -2, hora: '16:00', status: 'confirmado' },
    // Pet Shop
    { est: 'de000009-0000-0000-0000-000000000001', client: 'cl000002-0000-0000-0000-000000000002', tel: '11922000202', service: 'Banho + Tosa Completa',dias:  1, hora: '09:00', status: 'confirmado' },
    { est: 'de000009-0000-0000-0000-000000000001', client: 'cl000005-0000-0000-0000-000000000005', tel: '41955000505', service: 'Consulta Veterinária',  dias: -1, hora: '11:00', status: 'confirmado' },
  ];

  try {
    // Cria clientes
    for (const c of CLIENTS) {
      await pool.query(`
        INSERT INTO users (id, full_name, whatsapp, email, password_hash, auth_level, is_confirmed)
        VALUES ($1,$2,$3,$4,$5,'CLIENT',true)
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email
      `, [c.id, c.full_name, c.whatsapp, c.email, hash]);
    }

    // Cria agendamentos (idempotente por combinação est+client+data+hora)
    let agCriados = 0;
    for (const ag of AGENDAMENTOS) {
      // Busca serviço para pegar duração
      const svcRes = await pool.query(
        `SELECT duracao_minutos FROM agenda_servicos
         WHERE establishment_id = $1 AND nome = $2 AND ativo = true LIMIT 1`,
        [ag.est, ag.service]
      );
      const dur = svcRes.rows[0]?.duracao_minutos ?? 60;

      const data = new Date();
      data.setDate(data.getDate() + ag.dias);
      const dataStr = data.toISOString().split('T')[0];

      const [hh, mm] = ag.hora.split(':').map(Number);
      const fimDate = new Date(`2000-01-01T${ag.hora}:00`);
      fimDate.setMinutes(fimDate.getMinutes() + dur);
      const horaFim = `${String(fimDate.getHours()).padStart(2,'0')}:${String(fimDate.getMinutes()).padStart(2,'0')}`;

      await pool.query(`
        INSERT INTO agenda_agendamentos
          (establishment_id, user_id, cliente_nome, cliente_telefone,
           service_name, data, hora_inicio, hora_fim, duracao_minutos, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT DO NOTHING
      `, [
        ag.est, ag.client,
        CLIENTS.find(c => c.id === ag.client)?.full_name ?? '',
        ag.tel,
        ag.service, dataStr, ag.hora, horaFim, dur, ag.status,
      ]);
      agCriados++;
    }

    res.json({
      success: true,
      message: `${CLIENTS.length} clientes e ${agCriados} agendamentos criados/atualizados.`,
      senha_clientes: PASSWORD,
      clientes: CLIENTS.map(c => ({
        nome:     c.full_name,
        email:    c.email,
        whatsapp: c.whatsapp,
        senha:    PASSWORD,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;