import { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import pool from './db';

/**
 * Store PostgreSQL para express-rate-limit.
 * Compartilha contadores entre todos os workers do cluster,
 * usando a tabela `rate_limit_store` já existente no banco.
 */
export class PostgresRateLimitStore implements Store {
  private windowMs!: number;

  init(options: Options): void {
    this.windowMs = options.windowMs as number;

    // Limpa registros expirados a cada 5 minutos
    setInterval(() => {
      pool.query('DELETE FROM rate_limit_store WHERE reset_at < NOW()').catch(() => {});
    }, 5 * 60 * 1000);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const resetAt = new Date(Date.now() + this.windowMs);

    const result = await pool.query<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limit_store (key, hits, reset_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE
         SET hits     = rate_limit_store.hits + 1,
             reset_at = CASE
                          WHEN rate_limit_store.reset_at < NOW() THEN $2
                          ELSE rate_limit_store.reset_at
                        END
       RETURNING hits, reset_at`,
      [key, resetAt]
    );

    const row = result.rows[0];
    return {
      totalHits: row.hits,
      resetTime: row.reset_at,
    };
  }

  async decrement(key: string): Promise<void> {
    await pool.query(
      `UPDATE rate_limit_store SET hits = GREATEST(hits - 1, 0) WHERE key = $1`,
      [key]
    );
  }

  async resetKey(key: string): Promise<void> {
    await pool.query('DELETE FROM rate_limit_store WHERE key = $1', [key]);
  }

  async resetAll(): Promise<void> {
    await pool.query('DELETE FROM rate_limit_store');
  }
}
