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
import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import pool from '../shared/db';
import { requireAdmin, requireAuth, requireRole, TokenPayload } from '../shared/authMiddleware';
import { listBlueprints } from '../verticals/blueprints';
import { extractSubdomainSlug } from '../shared/tenantResolver';
import { findOrCreateClienteUser, ensureTables as ensureAgendaTables } from './agenda/index';

const router = Router();

// Fase 17 (Fix 8) — módulos "serviço único" (uma loja só, gerenciando muitos
// clientes, em vez de multiloja) usam um comportamento diferente de conversão
// de lead e de edição de landing. Generalizado no Fix de produção 12: em vez
// de constantes com o slug fixo do Rastreamento, isso agora é um campo no
// blueprint (`modelo_negocio`, ver verticals/blueprints.ts) e a loja de cada
// módulo é achada dinamicamente por `vertical_slug` — ver `isServicoUnico()`
// mais abaixo.

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
    // Fix de produção 10 — número que recebe o "Continuar no WhatsApp" depois
    // do Termo de Adesão assinado (resumo pré-preenchido, pra evitar mandar
    // mensagem automática pelo número da AguiaON e correr risco de bloqueio).
    await pool.query(`ALTER TABLE vertical_landings ADD COLUMN IF NOT EXISTS contato_whatsapp TEXT`);

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
    // Fix de produção 8 — conversão do lead de Rastreamento vira um cliente
    // (agenda_clientes) na loja única de gestão veicular, não uma loja nova
    // (o Rastreamento não é multiloja). Guarda o vínculo pra não duplicar
    // caso "converter" seja clicado duas vezes.
    // Sem REFERENCES de propósito: agenda_clientes é criada na migração de
    // outro arquivo (routes/agenda/index.ts), e as duas migrações rodam em
    // paralelo na subida do servidor sem ordem garantida entre si — um FK
    // aqui arriscaria "relation agenda_clientes does not exist" num banco
    // zerado, dependendo de qual migração terminar primeiro. É só um vínculo
    // de conveniência pro admin, não precisa de integridade referencial dura
    // (a linha de agenda_clientes nunca é apagada por causa disso, e mesmo
    // que fosse, o pior caso é o cliente_id apontar pra um id que não existe
    // mais). A alteração do CHECK de agenda_clientes.origem, por sua vez,
    // fica no próprio arquivo que já cria essa tabela (agenda/index.ts), pra
    // garantir ordem certa dentro do mesmo arquivo.
    await pool.query(`ALTER TABLE landing_leads ADD COLUMN IF NOT EXISTS cliente_id UUID`);

    // Fix de produção 9 — campos extras pro Rastreamento: o Carlos pediu pra
    // coletar dados do veículo (placa opcional, pode não ter ainda) e do
    // cliente (endereço sem número obrigatório, data de nascimento, contato
    // de emergência) já no formulário "Contratar" da landing, pra não
    // precisar redigitar tudo na aba Clientes depois de converter o lead.
    // Só o Rastreamento usa esses campos por enquanto (landing.html só
    // mostra o bloco quando vertical_slug === 'rastreamento'), mas ficam
    // aqui soltos (não dentro de um JSONB) pra manter o mesmo estilo do
    // resto da tabela.
    await pool.query(`
      ALTER TABLE landing_leads
        ADD COLUMN IF NOT EXISTS veiculo_placa  TEXT,
        ADD COLUMN IF NOT EXISTS veiculo_modelo TEXT,
        ADD COLUMN IF NOT EXISTS veiculo_ano    TEXT,
        ADD COLUMN IF NOT EXISTS veiculo_cor    TEXT,
        ADD COLUMN IF NOT EXISTS endereco_cep     TEXT,
        ADD COLUMN IF NOT EXISTS endereco_rua     TEXT,
        ADD COLUMN IF NOT EXISTS endereco_numero  TEXT,
        ADD COLUMN IF NOT EXISTS endereco_bairro  TEXT,
        ADD COLUMN IF NOT EXISTS endereco_cidade  TEXT,
        ADD COLUMN IF NOT EXISTS endereco_estado  TEXT,
        ADD COLUMN IF NOT EXISTS data_nascimento  DATE,
        ADD COLUMN IF NOT EXISTS contato_emergencia_nome      TEXT,
        ADD COLUMN IF NOT EXISTS contato_emergencia_telefone  TEXT
    `);
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

// Fix de produção 10 — cópia do Termo de Adesão por e-mail depois do aceite.
// Mesmo padrão de envio de e-mail já usado em otp_service.ts/gymExpiryJob.ts
// (lê SMTP de global_settings, nodemailer direto — sem serviço externo).
// Best-effort: se não tiver SMTP configurado ou a mensagem falhar, não
// derruba o aceite (o aceite já foi salvo antes de chamar isso).
async function enviarCopiaTermoPorEmail(to: string, nome: string, moduloLabel: string, contratoTexto: string): Promise<boolean> {
  try {
    const settings = await pool.query(
      `SELECT key, value FROM global_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','pwa_name')`
    ).then(r => Object.fromEntries(r.rows.map((row: any) => [row.key, row.value])));

    if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) return false;

    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: parseInt(settings.smtp_port || '587'),
      secure: false,
      auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    });

    await transporter.sendMail({
      from: settings.smtp_from || settings.smtp_user,
      to,
      subject: `Termo de Adesão — ${moduloLabel} (${settings.pwa_name || 'AguiaON'})`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#020617;color:#cbd5e1;border-radius:16px">
          <h2 style="color:#6366f1;margin:0 0 8px">Termo de Adesão</h2>
          <p style="margin:0 0 20px;color:#94a3b8">Olá, <strong style="color:#fff">${nome}</strong>! Aqui está a cópia do termo de adesão que você aceitou pra ${moduloLabel}.</p>
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;white-space:pre-wrap;font-size:12px;color:#cbd5e1">${contratoTexto}</div>
          <p style="margin:24px 0 0;font-size:11px;color:#475569">Guarde este e-mail — ele é o comprovante do seu aceite eletrônico.</p>
        </div>
      `,
    });
    return true;
  } catch (err: any) {
    console.error('[landings] falha ao enviar cópia do termo por email:', err.message);
    return false;
  }
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

// Aceita o SuperAdmin de sempre (JWT role SUPERADMIN ou x-admin-key legacy —
// mesma lógica de requireAdmin) OU um LOJISTA cuja própria loja seja da
// vertical pedida no :vertical_slug (Fix de produção 11 — o Rastreamento
// agora edita a própria landing pelo painel da loja, não só pelo SuperAdmin).
// Fica aqui, não em shared/authMiddleware.ts, porque é uma regra específica
// dessa rota de preview (não um padrão de auth reutilizável em outro lugar).
async function requireAdminOrOwnVerticalLojista(req: Request, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const secret = process.env.JWT_SECRET!;
      const payload = jwt.verify(authHeader.split(' ')[1], secret) as TokenPayload;
      if (payload.role === 'SUPERADMIN') {
        req.user = payload;
        return next();
      }
      if (payload.role === 'LOJISTA' && payload.establishmentId) {
        const estab = await pool.query(`SELECT vertical_slug FROM establishments WHERE id=$1`, [payload.establishmentId]);
        if (estab.rows[0]?.vertical_slug === req.params.vertical_slug) {
          req.user = payload;
          return next();
        }
      }
    } catch { /* cai pro check de key abaixo */ }
  }
  const adminKey = req.headers['x-admin-key'];
  if (adminKey && adminKey === process.env.ADMIN_SECRET_KEY) return next();
  return res.status(403).json({ error: 'Acesso negado.' });
}

// GET /public/landing/preview/:vertical_slug — pré-visualização pro
// SuperAdmin (ou pro lojista dono daquela vertical) ver o rascunho antes de
// publicar (não exige `published=true`).
router.get('/public/landing/preview/:vertical_slug', requireAdminOrOwnVerticalLojista, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM vertical_landings WHERE vertical_slug=$1`, [req.params.vertical_slug]);
    if (!r.rows.length) return res.status(404).json({ error: 'Landing ainda não criada pra esse módulo.' });
    res.json(r.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Fix de produção 12 — generaliza a checagem de "módulo de serviço único"
// (antes hardcoded pra 'rastreamento'): agora olha o campo `modelo_negocio`
// do blueprint (ver verticals/blueprints.ts). Qualquer vertical futura que
// marque `modelo_negocio: 'servico_unico'` ganha esse mesmo comportamento
// automaticamente, sem precisar mexer em landings.ts de novo.
function isServicoUnico(verticalSlug: string | undefined): boolean {
  if (!verticalSlug) return false;
  const bp = listBlueprints().find((b: any) => b.slug === verticalSlug);
  return bp?.modelo_negocio === 'servico_unico';
}

// Painel da loja (LOJISTA) editando a própria landing — Fix de produção 11.
// Carlos: o Rastreamento não tem "Catálogo" (não é um negócio de produto),
// então em vez de deixar essa aba genérica lá sem sentido, a loja única do
// módulo ganha uma aba "Landing Page" no lugar, editando a própria landing
// (vertical_slug = a da própria loja) sem passar pelo painel do SuperAdmin.
// Restrito a módulos "serviço único" — outras verticais são multiloja, e
// deixar qualquer lojista editar a landing (compartilhada por todas as
// lojas daquele módulo) seria arriscado.
router.get('/lojista/landing', requireAuth, requireRole('LOJISTA'), async (req, res) => {
  try {
    const eid = (req.user as TokenPayload).establishmentId;
    if (!eid) return res.status(403).json({ error: 'Sem estabelecimento no token.' });
    const estab = await pool.query(`SELECT vertical_slug FROM establishments WHERE id=$1`, [eid]);
    const verticalSlug = estab.rows[0]?.vertical_slug;
    if (!isServicoUnico(verticalSlug)) {
      return res.status(403).json({ error: 'A edição da landing pelo painel da loja só está disponível pra módulos de serviço único.' });
    }
    const bp = listBlueprints().find((b: any) => b.slug === verticalSlug);
    const r = await pool.query(`SELECT * FROM vertical_landings WHERE vertical_slug=$1`, [verticalSlug]);
    res.json({ vertical_slug: verticalSlug, vertical_label: bp?.label || verticalSlug, landing: r.rows[0] || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /lojista/landing — mesma validação/upsert do PUT /admin/landings/:vertical_slug
// (reaproveita upsertVerticalLanding), só que o vertical_slug vem do próprio
// estabelecimento logado, não de um parâmetro na URL — um lojista não escolhe
// qual landing editar, só edita a da própria loja.
router.put('/lojista/landing', requireAuth, requireRole('LOJISTA'), async (req, res) => {
  try {
    const eid = (req.user as TokenPayload).establishmentId;
    if (!eid) return res.status(403).json({ error: 'Sem estabelecimento no token.' });
    const estab = await pool.query(`SELECT vertical_slug FROM establishments WHERE id=$1`, [eid]);
    const verticalSlug = estab.rows[0]?.vertical_slug;
    if (!isServicoUnico(verticalSlug)) {
      return res.status(403).json({ error: 'A edição da landing pelo painel da loja só está disponível pra módulos de serviço único.' });
    }
    const row = await upsertVerticalLanding(verticalSlug, req.body);
    res.json(row);
  } catch (err: any) {
    handleUpsertError(err, res);
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

// Erro tipado pra distinguir "requisição inválida do usuário" (400/409) de
// erro de servidor de verdade (500) — usado por upsertVerticalLanding, que
// agora serve tanto o PUT do SuperAdmin quanto o PUT do painel da loja
// (Fix de produção 11), pra não duplicar a mesma validação nos dois lugares.
class LandingUpsertError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function upsertVerticalLanding(verticalSlug: string, body: any) {
  const {
    published, domain_mode, domain_value,
    blocks, contract_template, contato_whatsapp,
    seo_title, seo_description,
  } = body;

  const mode = domain_mode === 'subdomain' ? 'subdomain' : 'path';
  const value = (domain_value || '').toLowerCase().trim().replace(/^\/+|\/+$/g, '');

  if (published && !value) {
    throw new LandingUpsertError(400, 'Informe o endereço (caminho ou subdomínio) antes de publicar.');
  }
  if (value) {
    const collision = await pool.query(`SELECT 1 FROM establishments WHERE slug=$1`, [value]);
    if (collision.rows.length) {
      throw new LandingUpsertError(409, `Esse endereço ("${value}") já é usado por uma loja cadastrada — escolha outro.`);
    }
  }

  const r = await pool.query(
    `INSERT INTO vertical_landings
       (vertical_slug, published, domain_mode, domain_value, blocks, contract_template,
        contato_whatsapp, seo_title, seo_description, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (vertical_slug) DO UPDATE SET
       published=$2, domain_mode=$3, domain_value=$4, blocks=$5, contract_template=$6,
       contato_whatsapp=$7, seo_title=$8, seo_description=$9, updated_at=NOW()
     RETURNING *`,
    [
      verticalSlug, !!published, mode, value,
      JSON.stringify(blocks || []), contract_template || null, contato_whatsapp || null,
      seo_title || null, seo_description || null,
    ]
  );
  return r.rows[0];
}

function handleUpsertError(err: any, res: any) {
  if (err instanceof LandingUpsertError) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Esse endereço já está em uso por outra landing publicada.' });
  }
  return res.status(500).json({ error: err.message });
}

// PUT /admin/landings/:vertical_slug — cria ou atualiza (upsert) a landing
// de um módulo. Validações: domain_value obrigatório se for publicar, e não
// pode colidir com o slug de uma loja real já cadastrada (senão a landing
// rouba o endereço da vitrine daquela loja) — nem em modo path nem subdomínio,
// já que os dois competem pelo mesmo espaço de nomes de `establishments.slug`.
router.put('/admin/landings/:vertical_slug', requireAdmin, async (req, res) => {
  try {
    const row = await upsertVerticalLanding(req.params.vertical_slug, req.body);
    res.json(row);
  } catch (err: any) {
    handleUpsertError(err, res);
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
    const {
      nome, empresa, whatsapp, email, cpf_cnpj, plano_nome, plano_preco,
      veiculo_placa, veiculo_modelo, veiculo_ano, veiculo_cor,
      endereco_cep, endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_estado,
      data_nascimento, contato_emergencia_nome, contato_emergencia_telefone,
    } = req.body;
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
         (vertical_slug, plano_nome, plano_preco, nome, empresa, whatsapp, email, cpf_cnpj, contrato_texto,
          veiculo_placa, veiculo_modelo, veiculo_ano, veiculo_cor,
          endereco_cep, endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_estado,
          data_nascimento, contato_emergencia_nome, contato_emergencia_telefone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id, contrato_texto`,
      [
        verticalSlug, plano_nome || null, plano_preco || null, nome.trim(), empresa || null, whatsapp || null, email || null, cpf_cnpj || null, contratoTexto,
        veiculo_placa || null, veiculo_modelo || null, veiculo_ano || null, veiculo_cor || null,
        endereco_cep || null, endereco_rua || null, endereco_numero || null, endereco_bairro || null, endereco_cidade || null, endereco_estado || null,
        data_nascimento || null, contato_emergencia_nome || null, contato_emergencia_telefone || null,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /public/landing/leads/:id/aceitar — aceite eletrônico simples: quem
// preencher precisa digitar o próprio nome + CPF de novo (mesmo padrão de
// "confirme seus dados" usado em aceites eletrônicos simples), e o servidor
// registra IP + user-agent + timestamp como evidência do aceite. Depois de
// salvar, manda uma cópia do termo por e-mail (se o lead tiver e-mail) e
// devolve o WhatsApp de contato da landing pro botão "Continuar no
// WhatsApp" do front — a mensagem em si quem monta e manda é o próprio
// visitante, clicando um link wa.me com o texto pronto, não o servidor
// (evita risco de bloqueio por disparo automático).
router.post('/public/landing/leads/:id/aceitar', async (req, res) => {
  try {
    const { aceite_nome, aceite_cpf } = req.body;
    if (!aceite_nome?.trim() || !aceite_cpf?.trim()) {
      return res.status(400).json({ error: 'Confirme seu nome completo e CPF pra aceitar o termo de adesão.' });
    }
    const leadRes = await pool.query(`SELECT * FROM landing_leads WHERE id=$1`, [req.params.id]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = leadRes.rows[0];
    if (lead.status !== 'novo') {
      return res.status(409).json({ error: 'Esse termo de adesão já foi tratado antes.' });
    }

    const ip = (req.headers['x-forwarded-for'] as string || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    await pool.query(
      `UPDATE landing_leads SET
         status='aceito', aceite_nome=$1, aceite_cpf=$2, aceite_ip=$3, aceite_user_agent=$4, aceite_em=NOW(), updated_at=NOW()
       WHERE id=$5`,
      [aceite_nome.trim(), aceite_cpf.trim(), ip, req.headers['user-agent'] || null, req.params.id]
    );

    const bp = listBlueprints().find((b: any) => b.slug === lead.vertical_slug);
    const moduloLabel = bp?.label || lead.vertical_slug;

    let emailEnviado = false;
    if (lead.email && lead.contrato_texto) {
      emailEnviado = await enviarCopiaTermoPorEmail(lead.email, lead.nome, moduloLabel, lead.contrato_texto);
    }

    const landingRes = await pool.query(`SELECT contato_whatsapp FROM vertical_landings WHERE vertical_slug=$1`, [lead.vertical_slug]);

    res.json({
      success: true,
      email_enviado: emailEnviado,
      contato_whatsapp: landingRes.rows[0]?.contato_whatsapp || null,
    });
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

// POST /admin/landing-leads/:id/converter — marca o lead como convertido.
//
// Regra geral (Delivery, Agenda etc., módulos multiloja): a criação da loja
// de verdade continua pelo fluxo já existente no painel (criar nova loja) —
// não automatizamos isso aqui pra não duplicar aquela lógica com dados
// parciais do formulário de lead (falta senha, cidade/estado etc.).
//
// Exceção — módulos "serviço único" (Fix de produção 8, generalizado no Fix
// 12): esses módulos não são multiloja, existe uma única loja gerenciando
// muitos clientes (hoje só o Rastreamento se qualifica — ver `modelo_negocio`
// no blueprint). Então converter um lead desses não cria uma loja nova — cria
// um cliente (agenda_clientes) dentro da loja única daquele módulo (achada
// dinamicamente por `vertical_slug`, não por um slug de loja fixo no código),
// com login (findOrCreateClienteUser, mesmo mecanismo do Fase 14) pra ele
// poder acessar o painel de cliente e completar a senha por "Esqueci minha
// senha" no primeiro acesso. Dados de veículo (placa, modelo, ano, cor) são
// específicos do formulário do Rastreamento — viram um agenda_frota só nesse
// caso; um módulo de serviço único diferente não teria esses campos.
router.post('/admin/landing-leads/:id/converter', requireAdmin, async (req, res) => {
  try {
    const leadRes = await pool.query(`SELECT * FROM landing_leads WHERE id=$1`, [req.params.id]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = leadRes.rows[0];

    if (lead.cliente_id) {
      return res.status(400).json({ error: 'Esse lead já foi convertido em cliente.' });
    }

    let clienteId: string | null = null;
    let loginDisponivel = false;

    if (isServicoUnico(lead.vertical_slug)) {
      // Garante que agenda_clientes (e o CHECK de origem atualizado) já
      // existam — essa migração normalmente só roda no primeiro request a
      // /agenda/*, e essa rota não passa por lá.
      await ensureAgendaTables();

      // A loja desse módulo é achada pelo próprio vertical_slug (um módulo
      // "serviço único" só tem uma, por definição) — não por um slug de loja
      // fixo no código, o que deixa isso pronto pra qualquer módulo futuro
      // marcado como serviço único, sem precisar tocar nesse arquivo de novo.
      const estab = await pool.query(
        `SELECT id FROM establishments WHERE vertical_slug=$1 ORDER BY created_at ASC LIMIT 1`,
        [lead.vertical_slug]
      );
      if (!estab.rows.length) {
        return res.status(500).json({
          error: `Nenhuma loja encontrada pro módulo "${lead.vertical_slug}". Confirme se a loja única desse módulo já foi criada antes de converter.`,
        });
      }
      const eid = estab.rows[0].id;

      const userId = await findOrCreateClienteUser(lead.nome, lead.whatsapp, lead.email);
      loginDisponivel = !!userId;

      const clienteRes = await pool.query(
        `INSERT INTO agenda_clientes
           (establishment_id, nome, telefone, email, cpf_cnpj, observacoes, origem, user_id,
            endereco_cep, endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_estado,
            data_nascimento, contato_emergencia_nome, contato_emergencia_telefone)
         VALUES ($1,$2,$3,$4,$5,$6,'landing_modulo',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          eid, lead.nome, lead.whatsapp || null, lead.email || null, lead.cpf_cnpj || null,
          lead.empresa ? `Empresa: ${lead.empresa}` : null, userId,
          lead.endereco_cep || null, lead.endereco_rua || null, lead.endereco_numero || null,
          lead.endereco_bairro || null, lead.endereco_cidade || null, lead.endereco_estado || null,
          lead.data_nascimento || null, lead.contato_emergencia_nome || null, lead.contato_emergencia_telefone || null,
        ]
      );
      clienteId = clienteRes.rows[0].id;

      // Veículo — específico do formulário do Rastreamento (placa/modelo/
      // ano/cor não existem no formulário de outro módulo de serviço único).
      // Só cria se algum dado veio preenchido (placa é opcional de propósito:
      // às vezes o cliente ainda não tem placa/rastreador instalado).
      if (lead.vertical_slug === 'rastreamento' && (lead.veiculo_placa || lead.veiculo_modelo || lead.veiculo_ano || lead.veiculo_cor)) {
        const anoNum = lead.veiculo_ano ? parseInt(lead.veiculo_ano, 10) : null;
        await pool.query(
          `INSERT INTO agenda_frota (establishment_id, cliente_id, cliente_nome, cliente_telefone, placa, modelo, ano, cor, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ativo')`,
          [eid, clienteId, lead.nome, lead.whatsapp || null, lead.veiculo_placa || null, lead.veiculo_modelo || null,
           Number.isFinite(anoNum) ? anoNum : null, lead.veiculo_cor || null]
        );
      }
    }

    const r = await pool.query(
      `UPDATE landing_leads SET status='convertido', cliente_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [clienteId, req.params.id]
    );
    res.json({ ...r.rows[0], login_disponivel: loginDisponivel });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
