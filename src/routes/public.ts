import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../shared/db';
import { generateUniqueSlug } from '../shared/utils';
import { getBlueprint, listBlueprints } from '../verticals/blueprints';
import { decrypt } from '../shared/cryptoUtil';

const router = Router();

// ─────────────────────────────────────────────────────────────
// GET /public/modules — lista módulos ativos (vitrine legacy)
// ─────────────────────────────────────────────────────────────
router.get('/modules', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, slug, icon FROM modules WHERE is_active = true ORDER BY name'
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/segments — segmentos agrupados por módulo
// Retorna: [{ module_slug, module_label, module_icon, segments: [...] }]
// ─────────────────────────────────────────────────────────────
router.get('/segments', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, module_slug, module_label, module_icon,
              slug, label, descricao, icon, cor_primaria, cor_destaque, features,
              plano_1, plano_2
       FROM segments WHERE ativo = true
       ORDER BY module_slug, ordem, label`
    );

    // Se tabela vazia, usa blueprints hardcoded como fallback
    if (!result.rows.length) {
      const bps = listBlueprints();
      return res.json([{
        module_slug: 'geral',
        module_label: 'Segmentos Disponíveis',
        module_icon: '🏪',
        segments: bps.map(bp => ({
          slug: bp.slug, label: bp.label, descricao: bp.descricao,
          icon: bp.icon, cor_primaria: '#0f172a', cor_destaque: bp.cor_destaque,
          features: [],
        })),
      }]);
    }

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
      grouped[row.module_slug].segments.push({
        id: row.id, slug: row.slug, label: row.label,
        descricao: row.descricao, icon: row.icon,
        cor_primaria: row.cor_primaria, cor_destaque: row.cor_destaque,
        features: row.features,
        plano_1: row.plano_1, plano_2: row.plano_2
      });
    }
    res.json(Object.values(grouped));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /public/register/lojista — cadastro automático (sem aprovação)
// Cria estabelecimento + usuário LOJISTA + aplica blueprint do segmento
// Retorna JWT para login imediato
// ─────────────────────────────────────────────────────────────
router.post('/register/lojista', async (req, res) => {
  const { business_name, owner_name, email, whatsapp, password, city, segment_slug } = req.body;

  if (!business_name || !owner_name || !password || (!email && !whatsapp)) {
    return res.status(400).json({ error: 'Nome do negócio, responsável, senha e contato são obrigatórios.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'Configuração interna inválida.' });

  try {
    // Verifica duplicidade de e-mail / whatsapp
    const clean    = whatsapp?.replace(/\D/g, '') || null;
    const emailLow = email?.toLowerCase().trim()  || null;

    const dup = await pool.query(
      `SELECT id FROM users WHERE (whatsapp IS NOT NULL AND whatsapp = $1)
         OR (email IS NOT NULL AND lower(email) = $2) LIMIT 1`,
      [clean || '', emailLow || '']
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'Já existe um cadastro com este e-mail ou WhatsApp.' });
    }

    // Geração de Slug Único usando o novo utilitário
    const finalSlug = await generateUniqueSlug(business_name);

    const estRes = await pool.query(
      `INSERT INTO establishments (name, slug, city, vertical_slug, setup_done, is_active, is_public)
       VALUES ($1, $2, $3, $4, false, true, true) RETURNING id`,
      [business_name, finalSlug, city || null, segment_slug || 'generico']
    );
    const estId = estRes.rows[0].id;

    // Cria usuário LOJISTA
    const hash    = await bcrypt.hash(password, 10);
    const userRes = await pool.query(
      `INSERT INTO users (full_name, whatsapp, email, password_hash, auth_level, establishment_id, is_confirmed)
       VALUES ($1, $2, $3, $4, 'LOJISTA', $5, true) RETURNING id`,
      [owner_name.trim(), clean, emailLow, hash, estId]
    );
    const userId = userRes.rows[0].id;

    // Aplica blueprint do segmento se fornecido
    if (segment_slug && segment_slug !== 'generico') {
      // Busca no banco; fallback para blueprint hardcoded
      const segRes = await pool.query(
        `SELECT * FROM segments WHERE slug = $1 AND ativo = true LIMIT 1`, [segment_slug]
      );
      let seg: any = null;
      if (segRes.rows.length > 0) {
        seg = segRes.rows[0];
      } else {
        try {
          const bp = getBlueprint(segment_slug);
          seg = { ...bp, features: bp.features, business_config: bp.business_config, servicos_padrao: bp.servicos_padrao };
        } catch { /* slug inválido — ignora */ }
      }

      if (seg) {
        await pool.query(
          `UPDATE establishments SET
             active_features=$1, business_config=$2, cor_primaria=$3,
             cor_destaque=$4, setup_done=true, updated_at=NOW()
           WHERE id=$5`,
          [JSON.stringify(seg.features), JSON.stringify(seg.business_config),
           seg.cor_primaria, seg.cor_destaque, estId]
        );

        const servicos: any[] = seg.servicos_padrao || [];
        for (const s of servicos) {
          await pool.query(
            `INSERT INTO agenda_servicos (establishment_id, nome, categoria, duracao_minutos, preco, ordem)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [estId, s.nome, s.categoria, s.duracao_minutos, s.preco, s.ordem]
          );
        }
      }
    }

    // Gera JWT para login imediato
    const token = jwt.sign(
      { userId, role: 'LOJISTA', establishmentId: estId },
      secret,
      { expiresIn: '30d' }
    );

    // Configura o cookie de autenticação para permitir login automático no Portal
    const domain = process.env.COOKIE_DOMAIN;
    const options: Record<string, any> = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dias
    };
    if (domain) options.domain = domain;
    res.cookie('auth_token', token, options);

    res.status(201).json({
      success: true,
      token,
      redirect: '/portal',
      user: { id: userId, full_name: owner_name, role: 'LOJISTA' },
      establishment: { id: estId, name: business_name, slug: finalSlug },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/marketplace — lojas públicas com filtros
//   ?q=busca  ?category=X  ?city=X  ?module_id=X
// ─────────────────────────────────────────────────────────────
router.get('/marketplace', async (req, res) => {
  const { q, category, city, module_id, vertical_slug } = req.query as Record<string, string>;

  try {
    const params: any[] = [];
    const conditions: string[] = ['e.is_active = true', 'e.is_public = true'];

    if (module_id) {
      params.push(module_id);
      conditions.push(`e.module_id = $${params.length}`);
    }
    if (category) {
      params.push(category);
      conditions.push(`e.category = $${params.length}`);
    }
    if (city) {
      params.push(`%${city}%`);
      conditions.push(`e.city ILIKE $${params.length}`);
    }
    if (vertical_slug) {
      params.push(vertical_slug);
      conditions.push(`e.vertical_slug = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      conditions.push(`(e.name ILIKE $${n} OR e.description ILIKE $${n} OR e.category ILIKE $${n})`);
    }

    const result = await pool.query(
      `SELECT e.id, e.name, e.slug, e.description,
              e.logo_url, e.logo_base64, e.cover_url,
              e.category, e.city, e.state, e.phone, e.whatsapp_link,
              e.instagram_url, e.address, e.vertical_slug,
              e.settings->>'theme' AS theme_json,
              s.icon AS segment_icon, s.label AS segment_label, s.cor_destaque AS segment_color
       FROM establishments e
       LEFT JOIN segments s ON s.slug = e.vertical_slug
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/marketplace/categories — lista categorias (segmentos ativos)
// ─────────────────────────────────────────────────────────────
router.get('/marketplace/categories', async (_req, res) => {
  try {
    // Prioriza os rótulos (labels) dos segmentos ativos cadastrados pelo admin
    const result = await pool.query(
      `SELECT DISTINCT label as category, slug FROM segments
       WHERE ativo = true
       ORDER BY label ASC`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/marketplace/professionals — profissionais públicos
// ─────────────────────────────────────────────────────────────
router.get('/marketplace/professionals', async (req, res) => {
  const { q, establishment_id } = req.query as Record<string, string>;

  try {
    const params: any[] = [];
    const conditions: string[] = [
      'u.employee_role IS NOT NULL',
      'e.is_active = true',
      'e.is_public = true',
    ];

    if (establishment_id) {
      params.push(establishment_id);
      conditions.push(`u.establishment_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      conditions.push(`(u.full_name ILIKE $${n} OR u.employee_role ILIKE $${n})`);
    }

    const result = await pool.query(
      `SELECT u.id, u.full_name, u.employee_role,
              e.id AS establishment_id, e.name AS establishment_name,
              e.logo_url AS establishment_logo,
              m.name AS module_name, m.profissional_url
       FROM users u
       INNER JOIN establishments e ON e.id = u.establishment_id
       LEFT JOIN modules m ON m.id = e.module_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY u.full_name ASC`,
      params
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/marketplace/id/:estId — perfil público por UUID (totem/checkout)
// ─────────────────────────────────────────────────────────────
router.get('/marketplace/id/:estId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.name, e.slug, e.description, e.category, e.city, e.state, e.phone,
              e.whatsapp_link, e.instagram_url, e.facebook_url, e.website_url,
              e.logo_url, e.cover_url, e.logo_base64, e.social_links, e.settings, e.niche_data,
              e.pix_key_type, e.pix_key_value, e.pix_receiver_name, e.preferred_payment_method,
              e.cor_primaria, e.cor_destaque,
              m.name AS module_name, m.slug AS module_slug,
              m.icon AS module_icon, m.config_url AS module_url, m.profissional_url
       FROM establishments e
       LEFT JOIN modules m ON m.id = e.module_id
       WHERE (e.id::text = $1 OR e.slug = $1) AND e.is_active = true`,
      [req.params.estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Loja não encontrada.', id: req.params.estId });
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('[marketplace/id/:estId] SQL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/marketplace/:slug — perfil público de uma loja
// ─────────────────────────────────────────────────────────────
router.get('/marketplace/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.name, e.slug, e.description, e.category, e.city, e.state, e.phone,
              e.whatsapp_link, e.instagram_url, e.facebook_url, e.website_url,
              e.logo_url, e.cover_url, e.logo_base64, e.social_links, e.settings, e.niche_data,
              e.pix_key_type, e.pix_key_value, e.pix_receiver_name, e.preferred_payment_method,
              e.cor_primaria, e.cor_destaque, e.vertical_slug, e.active_features,
              e.mp_public_key, e.mp_status,
              m.name AS module_name, m.slug AS module_slug,
              m.icon AS module_icon, m.config_url AS module_url, m.profissional_url
       FROM establishments e
       LEFT JOIN modules m ON m.id = e.module_id
       WHERE e.slug = $1 AND e.is_active = true AND e.is_public = true`,
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Loja não encontrada.', slug: req.params.slug });
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('[marketplace/:slug] SQL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/catalog/:estId — Itens agrupados por categoria (lê da tabela products)
// ─────────────────────────────────────────────────────────────
router.get('/catalog/:estId', async (req, res) => {
    try {
        // Resolve slug → UUID
        const estRes = await pool.query(
            `SELECT id FROM establishments WHERE id::text = $1 OR slug = $1 LIMIT 1`,
            [req.params.estId]
        );
        if (!estRes.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
        const estId = estRes.rows[0].id;

        const [catsRes, itemsRes] = await Promise.all([
            pool.query(
                `SELECT id, name, order_index FROM categories
                 WHERE establishment_id = $1 ORDER BY order_index ASC, name ASC`,
                [estId]
            ),
            pool.query(
                `SELECT id, category_id, type, name, description, price,
                        image_base64, video_url, settings,
                        (settings->>'recurrence')        AS recurrence,
                        (settings->>'duration_minutes')::int AS duration_minutes,
                        (settings->>'is_promo')::boolean AS is_promo_flag
                 FROM products
                 WHERE establishment_id = $1 AND active = true
                 ORDER BY name ASC`,
                [estId]
            ),
        ]);

        const items = itemsRes.rows;
        const productIds = items.map((p: any) => p.id);

        // Carrega addon_groups de todos os produtos em lote
        let addonMap: Record<string, any[]> = {};
        if (productIds.length) {
            const addonRes = await pool.query(
                `SELECT pag.product_id, ag.id, ag.name, ag.min_qty, ag.max_qty, ag.is_required, pag.sort_order,
                        agi.id AS item_id, agi.name AS item_name, agi.price AS item_price, agi.sort_order AS item_sort
                 FROM product_addon_groups pag
                 JOIN addon_groups ag ON ag.id = pag.addon_group_id
                 JOIN addon_group_items agi ON agi.addon_group_id = ag.id AND agi.is_active = true
                 WHERE pag.product_id = ANY($1)
                 ORDER BY pag.sort_order ASC, agi.sort_order ASC`,
                [productIds]
            ).catch(() => ({ rows: [] as any[] }));

            const tempMap: Record<string, Record<string, any>> = {};
            addonRes.rows.forEach((row: any) => {
                if (!tempMap[row.product_id]) tempMap[row.product_id] = {};
                if (!tempMap[row.product_id][row.id]) {
                    tempMap[row.product_id][row.id] = {
                        id: row.id, name: row.name,
                        min_options: row.min_qty || 0,
                        max_options: row.max_qty || 1,
                        is_required: row.is_required,
                        sort_order: row.sort_order,
                        items: [],
                    };
                }
                tempMap[row.product_id][row.id].items.push({
                    id: row.item_id, name: row.item_name,
                    additional_price: +row.item_price || 0,
                    order_index: row.item_sort,
                });
            });
            Object.entries(tempMap).forEach(([pid, groups]) => {
                addonMap[pid] = Object.values(groups).sort((a: any, b: any) => a.sort_order - b.sort_order);
            });
        }

        const enrichedItems = items.map((p: any) => ({
            ...p,
            addon_groups: addonMap[p.id] || [],
        }));

        const categories = catsRes.rows;
        const grouped = categories
            .map((c: any) => ({ ...c, items: enrichedItems.filter((i: any) => i.category_id === c.id) }))
            .filter((c: any) => c.items.length > 0);

        const uncatItems = enrichedItems.filter((i: any) => !i.category_id);
        if (uncatItems.length > 0) grouped.push({ id: null, name: 'Outros', items: uncatItems } as any);

        res.json(grouped);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// Aliases legados /public/establishments → mesmo que /public/marketplace
// ─────────────────────────────────────────────────────────────
router.get('/establishments', async (req, res) => {
  const { q, category, city, module_id } = req.query as Record<string, string>;
  try {
    const params: any[] = [];
    const conditions: string[] = ['e.is_active = true', 'e.is_public = true'];
    if (module_id) { params.push(module_id); conditions.push(`e.module_id = $${params.length}`); }
    if (category)  { params.push(category);  conditions.push(`e.category = $${params.length}`); }
    if (city)      { params.push(`%${city}%`); conditions.push(`e.city ILIKE $${params.length}`); }
    if (q)         { params.push(`%${q}%`); conditions.push(`(e.name ILIKE $${params.length} OR e.description ILIKE $${params.length})`); }
    const result = await pool.query(
      `SELECT e.id, e.name, e.slug, e.description, e.logo_url, e.cover_url,
              e.category, e.city, e.state, e.phone, e.whatsapp_link,
              m.name AS module_name, m.icon AS module_icon, m.config_url AS module_url
       FROM establishments e
       LEFT JOIN modules m ON m.id = e.module_id
       WHERE ${conditions.join(' AND ')} ORDER BY e.name ASC`, params
    );
    res.json(result.rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/establishments/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, m.name AS module_name, m.slug AS module_slug,
              m.icon AS module_icon, m.config_url AS module_url
       FROM establishments e LEFT JOIN modules m ON m.id = e.module_id
       WHERE (e.slug = $1 OR e.id::text = $1) AND e.is_active = true AND e.is_public = true`,
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Loja não encontrada.' });
    res.json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// POST /public/register/client — cadastro de cliente
// ─────────────────────────────────────────────────────────────
router.post('/register/client', async (req, res) => {
  const { whatsapp, full_name, email } = req.body;
  if (!whatsapp) return res.status(400).json({ error: 'WhatsApp obrigatório.' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE whatsapp = $1', [whatsapp]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Este WhatsApp já possui cadastro. Faça login.' });
    }
    const result = await pool.query(
      `INSERT INTO users (whatsapp, full_name, email, auth_level)
       VALUES ($1, $2, $3, 'REGISTERED') RETURNING id, whatsapp, full_name, email, auth_level`,
      [whatsapp, full_name || null, email || null]
    );
    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /public/register/partner — solicitar parceria (lojista)
// ─────────────────────────────────────────────────────────────
router.post('/register/partner', async (req, res) => {
  const { business_name, owner_name, email, whatsapp, city, state, module_id, vertical_slug, message } = req.body;
  if (!business_name || !owner_name || !email || !whatsapp) {
    return res.status(400).json({ error: 'Nome da empresa, responsável, e-mail e WhatsApp são obrigatórios.' });
  }

  try {
    const existing = await pool.query(
      "SELECT id FROM partner_requests WHERE whatsapp = $1 AND status = 'PENDING'",
      [whatsapp]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Já existe uma solicitação pendente para este WhatsApp.' });
    }
    await pool.query(
      `INSERT INTO partner_requests (business_name, owner_name, email, whatsapp, city, state, module_id, vertical_slug, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [business_name, owner_name, email, whatsapp, city || null, state || null, module_id || null, vertical_slug || null, message || null]
    );
    res.status(201).json({ success: true, message: 'Solicitação enviada! Entraremos em contato em breve.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/announcements — anúncios para a home/marketplace
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
// GET /public/marketplace/stats — números públicos para landing page
// ─────────────────────────────────────────────────────────────
router.get('/marketplace/stats', async (_req, res) => {
  try {
    const [storesR, ordersR, clientsR, aiR] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM establishments WHERE is_active = true`),
      pool.query(`SELECT COUNT(*) FROM agenda_agendamentos`),
      pool.query(`SELECT COUNT(DISTINCT COALESCE(user_id::text, cliente_telefone)) FROM agenda_agendamentos`),
      pool.query(`SELECT COUNT(*) FROM ai_action_logs`),
    ]);
    res.json({
      stores:   parseInt(storesR.rows[0].count)  || 0,
      orders:   parseInt(ordersR.rows[0].count)  || 0,
      clients:  parseInt(clientsR.rows[0].count) || 0,
      ai_msgs:  parseInt(aiR.rows[0].count)      || 0,
    });
  } catch {
    res.json({ stores: 0, orders: 0, clients: 0, ai_msgs: 0 });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /public/settings — configurações públicas (PWA, tema, etc.)
// ─────────────────────────────────────────────────────────────
router.get('/settings', async (_req, res) => {
  try {
    const keys = ['pwa_name', 'pwa_theme_color', 'pwa_description', 'mp_client_id', 'mp_redirect_uri', 'maps_key'];
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const [gsResult, agataResult] = await Promise.all([
      pool.query(`SELECT key, value FROM global_settings WHERE key IN (${placeholders})`, keys),
      pool.query(`SELECT name, photo_url FROM agata_personality LIMIT 1`),
    ]);
    const settings: Record<string, string> = {};
    gsResult.rows.forEach(row => {
      settings[row.key] = ['mp_client_id'].includes(row.key) ? decrypt(row.value) : row.value;
    });
    const agata = agataResult.rows[0];
    if (agata) {
      if (agata.name)      settings.agata_name      = agata.name;
      if (agata.photo_url) settings.agata_photo_url = agata.photo_url;
    }
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;