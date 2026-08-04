/**
 * LGPD Jobs — Águia-ON
 *
 * Jobs periódicos de conformidade com a Lei Geral de Proteção de Dados:
 *
 * 1. purgeAiMemory — apaga conversas com a Ágatha inativas há 90 dias
 * 2. purgeDeletedUsers — remove registros de usuários marcados com deleted_at há mais de 30 dias
 */

import pool from './db';

// ─── Migração das colunas LGPD ────────────────────────────────
async function ensureLgpdColumns(): Promise<void> {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_optout BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_optout_at TIMESTAMPTZ`);
  } catch (e: any) {
    console.error('[LGPD migration] ensureLgpdColumns:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Purge ai_memory — 90 dias sem interação
// ─────────────────────────────────────────────────────────────
async function purgeAiMemory(): Promise<void> {
  try {
    const result = await pool.query(`
      DELETE FROM ai_memory
      WHERE last_interaction < NOW() - INTERVAL '90 days'
    `);
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[LGPD] ai_memory: ${result.rowCount} registro(s) expirado(s) removido(s).`);
    }
  } catch (err: any) {
    console.error('[LGPD] Erro ao purgar ai_memory:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 2. Purge físico de usuários deletados há mais de 30 dias
// (após a anonimização, o registro pode ser removido definitivamente)
// ─────────────────────────────────────────────────────────────
async function purgeDeletedUsers(): Promise<void> {
  try {
    const result = await pool.query(`
      DELETE FROM users
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - INTERVAL '30 days'
    `);
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[LGPD] users: ${result.rowCount} conta(s) anonimizada(s) removida(s) definitivamente.`);
    }
  } catch (err: any) {
    console.error('[LGPD] Erro ao purgar usuários deletados:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Job principal — roda diariamente
// ─────────────────────────────────────────────────────────────
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 horas

export function startLgpdJobs(): void {
  const run = async () => {
    await purgeAiMemory();
    await purgeDeletedUsers();
  };

  // Migração e primeira execução na inicialização
  ensureLgpdColumns()
    .then(() => run())
    .catch(() => {});

  // Recorrente a cada 24h
  setInterval(() => run().catch(() => {}), INTERVAL_MS);

  console.log('[LGPD] Jobs de conformidade iniciados (intervalo: 24h).');
}
