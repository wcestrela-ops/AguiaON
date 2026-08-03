import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

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

// Middleware que exige uma role específica
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado.' });
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
