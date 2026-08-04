/**
 * LANDING PAGES POR MÓDULO — AguiaON (Fase 16)
 *
 * Implementa a ideia guardada no roadmap ("Landing Page Mãe + landings por
 * módulo"): cada vertical (Rastreamento, Delivery, Agenda...) pode ganhar
 * uma landing de marketing própria, editável pelo SuperAdmin com campos
 * prontos (não é um editor HTML livre), publicável em dois formatos à
 * escolha — caminho no domínio raiz (aguiaon.com/rastreamento) ou
 * subdomínio próprio (rastreamento.aguiaon.com).
 *
 * Uma linha por vertical_slug (UNIQUE) — se no futuro fizer sentido ter mais
 * de uma landing pro mesmo módulo (ex: uma campanha A/B), essa tabela
 * precisa evoluir; pra essa primeira fatia, um módulo tem uma landing só.
 */
import { Router, Request } from 'express';
import pool from '../shared/db';
import { requireAdmin } from '../shared/authMiddleware';
import { listBlueprints } from '../verticals/blueprints';
import { extractSubdomainSlug } from '../shared/tenantResolver';

const router = Router();

// ── Migração (executa na inicialização, mesmo padrão dos outros módulos) ──
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vertical_landings (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vertical_slug     TEXT UNIQUE NOT NULL,
        published         BOOLEAN NOT NULL DEFAULT false,
        domain_mode       TEXT NOT NULL DEFAULT 'path' CHECK (domain_mode IN ('path','subdomain')),
        domain_value      TEXT NOT NULL,
        headline          TEXT,
        subheadline       TEXT,
        hero_video_url    TEXT,
        hero_image_url    TEXT,
        benefits          JSONB NOT NULL DEFAULT '[]'::jsonb,
        steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
        cta_label         TEXT NOT NULL DEFAULT 'Falar no WhatsApp',
        cta_type          TEXT NOT NULL DEFAULT 'whatsapp' CHECK (cta_type IN ('whatsapp','marketplace','pwa_install','custom_url')),
        cta_whatsapp      TEXT,
        cta_url           TEXT,
        seo_title         TEXT,
        seo_description   TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Impede duas landings publicadas disputando o mesmo endereço (dá pra ter
    // rascunhos duplicados de domain_value à vontade, só não publicados).
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vertical_landings_domain
        ON vertical_landings(domain_mode, domain_value) WHERE published = true
    `);
  } catch (e: any) {
    console.error('[landings migration]', e.message);
  }
})();

// ─────────────────────────────────────────────────────────────
// Resolução por Host+path — usada tanto pelo servidor (decidir se serve
// landing.html no lugar de vitrine.html/marketplace) quanto pelo próprio
// landing.html (saber qual conteúdo buscar). Nunca disputa espaço com uma
// loja real: se `req.tenant` já foi resolvido (Fase 4, white-label), a
// landing nem é consultada.
// ─────────────────────────────────────────────────────────────
export async function resolveVerticalLanding(req: Request): Promise<any | null> {
  if (req.tenant) return null;

  const host = (req.headers.host || '').split(':')[0].toLowerCase().trim();
  const baseDomain = (process.env.PLATFORM_BASE_DOMAIN || '').toLowerCase().trim();

  try {
    // 1. Subdomínio (ex: rastreamento.aguiaon.com) — só faz sentido na raiz.
    const subSlug = extractSubdomainSlug(host, baseDomain);
    if (subSlug) {
      const r = await pool.query(
        `SELECT * FROM vertical_landings WHERE domain_mode='subdomain' AND domain_value=$1 AND published=true`,
        [subSlug]
      );
      return r.rows[0] || null;
    }

    // 2. Caminho no domínio raiz (ex: aguiaon.com/rastreamento).
    const pathSlug = (req.path || '').replace(/^\/+/, '').split('/')[0];
    if (!pathSlug) return null;
    const r = await pool.query(
      `SELECT * FROM vertical_landings WHERE domain_mode='path' AND domain_value=$1 AND published=true`,
      [pathSlug]
    );
    return r.rows[0] || null;
  } catch (err: any) {
    console.error('[landings] falha ao resolver por host:', err.message);
    return null;
  }
}

// GET /public/landing/resolve — usada pelo landing.html no carregamento.
// Reaproveita a mesma lógica de resolução por Host+path do servidor, então
// a landing "sabe" qual conteúdo mostrar sem precisar de template engine.
router.get('/public/landing/resolve', async (req, res) => {
  try {
    const landing = await resolveVerticalLanding(req);
    if (!landing) return res.status(404).json({ error: 'Nenhuma landing publicada nesse endereço.' });
    res.json(landing);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /public/landing/preview/:vertical_slug — pré-visualização pro
// SuperAdmin ver o rascunho antes de publicar (não exige `published=true`).
router.get('/public/landing/preview/:vertical_slug', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM vertical_landings WHERE vertical_slug=$1`, [req.params.vertical_slug]);
    if (!r.rows.length) return res.status(404).json({ error: 'Landing ainda não criada pra esse módulo.' });
    res.json(r.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/landings — lista todo módulo (do blueprint) com a landing dele,
// se já existir (LEFT JOIN em código — mais simples que SQL dinâmico aqui).
router.get('/admin/landings', requireAdmin, async (_req, res) => {
  try {
    const blueprints = listBlueprints();
    const rows = await pool.query(`SELECT * FROM vertical_landings`);
    const bySlug: Record<string, any> = {};
    rows.rows.forEach((r: any) => { bySlug[r.vertical_slug] = r; });

    res.json(blueprints.map((bp: any) => ({
      vertical_slug: bp.slug,
      vertical_label: bp.label,
      vertical_icon: bp.icon,
      landing: bySlug[bp.slug] || null,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/landings/:vertical_slug — cria ou atualiza (upsert) a landing
// de um módulo. Validações: domain_value obrigatório se for publicar, e não
// pode colidir com o slug de uma loja real já cadastrada (senão a landing
// rouba o endereço da vitrine daquela loja) — nem em modo path nem subdomínio,
// já que os dois competem pelo mesmo espaço de nomes de `establishments.slug`.
router.put('/admin/landings/:vertical_slug', requireAdmin, async (req, res) => {
  try {
    const verticalSlug = req.params.vertical_slug;
    const {
      published, domain_mode, domain_value, headline, subheadline,
      hero_video_url, hero_image_url, benefits, steps,
      cta_label, cta_type, cta_whatsapp, cta_url,
      seo_title, seo_description,
    } = req.body;

    const mode = domain_mode === 'subdomain' ? 'subdomain' : 'path';
    const value = (domain_value || '').toLowerCase().trim().replace(/^\/+|\/+$/g, '');

    if (published && !value) {
      return res.status(400).json({ error: 'Informe o endereço (caminho ou subdomínio) antes de publicar.' });
    }
    if (value) {
      const collision = await pool.query(`SELECT 1 FROM establishments WHERE slug=$1`, [value]);
      if (collision.rows.length) {
        return res.status(409).json({ error: `Esse endereço ("${value}") já é usado por uma loja cadastrada — escolha outro.` });
      }
    }

    const r = await pool.query(
      `INSERT INTO vertical_landings
         (vertical_slug, published, domain_mode, domain_value, headline, subheadline,
          hero_video_url, hero_image_url, benefits, steps, cta_label, cta_type,
          cta_whatsapp, cta_url, seo_title, seo_description, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (vertical_slug) DO UPDATE SET
         published=$2, domain_mode=$3, domain_value=$4, headline=$5, subheadline=$6,
         hero_video_url=$7, hero_image_url=$8, benefits=$9, steps=$10, cta_label=$11,
         cta_type=$12, cta_whatsapp=$13, cta_url=$14, seo_title=$15, seo_description=$16,
         updated_at=NOW()
       RETURNING *`,
      [
        verticalSlug, !!published, mode, value, headline || null, subheadline || null,
        hero_video_url || null, hero_image_url || null,
        JSON.stringify(benefits || []), JSON.stringify(steps || []),
        cta_label || 'Falar no WhatsApp', cta_type || 'whatsapp',
        cta_whatsapp || null, cta_url || null, seo_title || null, seo_description || null,
      ]
    );
    res.json(r.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Esse endereço já está em uso por outra landing publicada.' });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
