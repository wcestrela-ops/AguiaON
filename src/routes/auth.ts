import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import pool from '../shared/db';
import { PostgresRateLimitStore } from '../shared/rateLimitStore';
import { requireAuth, TokenPayload, UserRole } from '../shared/authMiddleware';
import { sendOtp, verifyOtp } from '../shared/otp_service';
import { logActivity } from '../shared/activityLogger';

const router = Router();

// ── Migração LGPD (executa uma vez na inicialização) ─────────
(async () => {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consent_logs (
        id         SERIAL PRIMARY KEY,
        user_id    TEXT        NOT NULL,
        event      TEXT        NOT NULL,  -- 'REGISTER', 'CHECKOUT', 'REVOKE'
        ip         TEXT,
        user_agent TEXT,
        version    TEXT        NOT NULL DEFAULT '1.0',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_consent_logs_user ON consent_logs(user_id)`);
  } catch (e: any) {
    console.error('[LGPD migration]', e.message);
  }
})();

// ── Rate limiting para endpoints sensíveis ───────────────────
// Usa PostgreSQL como store para funcionar corretamente com cluster
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Máximo 5 tentativas por IP
  message: { error: 'Muitas tentativas. Tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore(),
});

// ── Detecta se o identificador é WhatsApp ou e-mail ──────────
function parseIdentifier(raw: string): { wa: string; email: string } {
  const trimmed = raw.trim();
  const looksLikePhone = /^[\d\s\(\)\-\+]+$/.test(trimmed) && trimmed.replace(/\D/g, '').length >= 8;
  if (looksLikePhone) return { wa: trimmed.replace(/\D/g, ''), email: '' };
  return { wa: '', email: trimmed.toLowerCase() };
}

// ── Encontra o usuário/estabelecimento pelo identificador ─────
interface EntityResult {
  type: 'SUPERADMIN' | 'LOJISTA' | 'CLIENT';
  id: string;
  whatsapp: string | null;
  email: string | null;
  password_hash: string | null;
  is_confirmed?: boolean;
  establishment_id?: string | null;
  [key: string]: any;
}

async function findEntity(identifier: string): Promise<EntityResult | null> {
  const { wa, email } = parseIdentifier(identifier);

  // 1. SuperAdmin (identificado pelo WA OU pelo e-mail do .env — qualquer um
  // dos dois serve pra logar/recuperar senha, já que sendOtp() dispara pelos
  // dois canais em paralelo mesmo assim; ter as duas portas de entrada evita
  // ficar refém de um canal só se ele estiver fora do ar ou mal configurado)
  const adminWa = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const matchesWa = Boolean(adminWa && wa && wa === adminWa);
  const matchesEmail = Boolean(adminEmail && email && email === adminEmail);
  if (matchesWa || matchesEmail) {
    // Busca hash da senha se existir
    const hashResult = await pool.query("SELECT value FROM global_settings WHERE key = 'superadmin_password_hash'");
    const password_hash = hashResult.rows[0]?.value || null;
    return {
      type: 'SUPERADMIN',
      id: 'superadmin',
      whatsapp: adminWa || null,
      email: process.env.ADMIN_EMAIL || null,
      password_hash,
    };
  }

  const key = wa || email;
  if (!key) return null;

  // 2. Estabelecimento (lojista)
  const estQ = wa
    ? 'SELECT * FROM establishments WHERE owner_whatsapp = $1 AND is_active = true LIMIT 1'
    : 'SELECT * FROM establishments WHERE lower(owner_email) = $1 AND is_active = true LIMIT 1';
  const estResult = await pool.query(estQ, [key]);
  if (estResult.rows.length > 0) {
    const e = estResult.rows[0];
    return { type: 'LOJISTA', ...e, whatsapp: e.owner_whatsapp, email: e.owner_email };
  }

  // 3. Usuário (cliente final)
  const userQ = wa
    ? 'SELECT * FROM users WHERE whatsapp = $1 LIMIT 1'
    : 'SELECT * FROM users WHERE lower(email) = $1 LIMIT 1';
  const userResult = await pool.query(userQ, [key]);
  if (userResult.rows.length > 0) {
    return { type: 'CLIENT', ...userResult.rows[0] };
  }

  return null;
}

// ── Seta cookie SSO compartilhado entre subdomínios ──────────
function setAuthCookie(res: any, token: string, role: string) {
  const domain = process.env.COOKIE_DOMAIN;   // ex: ".ag-on.com"
  const maxAge = role === 'CLIENT'
    ? 7 * 24 * 60 * 60 * 1000   // 7 dias
    : 12 * 60 * 60 * 1000;       // 12 horas

  const options: Record<string, any> = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge,
  };
  if (domain) options.domain = domain;

  res.cookie('auth_token', token, options);
}

// ── Emite JWT conforme o tipo de entidade ─────────────────────
function issueToken(entity: EntityResult): string {
  const secret = process.env.JWT_SECRET!;
  const role = entity.type as UserRole;
  const expiresIn = role === 'CLIENT' ? '7d' : '12h';

  const jwtOpts = { expiresIn: expiresIn as any, algorithm: 'HS256' as const };

  if (role === 'SUPERADMIN') {
    return jwt.sign(
      { userId: 'superadmin', whatsapp: entity.whatsapp, role, establishmentId: null },
      secret, jwtOpts
    );
  }
  if (role === 'LOJISTA') {
    return jwt.sign(
      { userId: entity.id, whatsapp: entity.whatsapp, role, establishmentId: entity.id },
      secret, jwtOpts
    );
  }
  // CLIENT
  return jwt.sign(
    { userId: entity.id, whatsapp: entity.whatsapp, role, establishmentId: entity.establishment_id || null },
    secret, jwtOpts
  );
}

// ─────────────────────────────────────────────────────────────
// POST /auth/login
// Login com identificador (WA ou email) + senha
// SuperAdmin: se senha cadastrada, usa senha; senão, OTP
// ─────────────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Identificador obrigatório.' });

  try {
    const entity = await findEntity(identifier);
    if (!entity) return res.status(401).json({ error: 'Credenciais inválidas.' });

    // SuperAdmin: se tem senha cadastrada e senha fornecida, verifica; senão, OTP
    if (entity.type === 'SUPERADMIN') {
      if (entity.password_hash && password) {
        const valid = await bcrypt.compare(String(password), entity.password_hash);
        if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' });
        const token = issueToken(entity);
        setAuthCookie(res, token, entity.type);
        return res.json({ token, role: entity.type, redirect: '/admin-panel' });
      } else {
        const result = await sendOtp('superadmin', entity.whatsapp || '', entity.email, 'LOGIN');
        return res.json({ requireOtp: true, role: 'SUPERADMIN', channels: result.channels });
      }
    }

    // Primeiro acesso: sem senha definida
    if (!entity.password_hash) {
      return res.status(403).json({
        error: 'FIRST_ACCESS',
        message: 'Senha não definida. Use "Esqueci minha senha" para criar sua senha.',
      });
    }

    if (!password) return res.status(400).json({ error: 'Senha obrigatória.' });

    const valid = await bcrypt.compare(String(password), entity.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' });

    // Cliente não confirmado
    if (entity.type === 'CLIENT' && entity.is_confirmed === false) {
      return res.status(403).json({
        error: 'UNCONFIRMED',
        message: 'Conta não confirmada. Verifique o código enviado no cadastro.',
      });
    }

    const token = issueToken(entity);
    setAuthCookie(res, token, entity.type);

    // Log de login para lojistas (não loga todo cliente para não poluir)
    if (entity.type === 'LOJISTA') {
      logActivity({
        type: 'LOJISTA_LOGIN',
        actor_role: 'LOJISTA',
        actor_id: entity.id,
        actor_name: entity.name || entity.email || entity.whatsapp,
        establishment_id: entity.id,
        establishment_name: entity.name,
        description: `Lojista "${entity.name || entity.owner_email}" fez login`,
      });
    }

    return res.json({ token, role: entity.type, redirect: '/portal' });

  } catch (err: any) {
    console.error('❌ Erro no login:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar login.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/login/verify
// Valida OTP do SuperAdmin e emite JWT
// ─────────────────────────────────────────────────────────────
router.post('/login/verify', authLimiter, async (req, res) => {
  const { identifier, code } = req.body;
  if (!identifier || !code) return res.status(400).json({ error: 'Identificador e código obrigatórios.' });

  const { wa, email } = parseIdentifier(identifier);
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET não configurado.' });

  try {
    // Aceita identificar-se tanto pelo WhatsApp quanto pelo e-mail do
    // SuperAdmin — mesmo critério de findEntity(), pra quem pediu o código
    // digitando o e-mail (ex: WhatsApp fora do ar) conseguir confirmar aqui.
    const adminWa = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const matchesWa = Boolean(adminWa && wa && wa === adminWa);
    const matchesEmail = Boolean(adminEmail && email && email === adminEmail);
    if (!matchesWa && !matchesEmail) {
      return res.status(403).json({ error: 'OTP apenas para SuperAdmin.' });
    }

    const valid = await verifyOtp('superadmin', code, 'LOGIN');
    if (!valid) return res.status(401).json({ error: 'Código inválido ou expirado.' });

    const token = jwt.sign(
      { userId: 'superadmin', whatsapp: adminWa || null, role: 'SUPERADMIN' as UserRole, establishmentId: null },
      secret, { expiresIn: '12h' }
    );
    setAuthCookie(res, token, 'SUPERADMIN');
    return res.json({ token, role: 'SUPERADMIN', redirect: '/portal' });

  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro na verificação.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/forgot-password
// Envia OTP de redefinição de senha para WA e/ou email
// ─────────────────────────────────────────────────────────────
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Identificador obrigatório.' });

  try {
    const entity = await findEntity(identifier);

    // Sempre responde OK por segurança (não revela se o usuário existe)
    if (!entity) {
      return res.json({ sent: true, channels: [] });
    }

    // SuperAdmin também pode definir/redefinir senha (antes era bloqueado
    // aqui, o que deixava o único caminho de acesso sendo OTP a cada login,
    // sem nenhuma forma de recuperação se o WhatsApp/e-mail configurado
    // mudasse). sendOtp já dispara pelos dois canais em paralelo (e-mail e
    // WhatsApp) — se um falhar, o outro ainda funciona.
    const otpUserId = entity.type === 'SUPERADMIN' ? 'superadmin' : entity.id;
    // Fix de produção 27 — o envio por WhatsApp precisa saber de qual
    // estabelecimento (pra resolver a instância certa da Evolution/API
    // custom do lojista): LOJISTA é o próprio establishment (entity.id),
    // CLIENT carrega o establishment_id de quem o cadastrou (pode ser nulo
    // pra cadastro genérico sem loja), SUPERADMIN não tem loja nenhuma.
    const estId = entity.type === 'LOJISTA' ? entity.id
      : entity.type === 'CLIENT' ? (entity.establishment_id || null)
      : null;
    const result = await sendOtp(otpUserId, entity.whatsapp || '', entity.email, 'PASSWORD_RESET', estId);
    return res.json({ sent: true, channels: result.channels });

  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao enviar código.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/reset-password
// Verifica OTP + define nova senha → faz login automático
// ─────────────────────────────────────────────────────────────
router.post('/reset-password', authLimiter, async (req, res) => {
  const { identifier, code, newPassword } = req.body;
  if (!identifier || !code || !newPassword) {
    return res.status(400).json({ error: 'Identificador, código e nova senha são obrigatórios.' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    const entity = await findEntity(identifier);
    if (!entity) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    // OTP do SuperAdmin é sempre salvo sob o actor_id 'superadmin' (ver sendOtp
    // em /login e /forgot-password acima), diferente de LOJISTA/CLIENT que usam
    // o próprio entity.id.
    const otpUserId = entity.type === 'SUPERADMIN' ? 'superadmin' : entity.id;
    const valid = await verifyOtp(otpUserId, code, 'PASSWORD_RESET');
    if (!valid) return res.status(401).json({ error: 'Código inválido ou expirado.' });

    const hash = await bcrypt.hash(String(newPassword), 10);

    if (entity.type === 'SUPERADMIN') {
      await pool.query(
        `INSERT INTO global_settings (key, value, category) VALUES ('superadmin_password_hash', $1, 'GENERAL')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [hash]
      );
    } else if (entity.type === 'LOJISTA') {
      await pool.query('UPDATE establishments SET password_hash = $1 WHERE id = $2', [hash, entity.id]);
    } else {
      await pool.query(
        'UPDATE users SET password_hash = $1, is_confirmed = true WHERE id = $2',
        [hash, entity.id]
      );
    }

    // Login automático após redefinição
    const token = issueToken(entity);
    setAuthCookie(res, token, entity.type);
    const redirect = entity.type === 'SUPERADMIN' ? '/admin-panel' : '/portal';
    return res.json({ success: true, token, role: entity.type, redirect });

  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao redefinir senha.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/register
// Cadastra novo cliente com WA + email (ambos opcionais, mas ao menos um)
// Depois pode fazer login com qualquer um dos dois + senha
// ─────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { whatsapp, email, full_name, password } = req.body;

  const wa    = whatsapp ? String(whatsapp).replace(/\D/g, '') : '';
  const mail  = email    ? String(email).trim().toLowerCase()  : '';

  if (!wa && !mail) {
    return res.status(400).json({ error: 'Informe ao menos WhatsApp ou e-mail.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Senha obrigatória.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    // Verifica duplicidade de WA
    if (wa) {
      const dup = await pool.query('SELECT id FROM users WHERE whatsapp = $1 LIMIT 1', [wa]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'Este WhatsApp já possui cadastro. Faça login.' });
      }
    }
    // Verifica duplicidade de e-mail
    if (mail) {
      const dup = await pool.query('SELECT id FROM users WHERE lower(email) = $1 LIMIT 1', [mail]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'Este e-mail já possui cadastro. Faça login.' });
      }
    }

    const hash = await bcrypt.hash(String(password), 10);
    const result = await pool.query(
      `INSERT INTO users (whatsapp, email, full_name, auth_level, password_hash, is_confirmed)
       VALUES ($1, $2, $3, 'REGISTERED', $4, false)
       RETURNING id, whatsapp, email`,
      [wa || null, mail || null, full_name?.trim() || null, hash]
    );

    const user = result.rows[0];
    const sendResult = await sendOtp(user.id, wa, mail || null, 'CONFIRM_ACCOUNT');

    logActivity({
      type: 'USER_REGISTER',
      actor_role: 'CLIENT',
      actor_id: String(user.id),
      actor_name: full_name?.trim() || wa || mail || 'Novo usuário',
      description: `Novo usuário cadastrado: ${full_name?.trim() || wa || mail}`,
      metadata: { whatsapp: wa || null, email: mail || null },
    });

    return res.status(201).json({ sent: true, channels: sendResult.channels, user_id: user.id });

  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao criar conta.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/confirm-account
// Verifica OTP do cadastro → confirma conta → login automático
// ─────────────────────────────────────────────────────────────
router.post('/confirm-account', async (req, res) => {
  const { identifier, code } = req.body;
  if (!identifier || !code) return res.status(400).json({ error: 'Identificador e código obrigatórios.' });

  const { wa, email } = parseIdentifier(identifier);
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET não configurado.' });

  try {
    // Busca por WA ou email — o cliente pode ter informado qualquer um
    let userResult = wa
      ? await pool.query('SELECT * FROM users WHERE whatsapp = $1 LIMIT 1', [wa])
      : await pool.query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
    // Fallback: tenta o outro campo se não achou
    if (!userResult.rows.length && wa && email) {
      userResult = await pool.query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [email]);
    }
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const user = userResult.rows[0];
    const valid = await verifyOtp(user.id, code, 'CONFIRM_ACCOUNT');
    if (!valid) return res.status(401).json({ error: 'Código inválido ou expirado.' });

    await pool.query(
      "UPDATE users SET is_confirmed = true, auth_level = 'REGISTERED' WHERE id = $1",
      [user.id]
    );

    const token = jwt.sign(
      { userId: user.id, whatsapp: user.whatsapp, role: 'CLIENT' as UserRole, establishmentId: null },
      secret, { expiresIn: '7d' }
    );
    setAuthCookie(res, token, 'CLIENT');
    return res.json({ token, role: 'CLIENT', redirect: '/portal' });

  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao confirmar conta.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/staff-login
// Login do funcionário (entregador/garçom/etc.) por WhatsApp
// Não exige senha — o lojista já cadastrou o número no painel
// ─────────────────────────────────────────────────────────────
router.post('/staff-login', authLimiter, async (req, res) => {
  const { phone, establishment_id } = req.body;
  if (!phone || !establishment_id) {
    return res.status(400).json({ error: 'Celular e establishment_id obrigatórios.' });
  }

  const wa = String(phone).replace(/\D/g, '');
  if (!wa) return res.status(400).json({ error: 'Número de celular inválido.' });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET não configurado.' });

  try {
    // Resolve establishment_id — aceita UUID ou slug
    const estRes = await pool.query(
      `SELECT id FROM establishments WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [establishment_id]
    );
    if (!estRes.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    const resolvedEstId = estRes.rows[0].id;

    // Busca usuário pelo WhatsApp
    const userRes = await pool.query(
      `SELECT id, full_name, whatsapp FROM users WHERE whatsapp = $1 LIMIT 1`,
      [wa]
    );
    if (!userRes.rows.length) {
      return res.status(401).json({ error: 'Acesso não autorizado. Verifique seu número e o link utilizado.' });
    }

    const user = userRes.rows[0];

    // Verifica se é membro ativo desse estabelecimento
    const memberRes = await pool.query(
      `SELECT em.id, em.member_role, em.member_roles, e.name AS store_name
       FROM establishment_members em
       JOIN establishments e ON e.id = em.establishment_id
       WHERE em.user_id = $1 AND em.establishment_id = $2 AND em.is_active = true
       LIMIT 1`,
      [user.id, resolvedEstId]
    );
    if (!memberRes.rows.length) {
      return res.status(401).json({ error: 'Acesso não autorizado. Verifique seu número e o link utilizado.' });
    }

    const member = memberRes.rows[0];
    // Normaliza para array — suporte a registros antigos sem member_roles
    const memberRoles: string[] = (member.member_roles && member.member_roles.length)
      ? member.member_roles
      : [member.member_role];

    const token = jwt.sign(
      {
        userId: user.id,
        whatsapp: user.whatsapp,
        role: 'STAFF' as import('../shared/authMiddleware').UserRole,
        memberRole: memberRoles[0],
        memberRoles,
        establishmentId: resolvedEstId,
      },
      secret,
      { expiresIn: '12h' }
    );

    setAuthCookie(res, token, 'STAFF');
    return res.json({
      token,
      role: 'STAFF',
      memberRole: memberRoles[0],
      memberRoles,
      storeName: member.store_name,
      userName: user.full_name,
    });
  } catch (err: any) {
    console.error('❌ Erro no staff-login:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar login.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /auth/validate — valida token (usado pelos módulos SSO)
// ─────────────────────────────────────────────────────────────
router.get('/validate', requireAuth, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ─────────────────────────────────────────────────────────────
// POST /auth/refresh — renova token
// ─────────────────────────────────────────────────────────────
router.post('/refresh', requireAuth, async (req, res) => {
  const secret = process.env.JWT_SECRET!;
  const current = req.user as TokenPayload;

  try {
    if (current.role === 'SUPERADMIN') {
      const token = jwt.sign(
        { userId: 'superadmin', whatsapp: current.whatsapp, role: 'SUPERADMIN' as UserRole, establishmentId: null },
        secret, { expiresIn: '12h' }
      );
      return res.json({ token });
    }

    if (current.role === 'LOJISTA') {
      const est = await pool.query('SELECT id FROM establishments WHERE id = $1', [current.establishmentId]);
      if (!est.rows.length) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
      const token = jwt.sign(
        { userId: current.userId, whatsapp: current.whatsapp, role: 'LOJISTA' as UserRole, establishmentId: current.establishmentId },
        secret, { expiresIn: '12h' }
      );
      return res.json({ token });
    }

    // CLIENT
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [current.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const u = result.rows[0];
    const token = jwt.sign(
      { userId: u.id, whatsapp: u.whatsapp, role: 'CLIENT' as UserRole, establishmentId: u.establishment_id || null },
      secret, { expiresIn: '7d' }
    );
    return res.json({ token });

  } catch {
    res.status(500).json({ error: 'Erro ao renovar token.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/lgpd-consent — registra aceite explícito da política
// Chamado no cadastro (event=REGISTER) e no checkout (event=CHECKOUT)
// ─────────────────────────────────────────────────────────────
// Eventos permitidos sem autenticação (chamados logo após cadastro, antes de ter token)
const UNAUTHENTICATED_CONSENT_EVENTS = new Set(['REGISTER', 'LOJISTA_REGISTER', 'LOJISTA_DPA']);

router.post('/lgpd-consent', async (req, res) => {
  const { user_id, event, version } = req.body;
  if (!user_id || !event) return res.status(400).json({ error: 'user_id e event obrigatórios.' });

  const eventStr = String(event).toUpperCase();

  // Eventos pós-login (CHECKOUT, WA_OPTOUT, REVOKE) exigem token válido
  if (!UNAUTHENTICATED_CONSENT_EVENTS.has(eventStr)) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token obrigatório para este evento.' });
    }
    try {
      const jwt = await import('jsonwebtoken');
      const payload = jwt.default.verify(authHeader.split(' ')[1], process.env.JWT_SECRET!) as any;
      // Garante que o token pertence ao mesmo user_id
      if (String(payload.userId) !== String(user_id)) {
        return res.status(403).json({ error: 'user_id não corresponde ao token.' });
      }
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
  } else {
    // Para eventos sem auth, valida que o user_id existe no banco (evita spam)
    const check = await pool.query(
      `SELECT 1 FROM users WHERE id = $1 UNION ALL SELECT 1 FROM establishments WHERE id::text = $1 LIMIT 1`,
      [String(user_id)]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
  }

  const ip        = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    await pool.query(
      `INSERT INTO consent_logs (user_id, event, ip, user_agent, version) VALUES ($1,$2,$3,$4,$5)`,
      [String(user_id), eventStr, ip, userAgent, String(version || '1.0')]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
