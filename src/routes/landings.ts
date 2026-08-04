/**
 * LANDING PAGES POR MÓDULO — AguiaON (Fase 16 + Fase 17)
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
 *
 * Fase 17 — conteúdo dinâmico por blocos: a primeira versão (Fase 16) tinha
 * campos fixos (um hero, uma lista de benefícios, uma de passos, um CTA).
 * O Carlos achou "engessado" — cada módulo precisa da própria identidade
 * (planos, recursos, depoimentos, FAQ), em qualquer ordem. A partir daqui o
 * conteúdo vira uma lista ordenada de blocos (`blocks`, JSONB), cada um com
 * um `type` (hero/benefits/steps/planos/recursos/depoimentos/faq/cta) e os
 * campos próprios daquele tipo — ainda "campos prontos", só que modular em
 * vez de um template fixo. As colunas antigas (`headline`, `benefits` etc.)
 * continuam no banco por segurança (nenhuma linha real usava ainda), mas o
 * código não lê/escreve mais nelas.
 *
 * Também nasce aqui o fluxo "Contratar" (Fase 17): quando o CTA de um bloco
 * é do tipo `contratar` (inclusive o botão de cada plano dentro do bloco de
 * Planos), abre um formulário de lead que gera um contrato a partir de
 * `contract_template` (texto com placeholders tipo {{nome}}) e registra um
 * aceite eletrônico simples (nome+CPF digitados, IP, user-agent, timestamp —
 * sem serviço externo de assinatura). O lead é sempre entre a AguiaON e um
 * possível novo lojista daquele módulo — não é o CRM de uma loja específica.
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

    // Fase 17 — conteúdo modular por blocos + template de contrato.
    await pool.query(`ALTER TABLE vertical_landings ADD COLUMN IF NOT EXISTS blocks JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE vertical_landings ADD COLUMN IF NOT EXISTS contract_template TEXT`);

    // Fase 17 — leads capturados no CTA "Contratar" de uma landing, com
    // aceite eletrônico do contrato (sem serviço externo de assinatura).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS landing_leads (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vertical_slug     TEXT NOT NULL,
        plano_nome        TEXT,
        plano_preco       NUMERIC(10,2),
        nome              TEXT NOT NULL,
        empresa           TEXT,
        whatsapp          TEXT,
        email             TEXT,
        cpf_cnpj          TEXT,
        status            TEXT NOT NULL DEFAULT 'novo' CHECK (status IN ('novo','aceito','convertido','cancelado')),
        contrato_texto    TEXT,
        aceite_nome       TEXT,
        aceite_cpf        TEXT,
        aceite_ip         TEXT,
        aceite_user_agent TEXT,
        aceite_em         TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_landing_leads_vertical ON landing_leads(vertical_slug)`);
  } catch (e: any) {
    console.error('[landings migration]', e.message);
  }
})();

// Preenche o template de contrato com os dados do lead. Placeholders
// suportados: {{nome}}, {{empresa}}, {{whatsapp}}, {{email}}, {{cpf_cnpj}},
// {{plano_nome}}, {{plano_preco}}, {{modulo}}, {{data}}.
function preencherContrato(template: string, dados: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => dados[key] ?? '');
}

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
    // OBS: quando quem chama é o próprio landing.html (via fetch em
    // /public/landing/resolve), req.path é sempre "/public/landing/resolve" —
    // não reflete a URL que o visitante realmente está vendo. Por isso o
    // client manda o path original em ?path=, e damos prioridade a ele.
    const rawPath = (typeof req.query.path === 'string' && req.query.path) ? req.query.path : req.path;
    const pathSlug = (rawPath || '').split('?')[0].replace(/^\/+/, '').split('/')[0];
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
      published, domain_mode, domain_value,
      blocks, contract_template,
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
         (vertical_slug, published, domain_mode, domain_value, blocks, contract_template,
          seo_title, seo_description, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (vertical_slug) DO UPDATE SET
         published=$2, domain_mode=$3, domain_value=$4, blocks=$5, contract_template=$6,
         seo_title=$7, seo_description=$8, updated_at=NOW()
       RETURNING *`,
      [
        verticalSlug, !!published, mode, value,
        JSON.stringify(blocks || []), contract_template || null,
        seo_title || null, seo_description || null,
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

// ─────────────────────────────────────────────────────────────
// LEADS — captura pelo CTA "Contratar" de uma landing + aceite eletrônico
// de contrato (Fase 17). Sempre um lead pra AguiaON (novo lojista em
// potencial daquele módulo), nunca o CRM de uma loja específica.
// ─────────────────────────────────────────────────────────────

// POST /public/landing/:vertical_slug/leads — cria o lead e já devolve o
// contrato preenchido (a partir do contract_template da landing), pronto
// pra tela de aceite mostrar antes de confirmar.
router.post('/public/landing/:vertical_slug/leads', async (req, res) => {
  try {
    const verticalSlug = req.params.vertical_slug;
    const { nome, empresa, whatsapp, email, cpf_cnpj, plano_nome, plano_preco } = req.body;
    if (!nome?.trim()) return res.status(400).json({ error: 'Informe seu nome.' });

    const landingRes = await pool.query(`SELECT contract_template FROM vertical_landings WHERE vertical_slug=$1`, [verticalSlug]);
    const template = landingRes.rows[0]?.contract_template || '';
    const bp = listBlueprints().find((b: any) => b.slug === verticalSlug);

    const contratoTexto = template ? preencherContrato(template, {
      nome: nome.trim(),
      empresa: empresa || '',
      whatsapp: whatsapp || '',
      email: email || '',
      cpf_cnpj: cpf_cnpj || '',
      plano_nome: plano_nome || '',
      plano_preco: plano_preco ? `R$ ${Number(plano_preco).toFixed(2)}` : '',
      modulo: bp?.label || verticalSlug,
      data: new Date().toLocaleDateString('pt-BR'),
    }) : '';

    const r = await pool.query(
      `INSERT INTO landing_leads
         (vertical_slug, plano_nome, plano_preco, nome, empresa, whatsapp, email, cpf_cnpj, contrato_texto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, contrato_texto`,
      [verticalSlug, plano_nome || null, plano_preco || null, nome.trim(), empresa || null, whatsapp || null, email || null, cpf_cnpj || null, contratoTexto]
    );
    res.status(201).json(r.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /public/landing/leads/:id/aceitar — aceite eletrônico simples: quem
// preencher precisa digitar o próprio nome + CPF de novo (mesmo padrão de
// "confirme seus dados" usado em aceites eletrônicos simples), e o servidor
// registra IP + user-agent + timestamp como evidência do aceite.
router.post('/public/landing/leads/:id/aceitar', async (req, res) => {
  try {
    const { aceite_nome, aceite_cpf } = req.body;
    if (!aceite_nome?.trim() || !aceite_cpf?.trim()) {
      return res.status(400).json({ error: 'Confirme seu nome completo e CPF pra aceitar o contrato.' });
    }
    const leadRes = await pool.query(`SELECT id, status FROM landing_leads WHERE id=$1`, [req.params.id]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    if (leadRes.rows[0].status !== 'novo') {
      return res.status(409).json({ error: 'Esse contrato já foi tratado antes.' });
    }

    const ip = (req.headers['x-forwarded-for'] as string || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    await pool.query(
      `UPDATE landing_leads SET
         status='aceito', aceite_nome=$1, aceite_cpf=$2, aceite_ip=$3, aceite_user_agent=$4, aceite_em=NOW(), updated_at=NOW()
       WHERE id=$5`,
      [aceite_nome.trim(), aceite_cpf.trim(), ip, req.headers['user-agent'] || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/landing-leads — lista pro painel do SuperAdmin (com filtros
// opcionais por módulo/status).
router.get('/admin/landing-leads', requireAdmin, async (req, res) => {
  try {
    const { vertical_slug, status } = req.query;
    const conds: string[] = [];
    const params: any[] = [];
    if (vertical_slug) { params.push(vertical_slug); conds.push(`vertical_slug=$${params.length}`); }
    if (status) { params.push(status); conds.push(`status=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM landing_leads ${where} ORDER BY created_at DESC`, params);
    res.json(r.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/landing-leads/:id/converter — marca o lead como convertido
// (ação manual). A criação da loja de verdade continua pelo fluxo já
// existente no painel (criar nova loja) — não automatizamos isso aqui pra
// não duplicar aquela lógica com dados parciais do formulário de lead
// (falta senha, cidade/estado etc. que o formulário de lead não coleta).
router.post('/admin/landing-leads/:id/converter', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE landing_leads SET status='convertido', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.json(r.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
