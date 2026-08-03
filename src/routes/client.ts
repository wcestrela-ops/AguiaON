import { Router } from 'express';
import pool from '../shared/db';
import { requireAuth, TokenPayload } from '../shared/authMiddleware';
import { sendOtp, verifyOtp } from '../shared/otp_service';

const router = Router();

router.use(requireAuth);

// ─────────────────────────────────────────────────────────────
// GET /client/me — perfil unificado para qualquer role
// ─────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const user = req.user as TokenPayload;

  try {
    // SUPERADMIN — sem registro no banco
    if (user.role === 'SUPERADMIN') {
      return res.json({
        id:           'superadmin',
        full_name:    'SuperAdmin',
        whatsapp:     user.whatsapp,
        email:        process.env.ADMIN_EMAIL || null,
        role:         'SUPERADMIN',
        auth_level:   'SUPERADMIN',
        // link direto para o painel
        panel_url:    '/admin-panel',
        panel_label:  'Painel Admin',
        panel_icon:   'fa-crown',
      });
    }

    // LOJISTA — dados do estabelecimento + link para o módulo admin
    if (user.role === 'LOJISTA') {
      const result = await pool.query(
        `SELECT e.id, e.name, e.slug, e.owner_whatsapp, e.owner_email,
                e.logo_url, e.city, e.state, e.plan, e.vertical_slug,
                m.name AS module_name, m.admin_url, m.slug AS module_slug, m.icon AS module_icon
         FROM establishments e
         LEFT JOIN modules m ON m.id = e.module_id
         WHERE e.id = $1`,
        [user.establishmentId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });

      const e = result.rows[0];
      
      // Se for do módulo agenda (embutido), o admin_url é fixo
      let adminUrl = e.admin_url;
      if (e.module_slug === 'agenda' || !adminUrl) {
        adminUrl = '/loja'; // Painel unificado de agenda
      }

      const finalAdminUrl = adminUrl
        ? (/^https?:\/\//i.test(adminUrl) ? adminUrl : adminUrl)
        : null;

      return res.json({
        id:           e.id,
        full_name:    e.name,
        whatsapp:     e.owner_whatsapp,
        email:        e.owner_email,
        role:         'LOJISTA',
        auth_level:   'LOJISTA',
        establishment_id:   e.id,
        establishment_name: e.name,
        establishment_slug: e.slug,
        logo_url:     e.logo_url,
        city:         e.city,
        state:        e.state,
        plan:         e.plan,
        vertical_slug: e.vertical_slug,
        // link para o painel da loja
        panel_url:    finalAdminUrl,
        panel_label:  e.module_name ? `Painel ${e.module_name}` : 'Painel de Gestão',
        panel_icon:   e.module_icon || 'fa-chart-line',
      });
    }

    // CLIENT (inclui funcionários) — busca na tabela users
    const result = await pool.query(
      `SELECT u.id, u.whatsapp, u.full_name, u.email, u.auth_level,
              u.cpf, u.whatsapp_history,
              u.establishment_id, u.employee_role, u.created_at,
              m.profissional_url, m.icon AS module_icon, m.name AS module_name,
              e.name AS establishment_name
       FROM users u
       LEFT JOIN establishments e ON e.id = u.establishment_id
       LEFT JOIN modules m ON m.id = e.module_id
       WHERE u.id = $1`,
      [user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const u = result.rows[0];
    const response: any = { ...u, role: 'CLIENT' };

    // Funcionário legado → card "Meu Perfil Profissional"
    if (u.employee_role && u.profissional_url) {
      const base = /^https?:\/\//i.test(u.profissional_url)
        ? u.profissional_url : 'https://' + u.profissional_url;
      response.panel_url   = base;
      response.panel_label = `${u.employee_role} — ${u.establishment_name || 'Minha Loja'}`;
      response.panel_icon  = u.module_icon || 'fa-id-badge';
    }

    // Vínculos como funcionário (establishment_members) → retorna lista para o portal exibir
    const membersRes = await pool.query(
      `SELECT em.establishment_id, em.member_role, em.member_roles,
              e.name AS store_name, e.slug AS store_slug, e.logo_base64
       FROM establishment_members em
       JOIN establishments e ON e.id = em.establishment_id
       WHERE em.user_id = $1 AND em.is_active = true
       ORDER BY e.name`,
      [user.userId]
    );

    if (membersRes.rows.length) {
      const ROLE_PANEL: Record<string, string> = {
        garcom:    '/garcom',
        atendente: '/garcom',
        gerente:   '/garcom',
        entregador: '/entregador',
        cozinheiro: '/garcom',
      };
      const ROLE_ICON: Record<string, string> = {
        garcom:    'utensils',
        atendente: 'headset',
        gerente:   'user-tie',
        entregador: 'motorcycle',
        cozinheiro: 'hat-chef',
      };
      const ROLE_LABEL: Record<string, string> = {
        garcom:    'Garçom',
        atendente: 'Atendente',
        gerente:   'Gerente',
        entregador: 'Entregador',
        cozinheiro: 'Cozinheiro',
      };

      response.staff_memberships = membersRes.rows.map(m => {
        const roles: string[] = (m.member_roles?.length ? m.member_roles : [m.member_role || 'garcom'])
          .map((r: string) => r.toLowerCase());

        // Deduplica painéis: se garçom + atendente → ambos /garcom, gera um único link
        const panelMap: Record<string, string[]> = {};
        roles.forEach((role: string) => {
          const url = `${ROLE_PANEL[role] || '/garcom'}?loja=${m.establishment_id}`;
          if (!panelMap[url]) panelMap[url] = [];
          panelMap[url].push(ROLE_LABEL[role] || role);
        });

        const panels = Object.entries(panelMap).map(([url, labels]) => ({
          url,
          label: labels.join(' & '),
          icon: ROLE_ICON[roles.find((r: string) => `${ROLE_PANEL[r] || '/garcom'}?loja=${m.establishment_id}` === url) || ''] || 'id-badge',
        }));

        return {
          establishment_id: m.establishment_id,
          store_name:       m.store_name,
          store_slug:       m.store_slug,
          logo_base64:      m.logo_base64 || null,
          roles:            roles.map((r: string) => ({ role: r, label: ROLE_LABEL[r] || r, icon: ROLE_ICON[r] || 'id-badge' })),
          panels,
        };
      });
    }

    return res.json(response);

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /client/modules — estabelecimentos onde o usuário é cliente
// Mostra os estabelecimentos vinculados através de agendamentos ou módulos
// ─────────────────────────────────────────────────────────────
router.get('/modules', async (req, res) => {
  const user = req.user as TokenPayload;

  try {
    const mapEst = (r: any) => ({
      id:             r.id,
      name:           r.name,
      slug:           r.slug,
      city:           r.city || '',
      logo_url:       r.logo_url || '',
      vertical_slug:  r.vertical_slug || '',
      segment_label:  r.segment_label || '',
      segment_icon:   r.segment_icon  || '🏪',
      config_url:     `/loja/${r.slug}`,
      is_establishment: true,
    });

    if (user.role === 'SUPERADMIN') {
      // Todos os estabelecimentos ativos
      const result = await pool.query(
        `SELECT e.id, e.name, e.slug, e.city, e.logo_url, e.vertical_slug,
                s.label as segment_label, s.icon as segment_icon
         FROM establishments e
         LEFT JOIN segments s ON s.slug = e.vertical_slug
         WHERE e.is_active = true
         ORDER BY e.name`
      );
      return res.json(result.rows.map(mapEst));
    }

    if (user.role === 'LOJISTA') {
      // Apenas o próprio estabelecimento
      const result = await pool.query(
        `SELECT e.id, e.name, e.slug, e.city, e.logo_url, e.vertical_slug,
                s.label as segment_label, s.icon as segment_icon
         FROM establishments e
         LEFT JOIN segments s ON s.slug = e.vertical_slug
         WHERE e.id = $1`,
        [user.establishmentId]
      );
      return res.json(result.rows.map(mapEst));
    }

    // CLIENT — estabelecimentos com histórico ou vínculo direto
    const result = await pool.query(
      `SELECT DISTINCT e.id, e.name, e.slug, e.city, e.logo_url, e.vertical_slug,
               s.label as segment_label, s.icon as segment_icon
       FROM establishments e
       LEFT JOIN segments s ON s.slug = e.vertical_slug
       LEFT JOIN agenda_agendamentos a ON a.establishment_id = e.id
       WHERE a.user_id = $1 OR a.cliente_telefone = $2
          OR e.id IN (SELECT establishment_id FROM users WHERE id = $1)
       ORDER BY e.name`,
      [user.userId, user.whatsapp]
    );

    return res.json(result.rows.map(mapEst));

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /client/otp/send — envia OTP para edição de perfil
// Apenas CLIENT (lojista edita pelo painel da loja)
// ─────────────────────────────────────────────────────────────
router.post('/otp/send', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') {
    return res.status(403).json({ error: 'Apenas clientes podem editar o perfil por aqui.' });
  }

  try {
    const result = await pool.query(
      'SELECT whatsapp, email FROM users WHERE id = $1',
      [user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const { whatsapp, email } = result.rows[0];
    const otp = await sendOtp(user.userId, whatsapp, email, 'PROFILE_EDIT');

    res.json({ sent: true, channels: otp.channels });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /client/me — salva perfil após OTP (só CLIENT)
// ─────────────────────────────────────────────────────────────
router.patch('/me', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') {
    return res.status(403).json({ error: 'Apenas clientes podem editar o perfil por aqui.' });
  }

  const { otp_code, full_name, email, whatsapp, cpf } = req.body;
  if (!otp_code) return res.status(400).json({ error: 'Código OTP obrigatório.' });

  try {
    const valid = await verifyOtp(user.userId, otp_code, 'PROFILE_EDIT');
    if (!valid) return res.status(401).json({ error: 'Código inválido ou expirado.' });

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (full_name !== undefined) { fields.push(`full_name = $${i++}`); values.push(full_name); }
    if (email     !== undefined) { fields.push(`email = $${i++}`);     values.push(email); }
    if (cpf       !== undefined) { fields.push(`cpf = $${i++}`);       values.push(cpf || null); }

    // Alterar WhatsApp — salva o antigo no histórico
    if (whatsapp !== undefined) {
      const newWa = String(whatsapp).replace(/\D/g, '');
      if (newWa) {
        // Verifica duplicidade
        const dup = await pool.query(
          `SELECT id FROM users WHERE whatsapp = $1 AND id <> $2`, [newWa, user.userId]
        );
        if (dup.rows.length) return res.status(409).json({ error: 'Este WhatsApp já está em uso por outra conta.' });

        // Lê WA atual para gravar no histórico
        const cur = await pool.query(`SELECT whatsapp, whatsapp_history FROM users WHERE id = $1`, [user.userId]);
        if (cur.rows.length && cur.rows[0].whatsapp && cur.rows[0].whatsapp !== newWa) {
          const history: any[] = cur.rows[0].whatsapp_history || [];
          history.push({ whatsapp: cur.rows[0].whatsapp, changed_at: new Date().toISOString() });
          fields.push(`whatsapp_history = $${i++}`);
          values.push(JSON.stringify(history));
        }
        fields.push(`whatsapp = $${i++}`);
        values.push(newWa);
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

    fields.push(`updated_at = NOW()`);
    values.push(user.userId);

    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${i}`, values);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /client/establishment — lojista atualiza perfil público
// Também pode ser chamado por módulos usando o JWT do lojista
// ─────────────────────────────────────────────────────────────
router.patch('/establishment', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'LOJISTA' && user.role !== 'SUPERADMIN') {
    return res.status(403).json({ error: 'Apenas lojistas podem atualizar o estabelecimento.' });
  }

  // SUPERADMIN pode passar establishment_id no body; LOJISTA usa o do token
  const estId = user.role === 'SUPERADMIN'
    ? (req.body.establishment_id || user.establishmentId)
    : user.establishmentId;

  if (!estId) {
    return res.status(400).json({ error: 'Estabelecimento não encontrado.' });
  }

  const allowed = [
    'name', 'description', 'logo_url', 'cover_url',
    'category', 'city', 'state', 'phone', 'address',
    'whatsapp_link', 'instagram_url', 'is_public',
  ];

  try {
    const fields: string[] = [];
    const values: any[]   = [];
    let i = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(req.body[key]);
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo enviado.' });

    fields.push(`updated_at = NOW()`);
    values.push(estId);

    const result = await pool.query(
      `UPDATE establishments SET ${fields.join(', ')} WHERE id = $${i} RETURNING
         id, name, slug, description, logo_url, cover_url, category,
         city, state, phone, address, whatsapp_link, instagram_url, is_public`,
      values
    );

    res.json({ success: true, establishment: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /client/establishment — lojista lê o próprio perfil público
// ─────────────────────────────────────────────────────────────
router.get('/establishment', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'LOJISTA') {
    return res.status(403).json({ error: 'Apenas lojistas.' });
  }
  try {
    const result = await pool.query(
      `SELECT id, name, slug, description, logo_url, cover_url, category,
              city, state, phone, address, whatsapp_link, instagram_url, is_public
       FROM establishments WHERE id = $1`,
      [user.establishmentId]
    );
    res.json(result.rows[0] || {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /client/agenda/summary — resumo de agendamentos (visto pelo cliente)
// ─────────────────────────────────────────────────────────────
router.get('/agenda/summary', async (req, res) => {
  const user = req.user as TokenPayload;
  try {
    const result = await pool.query(
      `SELECT a.*, e.name as establishment_name, e.logo_url as establishment_logo,
              s.nome as service_name, p.nome as professional_name
       FROM agenda_agendamentos a
       JOIN establishments e ON e.id = a.establishment_id
       LEFT JOIN agenda_servicos s ON s.id = a.servico_id
       LEFT JOIN agenda_profissionais p ON p.id = a.profissional_id
       WHERE a.user_id = $1 OR a.cliente_telefone = $2
       ORDER BY a.data DESC, a.hora_inicio DESC
       LIMIT 20`,
      [user.userId, user.whatsapp]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /client/transactions — histórico (CLIENT e LOJISTA)
// ─────────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  const user = req.user as TokenPayload;

  try {
    const col = user.role === 'LOJISTA' ? 'establishment_id' : 'user_id';
    const id  = user.role === 'LOJISTA' ? user.establishmentId : user.userId;

    const result = await pool.query(
      `SELECT t.id, t.amount, t.currency, t.status, t.description,
              t.gateway, t.paid_at, t.created_at,
              m.name AS module_name, m.icon AS module_icon
       FROM transactions t
       LEFT JOIN modules m ON m.id = t.module_id
       WHERE t.${col} = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [id]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /client/announcements
// ─────────────────────────────────────────────────────────────
router.get('/announcements', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, description, image_url, link_url, display_order
       FROM announcements
       WHERE is_active = true
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at IS NULL OR ends_at > NOW())
       ORDER BY display_order ASC, created_at DESC`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /client/addresses — lista endereços salvos do cliente
// ─────────────────────────────────────────────────────────────
router.get('/addresses', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes.' });
  try {
    const result = await pool.query(
      `SELECT * FROM user_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC`,
      [user.userId]
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// POST /client/addresses — salva novo endereço
// ─────────────────────────────────────────────────────────────
router.post('/addresses', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes.' });

  const { label, street, number, neighborhood, city, reference, address, is_default } = req.body;
  if (!address) return res.status(400).json({ error: 'Endereço obrigatório.' });

  try {
    // Se novo padrão, remove padrão anterior
    if (is_default) {
      await pool.query(`UPDATE user_addresses SET is_default=false WHERE user_id=$1`, [user.userId]);
    }
    const result = await pool.query(
      `INSERT INTO user_addresses (user_id, label, street, number, neighborhood, city, reference, address, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [user.userId, label || 'Casa', street||null, number||null, neighborhood||null, city||null, reference||null, address, !!is_default]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// PATCH /client/addresses/:id — atualiza endereço
// ─────────────────────────────────────────────────────────────
router.patch('/addresses/:id', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes.' });

  const { label, street, number, neighborhood, city, reference, address, is_default } = req.body;
  try {
    if (is_default) {
      await pool.query(`UPDATE user_addresses SET is_default=false WHERE user_id=$1`, [user.userId]);
    }
    const result = await pool.query(
      `UPDATE user_addresses
       SET label=$1, street=$2, number=$3, neighborhood=$4, city=$5, reference=$6,
           address=$7, is_default=$8, updated_at=NOW()
       WHERE id=$9 AND user_id=$10 RETURNING *`,
      [label||'Casa', street||null, number||null, neighborhood||null, city||null, reference||null,
       address, !!is_default, req.params.id, user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Endereço não encontrado.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// DELETE /client/addresses/:id
// ─────────────────────────────────────────────────────────────
router.delete('/addresses/:id', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes.' });
  try {
    await pool.query(`DELETE FROM user_addresses WHERE id=$1 AND user_id=$2`, [req.params.id, user.userId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// GET /client/lgpd/optout — retorna status atual do opt-out de WA
// PATCH /client/lgpd/optout — alterna opt-out
// ─────────────────────────────────────────────────────────────
router.get('/lgpd/optout', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes.' });
  try {
    const r = await pool.query(`SELECT whatsapp_optout FROM users WHERE id=$1`, [user.userId]);
    res.json({ whatsapp_optout: r.rows[0]?.whatsapp_optout ?? false });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.patch('/lgpd/optout', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes.' });
  const { whatsapp_optout } = req.body;
  if (typeof whatsapp_optout !== 'boolean') return res.status(400).json({ error: 'whatsapp_optout deve ser boolean.' });
  try {
    await pool.query(
      `UPDATE users SET whatsapp_optout=$1, whatsapp_optout_at=$2 WHERE id=$3`,
      [whatsapp_optout, whatsapp_optout ? new Date() : null, user.userId]
    );
    // Registra evento no consent_logs
    await pool.query(
      `INSERT INTO consent_logs (user_id, event, version) VALUES ($1,$2,'1.0')`,
      [user.userId, whatsapp_optout ? 'WA_OPTOUT' : 'WA_OPTIN']
    );
    res.json({ success: true, whatsapp_optout });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// DELETE /client/me — LGPD: direito ao esquecimento
// Anonimiza dados pessoais do usuário e apaga endereços/memória
// ─────────────────────────────────────────────────────────────
router.delete('/me', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes podem excluir a própria conta.' });

  const userId = user.userId;

  try {
    await pool.query(`
      UPDATE users SET
        full_name        = 'Usuário Removido',
        whatsapp         = NULL,
        email            = NULL,
        password_hash    = NULL,
        cpf              = NULL,
        whatsapp_history = '[]',
        is_confirmed     = false,
        deleted_at       = NOW()
      WHERE id = $1
    `, [userId]);

    await pool.query(`DELETE FROM user_addresses WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM ai_memory        WHERE user_id = $1`, [userId]);

    // Preserva pedidos históricos por obrigação legal (Art. 16 LGPD), mas desvincula dados pessoais
    await pool.query(`
      UPDATE delivery_orders SET
        customer_name    = 'Cliente Removido',
        customer_phone   = NULL,
        customer_address = NULL
      WHERE customer_phone IN (
        SELECT unnest(ARRAY(SELECT jsonb_array_elements_text(whatsapp_history) FROM users WHERE id = $1))
      )
    `, [userId]).catch(() => {});

    res.json({ success: true, message: 'Conta anonimizada com sucesso. Seus dados pessoais foram removidos.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /client/lgpd/export — LGPD: portabilidade de dados
// Retorna todos os dados do usuário em JSON
// ─────────────────────────────────────────────────────────────
router.get('/lgpd/export', async (req, res) => {
  const user = req.user as TokenPayload;
  if (user.role !== 'CLIENT') return res.status(403).json({ error: 'Apenas clientes.' });

  try {
    const [meRes, addrRes, ordersRes, memRes, consentRes] = await Promise.all([
      pool.query(`SELECT id, full_name, whatsapp, email, cpf, auth_level, created_at FROM users WHERE id = $1`, [user.userId]),
      pool.query(`SELECT * FROM user_addresses WHERE user_id = $1`, [user.userId]),
      pool.query(`SELECT id, created_at, status, total, delivery_type, items FROM delivery_orders WHERE customer_phone = (SELECT whatsapp FROM users WHERE id = $1) ORDER BY created_at DESC LIMIT 100`, [user.userId]),
      pool.query(`SELECT summary, last_interaction FROM ai_memory WHERE user_id = $1 LIMIT 1`, [user.userId]),
      pool.query(`SELECT event, ip, created_at FROM consent_logs WHERE user_id = $1 ORDER BY created_at DESC`, [user.userId]),
    ]);

    res.json({
      exported_at: new Date().toISOString(),
      profile:     meRes.rows[0] || null,
      addresses:   addrRes.rows,
      orders:      ordersRes.rows,
      ai_memory:   memRes.rows[0] || null,
      consents:    consentRes.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
