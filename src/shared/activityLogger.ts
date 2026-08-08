import pool from './db';

export type ActivityType =
  | 'USER_REGISTER'
  | 'LOJISTA_REGISTER'
  | 'LOJISTA_LOGIN'
  | 'ADMIN_LOGIN'
  | 'LOJISTA_SETTINGS'
  | 'ORDER_NEW'
  | 'ORDER_STATUS'
  | 'AGATA_INTERACTION'
  | 'ADMIN_ACTION';

export interface ActivityPayload {
  type: ActivityType;
  actor_role: string;        // 'SUPERADMIN' | 'LOJISTA' | 'CLIENT' | 'SYSTEM'
  actor_id?: string | null;
  actor_name?: string | null;
  establishment_id?: string | null;
  establishment_name?: string | null;
  description: string;
  metadata?: Record<string, any>;
}

// Garante que a tabela existe (executa apenas uma vez)
let _migrated = false;
async function ensureTable() {
  if (_migrated) return;
  _migrated = true;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_activity_logs (
      id               SERIAL PRIMARY KEY,
      type             TEXT        NOT NULL,
      actor_role       TEXT        NOT NULL DEFAULT 'SYSTEM',
      actor_id         TEXT,
      actor_name       TEXT,
      establishment_id TEXT,
      establishment_name TEXT,
      description      TEXT        NOT NULL,
      metadata         JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON system_activity_logs(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_type ON system_activity_logs(type)`);
}

ensureTable().catch(e => console.error('[activityLogger migration]', e.message));

/**
 * Registra uma atividade de forma assíncrona (fire-and-forget).
 * Nunca bloqueia nem propaga erros para a requisição principal.
 */
export function logActivity(payload: ActivityPayload): void {
  pool.query(
    `INSERT INTO system_activity_logs
       (type, actor_role, actor_id, actor_name, establishment_id, establishment_name, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      payload.type,
      payload.actor_role,
      payload.actor_id   || null,
      payload.actor_name || null,
      payload.establishment_id   || null,
      payload.establishment_name || null,
      payload.description,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
    ]
  ).catch(e => console.error('[activityLogger]', e.message));
}
