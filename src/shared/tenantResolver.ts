/**
 * Resolução de tenant por host — AguiaON (Fase 4, white-label)
 *
 * Cada empresa pode ser acessada por:
 *  - subdomínio próprio na plataforma: {slug}.PLATFORM_BASE_DOMAIN (ex: loja1.ag-on.com)
 *  - domínio customizado: establishments.custom_domain (ex: www.loja1.com.br)
 *
 * O middleware roda cedo no pipeline e resolve `req.tenant` a partir do header
 * Host — a rota raiz e a rota de vitrine usam isso para decidir se servem o
 * marketplace genérico ou a loja específica, sem precisar do slug na URL.
 *
 * Infra que fica de fora do código (documentado no roadmap): DNS wildcard
 * (*.PLATFORM_BASE_DOMAIN) e certificado TLS cobrindo o wildcard + domínios
 * customizados.
 */

import { Request, Response, NextFunction } from 'express';
import pool from './db';

export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      tenant?: ResolvedTenant;
    }
  }
}

/**
 * Extrai o slug candidato a partir do subdomínio de um host, dado o domínio
 * base da plataforma. Função pura — sem I/O — para ser testável isoladamente
 * (ver src/__tests__/tenantResolver.test.ts).
 *
 * Retorna null quando o host é o próprio domínio base (ou www dele), quando
 * não tem subdomínio, ou quando não é um subdomínio do domínio base.
 */
export function extractSubdomainSlug(hostHeader: string, baseDomain: string): string | null {
  if (!hostHeader || !baseDomain) return null;

  const host = hostHeader.split(':')[0].toLowerCase().trim();
  const base = baseDomain.toLowerCase().trim();

  if (host === base || host === `www.${base}`) return null;
  if (!host.endsWith(`.${base}`)) return null;

  const prefix = host.slice(0, host.length - base.length - 1); // remove ".base"
  if (!prefix || prefix.includes('.')) return null; // só aceita 1 nível de subdomínio (ex: loja1.base, não a.b.base)

  return prefix;
}

// ─── Cache curto por host (evita bater no banco a cada request) ──
const tenantCache: Record<string, { data: ResolvedTenant | null; ts: number }> = {};
const CACHE_TTL_MS = 30_000;

async function lookupTenant(hostHeader: string): Promise<ResolvedTenant | null> {
  const host = (hostHeader || '').split(':')[0].toLowerCase().trim();
  if (!host) return null;

  const cached = tenantCache[host];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  let tenant: ResolvedTenant | null = null;
  try {
    // 1. Domínio customizado — match exato
    const customRes = await pool.query(
      `SELECT id, slug, name FROM establishments WHERE custom_domain = $1 AND is_active = true LIMIT 1`,
      [host]
    );
    if (customRes.rows.length) {
      tenant = customRes.rows[0];
    } else {
      // 2. Subdomínio da plataforma
      const baseDomain = process.env.PLATFORM_BASE_DOMAIN || '';
      const slugCandidate = extractSubdomainSlug(host, baseDomain);
      if (slugCandidate) {
        const slugRes = await pool.query(
          `SELECT id, slug, name FROM establishments WHERE slug = $1 AND is_active = true LIMIT 1`,
          [slugCandidate]
        );
        if (slugRes.rows.length) tenant = slugRes.rows[0];
      }
    }
  } catch (err: any) {
    console.error('[tenantResolver] erro ao resolver tenant por host:', err.message);
  }

  tenantCache[host] = { data: tenant, ts: Date.now() };
  return tenant;
}

export function invalidateTenantHostCache(host?: string): void {
  if (host) delete tenantCache[host.toLowerCase().trim()];
  else for (const key in tenantCache) delete tenantCache[key];
}

/** Middleware Express: resolve req.tenant a partir do header Host, se aplicável. */
export async function tenantHostContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const host = req.headers.host;
    if (host) {
      const tenant = await lookupTenant(host);
      if (tenant) req.tenant = tenant;
    }
  } catch {
    // Nunca bloqueia a requisição por falha na resolução de tenant
  }
  next();
}
