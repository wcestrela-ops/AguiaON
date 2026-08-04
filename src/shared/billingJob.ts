/**
 * BILLING JOB — AguiaON (Fase 5)
 *
 * Roda às 07:00 horário de Brasília (mesmo padrão do gymExpiryJob.ts):
 *  1. Renovação: toda empresa com plano da plataforma cujo ciclo atual já
 *     terminou (ou nunca teve fatura) recebe uma fatura nova + cobrança PIX.
 *  2. Saúde de cobrança: reavalia o billing_status de toda empresa com plano
 *     definido (aviso → bloqueio depois de 2 dias sem pagamento).
 */

import pool from './db';
import { ensureTables, generateInvoice, evaluateBillingHealth } from './platformBilling';

export function startBillingJob(): void {
  runCheck().catch(() => {});
  setInterval(() => runCheck().catch(() => {}), 60_000);
}

async function runCheck(): Promise<void> {
  const nowHHMM = new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });
  if (nowHHMM !== '07:00') return;

  await ensureTables();
  await renewDueEstablishments();
  await evaluateAllHealth();
}

async function renewDueEstablishments(): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT id, name FROM establishments
      WHERE platform_plan_id IS NOT NULL
        AND is_active = true
        AND (current_period_ends_at IS NULL OR current_period_ends_at <= CURRENT_DATE)
    `);
    for (const row of result.rows) {
      try {
        await generateInvoice(row.id);
        console.log(`[billingJob] fatura gerada — empresa "${row.name}" (${row.id})`);
      } catch (err: any) {
        console.error(`[billingJob] falha ao gerar fatura da empresa ${row.id}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[billingJob] renewDueEstablishments:', err.message);
  }
}

async function evaluateAllHealth(): Promise<void> {
  try {
    const result = await pool.query(`SELECT id FROM establishments WHERE platform_plan_id IS NOT NULL`);
    for (const row of result.rows) {
      await evaluateBillingHealth(row.id).catch((err: any) =>
        console.error(`[billingJob] evaluateBillingHealth falhou para ${row.id}:`, err.message)
      );
    }
  } catch (err: any) {
    console.error('[billingJob] evaluateAllHealth:', err.message);
  }
}
