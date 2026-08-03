import { Router, Request } from 'express';
import pool from '../shared/db';
import { requireAuth, requireRole } from '../shared/authMiddleware';
import { invalidateWAConfigCache } from '../shared/waSender';
import { getBlueprint, listBlueprints } from '../verticals/blueprints';
import { decrypt, encrypt, isSensitiveKey } from '../shared/cryptoUtil';
import { logActivity } from '../shared/activityLogger';
import { loadAIConfig, askAI } from '../shared/aiProvider';
import { syncAgataContext } from '../shared/syncAgata';
import { invalidateTenantHostCache } from '../shared/tenantResolver';

const router = Router();

// ─── POST /lojista/agata/sync — sincronização manual do contexto ──
router.post('/agata/sync', requireAuth, requireRole('LOJISTA', 'SUPERADMIN', 'STAFF'), async (req: Request, res: any) => {
  const user = req.user!;
  const estId = user.role === 'LOJISTA' || user.role === 'STAFF'
    ? user.establishmentId!
    : (req.body?.establishment_id as string);
  if (!estId) return res.status(400).json({ error: 'establishment_id ausente.' });
  try {
    const knowledge = await syncAgataContext(estId);
    res.json({ ok: true, chars: knowledge.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Migração de colunas do estabelecimento (executa na inicialização) ──────
(async () => {
  try {
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS favicon_base64 TEXT`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS logo_base64 TEXT`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS niche_data JSONB DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS instagram_url TEXT`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS facebook_url TEXT`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS website_url TEXT`);
    await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS whatsapp_link TEXT`);
  } catch (e: any) {
    console.error('[lojista migration]', e.message);
  }
})();

router.use(requireAuth);
router.use(requireRole('LOJISTA', 'SUPERADMIN'));

// Helper: retorna o establishment_id correto para LOJISTA ou SUPERADMIN
function getEstId(req: Request): string {
  const user = req.user!;
  if (user.role === 'LOJISTA') return user.establishmentId!;
  // SUPERADMIN pode operar qualquer loja; passa establishment_id no body (POST/PUT) ou query (GET)
  return (req.body?.establishment_id as string) || (req.query.establishment_id as string) || '';
}

// ─────────────────────────────────────────────────────────────
// GET /lojista/employees — lista funcionários do estabelecimento
// ─────────────────────────────────────────────────────────────
router.get('/employees', async (req, res) => {
  const estId = getEstId(req);

  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });

  try {
    const result = await pool.query(
      `SELECT id, full_name, whatsapp, email, employee_role, created_at
       FROM users
       WHERE establishment_id = $1 AND employee_role IS NOT NULL
       ORDER BY full_name ASC`,
      [estId]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /lojista/employees — cria funcionário
// ─────────────────────────────────────────────────────────────
router.post('/employees', async (req, res) => {
  const { full_name, whatsapp, email, employee_role } = req.body;

  if (!employee_role) {
    return res.status(400).json({ error: 'Cargo (employee_role) obrigatório.' });
  }
  if (!whatsapp && !email) {
    return res.status(400).json({ error: 'Informe WhatsApp ou e-mail do funcionário.' });
  }

  const estId = getEstId(req);

  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });

  try {
    const clean = whatsapp?.replace(/\D/g, '') || null;
    const emailLower = email?.toLowerCase().trim() || null;

    // Verifica se já existe
    const existing = await pool.query(
      `SELECT id FROM users WHERE whatsapp = $1 OR (email IS NOT NULL AND lower(email) = $2) LIMIT 1`,
      [clean || '', emailLower || '']
    );

    let userId: string;

    if (existing.rows.length > 0) {
      // Atualiza funcionário existente
      userId = existing.rows[0].id;
      await pool.query(
        `UPDATE users SET employee_role = $1, establishment_id = $2, updated_at = NOW() WHERE id = $3`,
        [employee_role, estId, userId]
      );
    } else {
      // Cria novo usuário funcionário (sem senha — deve usar forgot-password)
      const result = await pool.query(
        `INSERT INTO users (whatsapp, email, full_name, auth_level, establishment_id, employee_role, is_confirmed)
         VALUES ($1, $2, $3, 'REGISTERED', $4, $5, true)
         RETURNING id`,
        [clean, emailLower, full_name?.trim() || null, estId, employee_role]
      );
      userId = result.rows[0].id;
    }

    res.status(201).json({ success: true, userId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /lojista/employees/:id — atualiza cargo
// ─────────────────────────────────────────────────────────────
router.patch('/employees/:id', async (req, res) => {
  const { employee_role, full_name } = req.body;
  const estId = getEstId(req);

  try {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (employee_role !== undefined) { fields.push(`employee_role = $${i++}`); vals.push(employee_role || null); }
    if (full_name !== undefined)     { fields.push(`full_name = $${i++}`);     vals.push(full_name); }
    if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar.' });

    fields.push(`updated_at = NOW()`);
    vals.push(req.params.id, estId);

    // Só pode editar funcionários do próprio estabelecimento
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')}
       WHERE id = $${i} AND establishment_id = $${i + 1} RETURNING id`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /lojista/employees/:id — remove vínculo de funcionário
// (não apaga o usuário, apenas limpa employee_role)
// ─────────────────────────────────────────────────────────────
router.delete('/employees/:id', async (req, res) => {
  const estId = getEstId(req);

  try {
    const result = await pool.query(
      `UPDATE users SET employee_role = NULL, updated_at = NOW()
       WHERE id = $1 AND establishment_id = $2 RETURNING id`,
      [req.params.id, estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /lojista/blueprints — lista segmentos do banco (alias p/ loja.html)
// ─────────────────────────────────────────────────────────────
router.get('/blueprints', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT slug, label AS label, descricao, icon, cor_primaria, cor_destaque, features
       FROM segments WHERE ativo = true ORDER BY module_slug, ordem`
    );
    if (result.rows.length > 0) {
      return res.json(result.rows.map(s => ({
        slug: s.slug, label: s.label, descricao: s.descricao,
        icon: s.icon, cor_destaque: s.cor_destaque,
      })));
    }
    // Fallback: usa blueprints hardcoded se tabela segments estiver vazia
    res.json(listBlueprints());
  } catch {
    res.json(listBlueprints());
  }
});

// ─────────────────────────────────────────────────────────────
// POST /lojista/setup — ativa segmento no estabelecimento (lê do banco)
// ─────────────────────────────────────────────────────────────
router.post('/setup', async (req, res) => {
  const { vertical_slug } = req.body;
  if (!vertical_slug) return res.status(400).json({ error: 'vertical_slug obrigatório.' });

  const estId = getEstId(req);

  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });

  try {
    // Busca segmento no banco; fallback para blueprint hardcoded se não encontrar
    const segRes = await pool.query(
      `SELECT * FROM segments WHERE slug = $1 AND ativo = true LIMIT 1`, [vertical_slug]
    );
    let seg: any;
    if (segRes.rows.length > 0) {
      seg = segRes.rows[0];
    } else {
      try {
        const bp = getBlueprint(vertical_slug);
        seg = { ...bp, features: bp.features, business_config: bp.business_config, servicos_padrao: bp.servicos_padrao };
      } catch {
        return res.status(400).json({ error: `Segmento inválido: ${vertical_slug}` });
      }
    }

    // Atualiza estabelecimento
    await pool.query(
      `UPDATE establishments SET
         vertical_slug=$1, active_features=$2, business_config=$3,
         cor_primaria=$4, cor_destaque=$5, setup_done=true,
         is_public=true, is_active=true, updated_at=NOW()
       WHERE id=$6`,
      [seg.slug, JSON.stringify(seg.features), JSON.stringify(seg.business_config),
       seg.cor_primaria, seg.cor_destaque, estId]
    );

    // Recria serviços padrão
    await pool.query(`DELETE FROM agenda_servicos WHERE establishment_id=$1`, [estId]);
    const servicos: any[] = seg.servicos_padrao || [];
    for (const s of servicos) {
      await pool.query(
        `INSERT INTO agenda_servicos (establishment_id, nome, categoria, duracao_minutos, preco, ordem)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [estId, s.nome, s.categoria, s.duracao_minutos, s.preco, s.ordem]
      );
    }

    res.json({
      success: true,
      vertical_slug: seg.slug,
      features: seg.features,
      servicos_criados: servicos.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /lojista/me — dados do estabelecimento + blueprint ativo
// ─────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const estId = getEstId(req);

  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });

  try {
    // Busca colunas base (sempre existem)
    const result = await pool.query(
      `SELECT id, name, slug, vertical_slug, active_features, business_config,
              setup_done, cor_primaria, cor_destaque, description, category,
              city, phone, is_public, logo_url, cover_url,
              asaas_api_key, asaas_wallet_id,
              pix_key_type, pix_key_value, pix_receiver_name,
              preferred_payment_method, mp_status,
              instagram_url, facebook_url, website_url, whatsapp_link,
              store_token
       FROM establishments WHERE id = $1`,
      [estId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });

    const establishment: Record<string, any> = result.rows[0];

    // Busca colunas opcionais individualmente (podem não existir ainda se a migração ainda não rodou)
    const optionalCols = ['logo_base64', 'favicon_base64', 'settings', 'niche_data', 'social_links'];
    for (const col of optionalCols) {
      try {
        const r = await pool.query(`SELECT ${col} FROM establishments WHERE id = $1`, [estId]);
        establishment[col] = r.rows[0]?.[col] ?? (col === 'settings' || col === 'niche_data' || col === 'social_links' ? {} : null);
      } catch {
        establishment[col] = (col === 'settings' || col === 'niche_data' || col === 'social_links') ? {} : null;
      }
    }

    // Descriptografa chaves sensíveis antes de enviar para o frontend
    for (const key in establishment) {
      if (isSensitiveKey(key) && typeof establishment[key] === 'string') {
        establishment[key] = decrypt(establishment[key]);
      }
    }

    res.json(establishment);
  } catch (err: any) {
    // Fallback total: retorna só o básico para não quebrar o painel
    try {
      const basic = await pool.query(`SELECT id, name, slug FROM establishments WHERE id = $1`, [estId]);
      if (!basic.rows.length) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
      res.json({ ...basic.rows[0], setup_done: false, active_features: [], vertical_slug: 'generico', settings: {}, niche_data: {}, social_links: {} });
    } catch (e2: any) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────
// POST /lojista/assistente/dica — Ágata contextual: dica sobre um campo
// ─────────────────────────────────────────────────────────────
router.post('/assistente/dica', async (req, res) => {
  const { modulo, campo, segmento } = req.body as { modulo: string; campo: string; segmento?: string };
  if (!modulo || !campo) return res.status(400).json({ error: 'modulo e campo são obrigatórios.' });
  try {
    const cfg = await loadAIConfig();
    const seg = segmento || 'negócio';
    const result = await askAI(cfg, [
      {
        role: 'system',
        content: `Você é a Ágata, assistente inteligente da plataforma AG-ON para gestão de negócios.
Responda SEMPRE em português brasileiro. Seja direta, prática e encorajadora.
Suas dicas devem ter no máximo 2 frases curtas. Não use markdown, asteriscos ou emojis.
Fale diretamente com o lojista usando "você".`,
      },
      {
        role: 'user',
        content: `O lojista tem um(a) ${seg} e está preenchendo o campo "${campo}" no módulo "${modulo}". Dê uma dica prática e objetiva sobre como preencher esse campo corretamente.`,
      },
    ], 120);
    res.json({ dica: result.response || 'Preencha este campo com atenção. Em caso de dúvida, consulte o suporte.' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// GET /lojista/onboarding-status — Checklist de configuração inicial
// ─────────────────────────────────────────────────────────────
router.get('/onboarding-status', async (req, res) => {
  const estId = getEstId(req);
  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });
  try {
    const [servico, profissional, horario, wa, categoria, produto, zona, plano_gym, aluno_gym, agendamento, pedido] = await Promise.all([
      pool.query(`SELECT 1 FROM agenda_servicos WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM agenda_profissionais WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM business_hours WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM whatsapp_configs WHERE establishment_id=$1 AND instance_name IS NOT NULL AND instance_name <> '' LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM categories WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM catalog_items WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM delivery_zones WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM products WHERE establishment_id=$1 AND type='plan' AND active=true LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM gym_clients WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM agenda_agendamentos WHERE establishment_id=$1 LIMIT 1`, [estId]),
      pool.query(`SELECT 1 FROM delivery_orders WHERE establishment_id=$1 LIMIT 1`, [estId]),
    ]);
    res.json({
      tem_servico:      servico.rows.length > 0,
      tem_profissional: profissional.rows.length > 0,
      tem_horario:      horario.rows.length > 0,
      tem_whatsapp:     wa.rows.length > 0,
      tem_categoria:    categoria.rows.length > 0,
      tem_produto:      produto.rows.length > 0,
      tem_zona_entrega: zona.rows.length > 0,
      tem_plano_gym:    plano_gym.rows.length > 0,
      tem_aluno_gym:    aluno_gym.rows.length > 0,
      tem_agendamento:  agendamento.rows.length > 0,
      tem_pedido:       pedido.rows.length > 0,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// PUT /lojista/setup/settings — Atualiza configs globais e nicho
// ─────────────────────────────────────────────────────────────
router.put('/setup/settings', async (req, res) => {
  const estId = getEstId(req);

  if (!estId) return res.status(400).json({ error: 'establishment_id necessário.' });

  const {
    settings, niche_data, business_config, name,
    asaas_api_key, asaas_wallet_id,
    pix_key_type, pix_key_value, pix_receiver_name,
    preferred_payment_method,
    instagram_url, facebook_url, website_url, whatsapp_link,
    logo_base64, favicon_base64, social_links,
    custom_domain
  } = req.body;

  // Validação rígida de tamanho de imagem no backend
  if (logo_base64 && logo_base64.length > 200000) {
      return res.status(413).json({ error: 'A imagem é muito grande para o servidor.' });
  }
  if (favicon_base64 && favicon_base64.length > 100000) {
      return res.status(413).json({ error: 'Favicon muito grande. Máximo 64KB.' });
  }

  try {
    const fields: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (name !== undefined) {
      fields.push(`name = $${i++}`);
      vals.push(name);
    }
    if (settings !== undefined) {
      fields.push(`settings = $${i++}`);
      vals.push(JSON.stringify(settings));
    }
    if (niche_data !== undefined) {
      fields.push(`niche_data = $${i++}`);
      vals.push(JSON.stringify(niche_data));
    }

    // Novos campos Triple-Play Finance
    if (asaas_api_key !== undefined) { fields.push(`asaas_api_key = $${i++}`); vals.push(encrypt(asaas_api_key)); }
    if (asaas_wallet_id !== undefined) { fields.push(`asaas_wallet_id = $${i++}`); vals.push(asaas_wallet_id); }
    if (pix_key_type !== undefined) { fields.push(`pix_key_type = $${i++}`); vals.push(pix_key_type); }
    if (pix_key_value !== undefined) { fields.push(`pix_key_value = $${i++}`); vals.push(encrypt(pix_key_value)); }
    if (pix_receiver_name !== undefined) { fields.push(`pix_receiver_name = $${i++}`); vals.push(pix_receiver_name); }
    if (preferred_payment_method !== undefined) { fields.push(`preferred_payment_method = $${i++}`); vals.push(preferred_payment_method); }
    if (instagram_url !== undefined) { fields.push(`instagram_url = $${i++}`); vals.push(instagram_url); }
    if (facebook_url !== undefined) { fields.push(`facebook_url = $${i++}`); vals.push(facebook_url); }
    if (website_url !== undefined) { fields.push(`website_url = $${i++}`); vals.push(website_url); }
    if (whatsapp_link !== undefined) { fields.push(`whatsapp_link = $${i++}`); vals.push(whatsapp_link); }
    if (logo_base64 !== undefined) { fields.push(`logo_base64 = $${i++}`); vals.push(logo_base64 || null); }
    if (favicon_base64 !== undefined) { fields.push(`favicon_base64 = $${i++}`); vals.push(favicon_base64 || null); }
    if (social_links !== undefined) { fields.push(`social_links = $${i++}`); vals.push(JSON.stringify(social_links)); }
    if (business_config !== undefined) { fields.push(`business_config = $${i++}`); vals.push(JSON.stringify(business_config)); }
    // White-label (Fase 4): domínio próprio da empresa (ex: www.lojadocliente.com.br).
    // Normaliza pra minúsculo e sem espaços — tenantResolver.ts compara host em lowercase.
    if (custom_domain !== undefined) {
      fields.push(`custom_domain = $${i++}`);
      vals.push(custom_domain ? String(custom_domain).trim().toLowerCase() : null);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar.' });

    fields.push(`updated_at = NOW()`);
    vals.push(estId);

    const result = await pool.query(
      `UPDATE establishments SET ${fields.join(', ')} WHERE id = $${i} RETURNING id`,
      vals
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });

    // custom_domain mudou → invalida o cache de resolução por host (senão o
    // domínio antigo/novo pode ficar até 30s desatualizado, ver tenantResolver.ts)
    if (custom_domain !== undefined) invalidateTenantHostCache();

    // Identifica o que mudou para logar de forma descritiva
    const changed: string[] = [];
    if (name !== undefined) changed.push('nome');
    if (favicon_base64 !== undefined) changed.push('favicon');
    if (logo_base64 !== undefined) changed.push('logo');
    if (settings !== undefined && settings.banners !== undefined) changed.push('banners');
    if (instagram_url !== undefined || facebook_url !== undefined || website_url !== undefined) changed.push('redes sociais');
    if (asaas_api_key !== undefined || pix_key_value !== undefined) changed.push('financeiro');
    if (changed.length > 0) {
      // Busca nome da loja para o log
      pool.query(`SELECT name FROM establishments WHERE id = $1`, [estId])
        .then(r => {
          logActivity({
            type: 'LOJISTA_SETTINGS',
            actor_role: req.user!.role,
            actor_id: estId,
            establishment_id: estId,
            establishment_name: r.rows[0]?.name || estId,
            description: `Loja "${r.rows[0]?.name || estId}" atualizou: ${changed.join(', ')}`,
            metadata: { fields: changed },
          });
        }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err: any) {
    if (err.code === '23505' && err.constraint === 'idx_establishments_custom_domain') {
      return res.status(409).json({ error: 'Este domínio já está em uso por outra empresa.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// WHATSAPP AUTOMATION ROUTES (Bot & IA Configs)
// ─────────────────────────────────────────────────────────────

router.get('/whatsapp/config', async (req, res) => {
    const estId = getEstId(req);
    try {
        // Garante que existe config
        await pool.query(`INSERT INTO whatsapp_configs (establishment_id) VALUES ($1) ON CONFLICT DO NOTHING`, [estId]);
        const result = await pool.query(`SELECT * FROM whatsapp_configs WHERE establishment_id = $1`, [estId]);
        const config = result.rows[0];
        // Descriptografa token antes de enviar ao frontend
        if (config && config.custom_api_token) {
            config.custom_api_token = decrypt(config.custom_api_token);
        }
        res.json(config);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/whatsapp/config', async (req, res) => {
    const estId = getEstId(req);
    const {
        welcome_message, delay_min, delay_max, typing_effect, enable_ai,
        // API de envio
        api_type, custom_api_url, custom_api_token, instance_name,
        // Templates de mensagem customizados
        msg_new_order, msg_confirmed, msg_preparing, msg_delivering,
        msg_ready_delivery, msg_ready_pickup, msg_delivered, msg_cancelled,
    } = req.body;
    try {
        await pool.query(
            `UPDATE whatsapp_configs SET
                welcome_message    = $1,
                delay_min          = $2,
                delay_max          = $3,
                typing_effect      = $4,
                enable_ai          = $5,
                api_type           = $6,
                custom_api_url     = $7,
                custom_api_token   = $8,
                instance_name      = $9,
                msg_new_order      = $10,
                msg_confirmed      = $11,
                msg_preparing      = $12,
                msg_delivering     = $13,
                msg_ready_delivery = $14,
                msg_ready_pickup   = $15,
                msg_delivered      = $16,
                msg_cancelled      = $17,
                updated_at         = NOW()
             WHERE establishment_id = $18`,
            [
                welcome_message, delay_min, delay_max, typing_effect, enable_ai,
                api_type || 'evolution',
                custom_api_url   || null,
                custom_api_token ? encrypt(custom_api_token) : null,
                instance_name    || null,
                msg_new_order      || null,
                msg_confirmed      || null,
                msg_preparing      || null,
                msg_delivering     || null,
                msg_ready_delivery || null,
                msg_ready_pickup   || null,
                msg_delivered      || null,
                msg_cancelled      || null,
                estId,
            ]
        );
        // Invalida cache para que o próximo envio use as novas configs
        invalidateWAConfigCache(estId);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// GET /lojista/whatsapp/status-templates
router.get('/whatsapp/status-templates', async (req, res) => {
    const estId = getEstId(req);
    try {
        await pool.query(`INSERT INTO whatsapp_configs (establishment_id) VALUES ($1) ON CONFLICT DO NOTHING`, [estId]);
        const r = await pool.query(
            `SELECT msg_new_order, msg_confirmed, msg_preparing, msg_delivering,
                    msg_ready_delivery, msg_ready_pickup, msg_delivered, msg_cancelled
             FROM whatsapp_configs WHERE establishment_id=$1`, [estId]
        );
        res.json(r.rows[0] || {});
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT /lojista/whatsapp/status-templates
router.put('/whatsapp/status-templates', async (req, res) => {
    const estId = getEstId(req);
    const { msg_new_order, msg_confirmed, msg_preparing, msg_delivering,
            msg_ready_delivery, msg_ready_pickup, msg_delivered, msg_cancelled } = req.body;
    try {
        await pool.query(
            `UPDATE whatsapp_configs SET
                msg_new_order=$1, msg_confirmed=$2, msg_preparing=$3, msg_delivering=$4,
                msg_ready_delivery=$5, msg_ready_pickup=$6, msg_delivered=$7, msg_cancelled=$8,
                updated_at=NOW()
             WHERE establishment_id=$9`,
            [msg_new_order||null, msg_confirmed||null, msg_preparing||null, msg_delivering||null,
             msg_ready_delivery||null, msg_ready_pickup||null, msg_delivered||null, msg_cancelled||null, estId]
        );
        invalidateWAConfigCache(estId);
        res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /lojista/whatsapp/toggle-ai — liga ou desliga atendimento por IA
// Body opcional: { enable_ai: boolean } → define valor explícito; sem body → inverte
router.patch('/whatsapp/toggle-ai', async (req, res) => {
    const estId = getEstId(req);
    try {
        await pool.query(
            `INSERT INTO whatsapp_configs (establishment_id) VALUES ($1) ON CONFLICT DO NOTHING`,
            [estId]
        );
        let result;
        if (typeof req.body?.enable_ai === 'boolean') {
            result = await pool.query(
                `UPDATE whatsapp_configs SET enable_ai = $2, updated_at = NOW() WHERE establishment_id = $1 RETURNING enable_ai`,
                [estId, req.body.enable_ai]
            );
        } else {
            result = await pool.query(
                `UPDATE whatsapp_configs SET enable_ai = NOT enable_ai, updated_at = NOW() WHERE establishment_id = $1 RETURNING enable_ai`,
                [estId]
            );
        }
        const enable_ai = result.rows[0]?.enable_ai ?? false;
        console.log(`🤖 IA ${enable_ai ? 'LIGADA' : 'DESLIGADA'} para est ${estId}`);
        res.json({ enable_ai, message: enable_ai ? 'Atendimento por IA ativado.' : 'Atendimento por IA desativado.' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Keywords / Flows CRUD
router.get('/whatsapp/flows', async (req, res) => {
    const estId = getEstId(req);
    try {
        const result = await pool.query(`SELECT * FROM whatsapp_flows WHERE establishment_id = $1 ORDER BY created_at DESC`, [estId]);
        res.json(result.rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/whatsapp/flows', async (req, res) => {
    const estId = getEstId(req);
    const { trigger_keyword, response_text, action_type } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO whatsapp_flows (establishment_id, trigger_keyword, response_text, action_type)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [estId, trigger_keyword, response_text, action_type || 'text']
        );
        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/whatsapp/flows/:id', async (req, res) => {
    const estId = getEstId(req);
    try {
        await pool.query(`DELETE FROM whatsapp_flows WHERE id = $1 AND establishment_id = $2`, [req.params.id, estId]);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// UNIVERSAL CATALOG ROUTES (Categories & Items)
// ─────────────────────────────────────────────────────────────

router.get('/catalog/categories', async (req, res) => {
    const estId = getEstId(req);
    try {
        const result = await pool.query(
            `SELECT * FROM categories WHERE establishment_id = $1 ORDER BY order_index ASC, name ASC`, 
            [estId]
        );
        res.json(result.rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/catalog/categories', async (req, res) => {
    const estId = getEstId(req);
    const { name, order_index } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome da categoria obrigatório.' });
    try {
        const result = await pool.query(
            `INSERT INTO categories (establishment_id, name, order_index) VALUES ($1, $2, $3) RETURNING *`,
            [estId, name, order_index || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/catalog/categories/:id', async (req, res) => {
    const estId = getEstId(req);
    try {
        await pool.query(`DELETE FROM categories WHERE id = $1 AND establishment_id = $2`, [req.params.id, estId]);
        res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/catalog/items', async (req, res) => {
    const estId = getEstId(req);
    try {
        const result = await pool.query(
            `SELECT i.*, c.name as category_name 
             FROM catalog_items i 
             LEFT JOIN categories c ON c.id = i.category_id 
             WHERE i.establishment_id = $1 
             ORDER BY c.order_index ASC, i.name ASC`, 
            [estId]
        );
        res.json(result.rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/catalog/items', async (req, res) => {
    const estId = getEstId(req);
    const { category_id, type, name, description, price, image_base64, is_active, recurrence, billing_period, duration_minutes } = req.body;
    
    if (!name || price === undefined || !type) return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    if (image_base64 && image_base64.length > 2800000) return res.status(413).json({ error: 'A imagem é muito grande (Max 2MB).' });

    try {
        const result = await pool.query(
            `INSERT INTO catalog_items 
             (establishment_id, category_id, type, name, description, price, image_base64, is_active, recurrence, billing_period, duration_minutes) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [estId, category_id || null, type, name, description || null, price, image_base64 || null, 
             is_active !== false, recurrence || null, billing_period || null, duration_minutes || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/catalog/items/:id', async (req, res) => {
    const estId = getEstId(req);
    const { category_id, type, name, description, price, image_base64, is_active, recurrence, billing_period, duration_minutes } = req.body;
    
    if (image_base64 && image_base64.length > 2800000) return res.status(413).json({ error: 'A imagem é muito grande (Max 2MB).' });

    try {
        const result = await pool.query(
            `UPDATE catalog_items SET 
             category_id=$1, type=$2, name=$3, description=$4, price=$5, image_base64=$6, 
             is_active=$7, recurrence=$8, billing_period=$9, duration_minutes=$10, updated_at=NOW()
             WHERE id=$11 AND establishment_id=$12 RETURNING *`,
            [category_id || null, type, name, description || null, price, image_base64 || null, 
             is_active !== false, recurrence || null, billing_period || null, duration_minutes || null, req.params.id, estId]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Item não encontrado.' });
        res.json(result.rows[0]);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/catalog/items/:id', async (req, res) => {
    const estId = getEstId(req);
    try {
        await pool.query(`DELETE FROM catalog_items WHERE id = $1 AND establishment_id = $2`, [req.params.id, estId]);
        res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// Helpers compartilhados de Evolution API
// ─────────────────────────────────────────────────────────────

async function setEvolutionWebhook(evoUrl: string, evoToken: string, instanceName: string): Promise<void> {
    const webhookUrl = `${process.env.BASE_URL || 'https://ag-on.com'}/webhooks/evolution`;
    try {
        const res = await fetch(`${evoUrl}/webhook/set/${instanceName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: evoToken },
            body: JSON.stringify({
                webhook: {
                    enabled: true,
                    url: webhookUrl,
                    webhookByEvents: false,
                    webhookBase64: false,
                    events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'MESSAGES_UPDATE'],
                }
            })
        });
        console.log(`[WA webhook] configurado em ${instanceName} → ${webhookUrl} (HTTP ${res.status})`);
    } catch (err: any) {
        console.error('[WA webhook] falha ao configurar:', err.message);
    }
}

async function getPlatformEvolutionConfig(): Promise<{ url: string; token: string } | null> {
    const r = await pool.query(
        `SELECT key, value FROM global_settings WHERE key IN ('evolution_url','evolution_token')`
    );
    const cfg: Record<string, string> = {};
    // evolution_token é salvo criptografado (isSensitiveKey = contém "token")
    for (const row of r.rows) {
        cfg[row.key] = isSensitiveKey(row.key) ? decrypt(row.value) : row.value;
    }
    if (!cfg.evolution_url || !cfg.evolution_token) return null;
    return { url: cfg.evolution_url.replace(/\/$/, ''), token: cfg.evolution_token };
}

// Extrai base64 de QR de múltiplos formatos de resposta da Evolution API
function extractQR(data: any): string | null {
    if (!data) return null;
    // Normaliza: percorre todos os formatos conhecidos
    const b64 = data?.qrcode?.base64
        ?? data?.base64
        ?? (typeof data?.qrcode === 'string' ? data.qrcode : null);
    if (b64 && typeof b64 === 'string' && b64.length > 50) return b64;
    return null;
}

// Chama /instance/connect e retorna o QR em qualquer formato
async function fetchQRFromConnect(url: string, token: string, instanceName: string): Promise<string | null> {
    try {
        const r = await fetch(`${url}/instance/connect/${instanceName}`, {
            headers: { apikey: token }
        });
        const d: any = await r.json();
        console.log(`[WA fetchQR connect] HTTP=${r.status}`, JSON.stringify(d).slice(0, 500));
        return extractQR(d);
    } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// GET /lojista/whatsapp/platform-status
// Verifica / cria instância na API da plataforma e retorna status + QR se desconectado.
// ─────────────────────────────────────────────────────────────
router.get('/whatsapp/platform-status', async (req, res) => {
    const estId = getEstId(req);
    const isDebug = req.query.debug === '1';
    const config = await getPlatformEvolutionConfig();
    const debugLog: any[] = [];

    if (!config) {
        return res.status(501).json({ error: 'API da plataforma não configurada. Contate o suporte.' });
    }

    // Nome curto: evita hífens e comprimento excessivo
    const instanceName = `agon${estId.replace(/-/g, '').slice(0, 16)}`;

    // Persiste o nome da instância no banco para uso no envio de mensagens
    await pool.query(
        `INSERT INTO whatsapp_configs (establishment_id, instance_name, api_type)
         VALUES ($1, $2, 'platform')
         ON CONFLICT (establishment_id) DO UPDATE SET instance_name=$2, api_type='platform'`,
        [estId, instanceName]
    ).catch(() => {});

    try {
        // 1. Verifica estado atual
        const checkRes = await fetch(`${config.url}/instance/connectionState/${instanceName}`, {
            headers: { apikey: config.token }
        });
        const checkText = await checkRes.text();
        let checkData: any = {};
        try { checkData = JSON.parse(checkText); } catch { /* ignora */ }

        const state: string = checkData?.instance?.state ?? checkData?.state ?? '';
        console.log(`[WA platform-status] ${instanceName} HTTP=${checkRes.status} state="${state}" raw=${checkText.slice(0, 200)}`);
        if (isDebug) debugLog.push({ step: 'connectionState', http: checkRes.status, state, raw: checkData });

        // Instância não existe → cria
        const notFound = checkRes.status === 404
            || (typeof checkData?.message === 'string' && checkData.message.toLowerCase().includes('not found'))
            || (typeof checkData?.error === 'string'   && checkData.error.toLowerCase().includes('not found'));

        if (notFound) {
            const createRes = await fetch(`${config.url}/instance/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: config.token },
                body: JSON.stringify({ instanceName, integration: 'WHATSAPP-BAILEYS', qrcode: true })
            });
            const createData: any = await createRes.json();
            console.log(`[WA platform-status] create HTTP=${createRes.status}`, JSON.stringify(createData).slice(0, 500));
            if (isDebug) debugLog.push({ step: 'create', http: createRes.status, raw: createData });

            // Configura webhook imediatamente após criar
            await setEvolutionWebhook(config.url, config.token, instanceName);

            let qrcode = extractQR(createData);

            if (!qrcode) {
                // Evolution cria a instância mas QR vem apenas em /connect
                const connectRes = await fetch(`${config.url}/instance/connect/${instanceName}`, {
                    headers: { apikey: config.token }
                });
                const connectData: any = await connectRes.json();
                console.log(`[WA platform-status] connect HTTP=${connectRes.status}`, JSON.stringify(connectData).slice(0, 500));
                if (isDebug) debugLog.push({ step: 'connect_after_create', http: connectRes.status, raw: connectData });
                qrcode = extractQR(connectData);
            }

            if (isDebug) return res.json({ connected: false, qrcode, instanceName, debug: debugLog });
            return res.json({ connected: false, qrcode });
        }

        // Instância existe e conectada
        if (state === 'open') {
            // Garante que o webhook está configurado (pode ter sido perdido em restart)
            await setEvolutionWebhook(config.url, config.token, instanceName);
            const number = checkData?.instance?.ownerJid ?? checkData?.instance?.profileName ?? null;
            if (isDebug) return res.json({ connected: true, number, instanceName, debug: debugLog });
            return res.json({ connected: true, number });
        }

        // Instância existe mas não conectada → pega QR
        const connectRes = await fetch(`${config.url}/instance/connect/${instanceName}`, {
            headers: { apikey: config.token }
        });
        const connectData: any = await connectRes.json();
        console.log(`[WA platform-status] connect HTTP=${connectRes.status}`, JSON.stringify(connectData).slice(0, 500));
        if (isDebug) debugLog.push({ step: 'connect', http: connectRes.status, raw: connectData });

        const qrcode = extractQR(connectData);
        if (isDebug) return res.json({ connected: false, qrcode, instanceName, state, debug: debugLog });
        return res.json({ connected: false, qrcode });

    } catch (err: any) {
        console.error('[WA platform-status]', err.message);
        if (isDebug) return res.status(500).json({ error: err.message, instanceName, debug: debugLog });
        res.status(500).json({ error: `Erro ao comunicar com a API da plataforma: ${err.message}` });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /lojista/whatsapp/platform-disconnect
// ─────────────────────────────────────────────────────────────
router.post('/whatsapp/platform-disconnect', async (req, res) => {
    const estId = getEstId(req);
    const config = await getPlatformEvolutionConfig();
    if (!config) return res.status(501).json({ error: 'API da plataforma não configurada.' });

    const instanceName = `agon${estId.replace(/-/g, '').slice(0, 16)}`;
    try {
        await fetch(`${config.url}/instance/logout/${instanceName}`, {
            method: 'DELETE',
            headers: { apikey: config.token }
        });
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /lojista/whatsapp/test
// Testa credenciais próprias (body) ou salvas. Não cria instâncias, não gera QR.
// ─────────────────────────────────────────────────────────────
router.post('/whatsapp/test', async (req, res) => {
    const estId = getEstId(req);
    try {
        let { api_url, api_token, instance_name } = req.body;

        if (!api_url || !api_token || !instance_name) {
            const cfg = await pool.query(
                `SELECT custom_api_url, custom_api_token, instance_name FROM whatsapp_configs WHERE establishment_id = $1`,
                [estId]
            );
            const saved = cfg.rows[0];
            api_url       = api_url       || saved?.custom_api_url;
            api_token     = api_token     || saved?.custom_api_token;
            instance_name = instance_name || saved?.instance_name;
        }

        if (!api_url || !api_token || !instance_name) {
            return res.status(400).json({ error: 'Informe URL, token e nome da instância.' });
        }

        const url = (api_url as string).replace(/\/$/, '');
        const checkRes = await fetch(`${url}/instance/connectionState/${instance_name}`, {
            headers: { apikey: api_token as string }
        });

        if (!checkRes.ok) {
            const body = await checkRes.text();
            return res.status(checkRes.status).json({
                connected: false,
                error: `API retornou ${checkRes.status}: ${body.slice(0, 200)}`
            });
        }

        const data: any = await checkRes.json();
        const state = data?.instance?.state ?? data?.state;
        const connected = state === 'open';
        const number = data?.instance?.ownerJid ?? data?.instance?.profileName ?? null;

        return res.json({ connected, state, number });
    } catch (err: any) {
        console.error('[WA test]', err.message);
        res.status(500).json({ connected: false, error: 'Não foi possível alcançar a API informada.' });
    }
});

export default router;
