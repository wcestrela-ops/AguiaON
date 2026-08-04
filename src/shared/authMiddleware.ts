import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { isBillingBlocked } from './platformBilling';

export type UserRole = 'SUPERADMIN' | 'LOJISTA' | 'CLIENT' | 'STAFF';

export interface TokenPayload {
  userId: string;
  whatsapp: string;
  role: UserRole;
  establishmentId: string | null;
  memberRole?: string;   // role primário (primeiro da lista) — mantido para compat
  memberRoles?: string[]; // todas as funções do membro
}

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET não configurado.');

    const payload = jwt.verify(token, secret) as TokenPayload;
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

// Middleware que exige uma role específica.
// Fase 5 (billing): quando o chamador é LOJISTA/STAFF, também barra o acesso
// se a empresa estiver com billing_status='blocked' (fatura vencida há mais
// de 2 dias sem desbloqueio manual do SUPERADMIN). SUPERADMIN e CLIENT nunca
// são afetados por essa checagem. Em caso de falha na checagem (ex: banco
// fora do ar), nunca bloqueia a requisição — mesmo espírito do tenantResolver.
//
// IMPORTANTE: rotas de autoatendimento de cobrança do próprio lojista (ver
// billing.ts, /admin/billing/mine) não devem usar requireRole por causa disso
// — o lojista precisa conseguir ver a fatura e pagar mesmo estando bloqueado.
export function requireRole(...roles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }
    if ((req.user.role === 'LOJISTA' || req.user.role === 'STAFF') && req.user.establishmentId) {
      try {
        if (await isBillingBlocked(req.user.establishmentId)) {
          return res.status(402).json({
            error: 'Acesso bloqueado por pendência de pagamento. Consulte a fatura ou fale com o suporte.',
            code: 'BILLING_BLOCKED',
          });
        }
      } catch {
        // Nunca bloqueia por falha na checagem de billing
      }
    }
    next();
  };
}

// Mantido para compatibilidade com rotas admin que usam x-admin-key
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Aceita tanto JWT com role SUPERADMIN quanto a chave legacy
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const secret = process.env.JWT_SECRET!;
      const payload = jwt.verify(authHeader.split(' ')[1], secret) as TokenPayload;
      if (payload.role === 'SUPERADMIN') {
        req.user = payload;
        return next();
      }
    } catch { /* fallthrough para key check */ }
  }

  const adminKey = req.headers['x-admin-key'];
  if (adminKey && adminKey === process.env.ADMIN_SECRET_KEY) {
    return next();
  }

  return res.status(403).json({ error: 'Acesso negado ao painel admin.' });
}
