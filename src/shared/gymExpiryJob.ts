/**
 * GYM EXPIRY JOB — Águia-ON
 *
 * Roda às 09:00 horário de Brasília. Para cada assinatura ativa que vence hoje:
 *  1. Atualiza status para 'expired'
 *  2. Notificação no portal do cliente (sempre)
 *  3. Email de cobrança com PIX (se gym_notify_billing_email habilitado)
 *  4. WhatsApp com PIX copia-e-cola (se gym_notify_billing_wa habilitado, com delay anti-ban)
 *
 * Também envia alerta 3 dias antes (expiry_soon) sem alterar status.
 */

import pool from './db';
import { sendWhatsAppMessage } from './waSender';
import { generateGymPix } from './pixService';
import { sendEmail } from './mailer';

const CYCLE_LABEL: Record<string, string> = {
  weekly: 'semanal', monthly: 'mensal', bimonthly: 'bimestral',
  quarterly: 'trimestral', semiannual: 'semestral', annual: 'anual',
};

// ── Delay aleatório entre envios WA (anti-ban) ────────────────
function randomDelay(minMs = 8_000, maxMs = 20_000): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Fila de WA com delay sequencial ──────────────────────────
interface WaQueueItem {
  estId: string;
  phone: string;
  msg: string;
}

async function sendWaQueue(items: WaQueueItem[]): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(randomDelay());
    const { estId, phone, msg } = items[i];
    sendWhatsAppMessage(estId, phone, msg).catch((err: any) =>
      console.error(`[gymExpiry] WA falhou para ${phone}:`, err.message)
    );
  }
}

// ── Email de cobrança ─────────────────────────────────────────
// Fix de produção 33 — este arquivo tinha SUA PRÓPRIA cópia da lógica de
// SMTP (igual o otp_service.ts tinha antes do Fix 27), com o mesmo bug:
// lia `smtp_pass` direto do banco sem descriptografar (admin.ts criptografa
// qualquer chave com "pass"/"key"/"secret"/"token" no nome ao salvar) — a
// autenticação SMTP usava o texto criptografado como senha e falhava, ou
// ficava vazio e pulava o envio, silenciosamente. Corrigido reaproveitando
// `sendEmail`/`getSmtpSettings` de `mailer.ts` (já corrigido), em vez de
// manter uma terceira cópia divergente da mesma lógica.
async function sendBillingEmail(
  to: string, clientName: string, estName: string,
  planName: string, planValue: number, expiryFmt: string,
  pixCode: string | null
): Promise<void> {
  const pixBlock = pixCode
    ? `<div style="background:#0f172a;border:1px solid #f97316;border-radius:12px;padding:20px;margin:16px 0">
         <p style="margin:0 0 8px;font-size:12px;color:#94a3b8">PIX Copia e Cola:</p>
         <p style="margin:0;font-size:11px;color:#fff;word-break:break-all;font-family:monospace">${pixCode}</p>
       </div>
       <p style="font-size:13px;color:#94a3b8">Após o pagamento, sua assinatura será renovada automaticamente.</p>`
    : `<p style="font-size:13px;color:#94a3b8">Entre em contato com ${estName} para renovar.</p>`;

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#020617;color:#cbd5e1;border-radius:16px">
      <h2 style="color:#f97316;margin:0 0 8px">Plano vencido</h2>
      <p style="margin:0 0 20px;color:#94a3b8">Olá, <strong style="color:#fff">${clientName}</strong>!</p>
      <p style="margin:0 0 16px">Seu plano <strong style="color:#fff">${planName}</strong> na <strong style="color:#fff">${estName}</strong> venceu em <strong>${expiryFmt}</strong>.</p>
      <p style="font-size:18px;font-weight:700;color:#fff;margin:0 0 16px">Valor: R$ ${planValue.toFixed(2).replace('.', ',')}</p>
      ${pixBlock}
      <p style="margin:24px 0 0;font-size:11px;color:#475569">Você recebeu este email pois está cadastrado na plataforma Águia-ON.</p>
    </div>
  `;
  await sendEmail(to, `⚠️ Seu plano ${planName} venceu hoje — ${estName}`, html).catch((err: any) =>
    console.error('[gymExpiry] email billing error:', err.message)
  );
}

// ── Email de aviso antecipado ─────────────────────────────────
async function sendExpirySoonEmail(
  to: string, clientName: string, estName: string,
  planName: string, cycleLabel: string, expiryFmt: string
): Promise<void> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#020617;color:#cbd5e1;border-radius:16px">
      <h2 style="color:#f59e0b;margin:0 0 8px">Lembrete de vencimento</h2>
      <p style="margin:0 0 20px;color:#94a3b8">Olá, <strong style="color:#fff">${clientName}</strong>!</p>
      <p style="margin:0 0 16px">Seu plano <strong style="color:#fff">${planName}</strong> (${cycleLabel}) na <strong style="color:#fff">${estName}</strong> vence em <strong>${expiryFmt}</strong>.</p>
      <p style="font-size:13px;color:#94a3b8">Renove com antecedência para não perder o acesso!</p>
      <p style="margin:24px 0 0;font-size:11px;color:#475569">Você recebeu este email pois está cadastrado na plataforma Águia-ON.</p>
    </div>
  `;
  await sendEmail(to, `⏰ Seu plano ${planName} vence em 3 dias — ${estName}`, html).catch((err: any) =>
    console.error('[gymExpiry] email expiry_soon error:', err.message)
  );
}

export function startGymExpiryJob(): void {
  pool.query(`
    ALTER TABLE gym_subscriptions
      ADD COLUMN IF NOT EXISTS pending_pix_code TEXT,
      ADD COLUMN IF NOT EXISTS pending_payment_provider TEXT
  `).catch(() => {});

  runCheck().catch(() => {});
  setInterval(() => runCheck().catch(() => {}), 60_000);
}

async function runCheck(): Promise<void> {
  const nowHHMM = new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });
  if (nowHHMM !== '09:00') return;

  await checkExpiredToday();
  await checkExpiringSoon();
}

// ── Assinaturas que vencem HOJE ───────────────────────────────
async function checkExpiredToday(): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT
        s.id            AS sub_id,
        s.plan_name,
        s.plan_value,
        s.expiry_date,
        s.renewal_cycle,
        s.client_id,
        c.name          AS client_name,
        c.whatsapp      AS client_whatsapp,
        c.email         AS client_email,
        c.user_id,
        e.id            AS est_id,
        e.name          AS est_name,
        e.gym_notify_expiry_wa,
        e.gym_notify_billing_wa,
        e.gym_notify_billing_email
      FROM gym_subscriptions s
      JOIN gym_clients c ON c.id = s.client_id
      JOIN establishments e ON e.id = s.establishment_id
      WHERE s.status = 'active'
        AND s.expiry_date = CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM gym_client_notifications n
          WHERE n.subscription_id = s.id AND n.type = 'expired'
        )
    `);

    const waQueue: WaQueueItem[] = [];

    for (const row of result.rows) {
      const expiryFmt = new Date(row.expiry_date + 'T12:00:00').toLocaleDateString('pt-BR');
      const planValue = parseFloat(row.plan_value) || 0;

      // 1. Marca como expirada
      await pool.query(
        `UPDATE gym_subscriptions SET status='expired', updated_at=NOW() WHERE id=$1`,
        [row.sub_id]
      );

      // 2. Notificação no portal (sempre)
      await pool.query(
        `INSERT INTO gym_client_notifications
           (establishment_id, client_id, subscription_id, type, title, message)
         VALUES ($1,$2,$3,'expired',$4,$5)`,
        [row.est_id, row.client_id, row.sub_id,
         `⚠️ Plano vencido: ${row.plan_name}`,
         `Seu plano ${row.plan_name} na ${row.est_name} venceu hoje.`]
      ).catch(() => {});

      // 3. Gera PIX se algum canal de cobrança estiver habilitado
      let pixCode: string | null = null;
      let pixMsg: string | null = null;

      const needsPix = planValue > 0 && (row.gym_notify_billing_wa || row.gym_notify_billing_email);
      if (needsPix) {
        try {
          const pix = await generateGymPix(
            row.est_id, row.sub_id, planValue,
            row.client_name, row.client_email || undefined
          );
          if (pix) {
            pixCode = pix.code;
            pixMsg  = pix.message;
            await pool.query(
              `UPDATE gym_subscriptions SET pending_pix_code=$1, pending_payment_provider=$2, updated_at=NOW() WHERE id=$3`,
              [pix.code, pix.provider, row.sub_id]
            );
          }
        } catch (pixErr: any) {
          console.error(`[gymExpiry] PIX error sub ${row.sub_id}:`, pixErr.message);
        }
      }

      // 4. Email de cobrança
      if (row.gym_notify_billing_email && row.client_email) {
        sendBillingEmail(
          row.client_email, row.client_name, row.est_name,
          row.plan_name, planValue, expiryFmt, pixCode
        ).catch(() => {});
      }

      // 5. WhatsApp — enfileira para envio com delay
      if (row.gym_notify_billing_wa && row.client_whatsapp) {
        const waText = pixMsg
          ? `⚠️ *Olá, ${row.client_name}!*\n\nSeu plano *${row.plan_name}* na *${row.est_name}* venceu hoje.\n\n${pixMsg}`
          : `⚠️ *Olá, ${row.client_name}!*\n\nSeu plano *${row.plan_name}* na *${row.est_name}* venceu hoje.\n\nEntre em contato para renovar!`;
        waQueue.push({ estId: row.est_id, phone: row.client_whatsapp, msg: waText });
      } else if (row.gym_notify_expiry_wa && row.client_whatsapp && !row.gym_notify_billing_wa) {
        // Fallback: WA simples sem cobrança (configuração antiga)
        const waText = `⚠️ *Olá, ${row.client_name}!*\n\nSeu plano *${row.plan_name}* na *${row.est_name}* venceu hoje. Entre em contato para renovar!`;
        waQueue.push({ estId: row.est_id, phone: row.client_whatsapp, msg: waText });
      }
    }

    // Envia WA com delay anti-ban
    if (waQueue.length) {
      sendWaQueue(waQueue).catch(() => {});
      console.log(`[gymExpiry] ${waQueue.length} msg(s) WA enfileirada(s) com delay`);
    }

    if (result.rows.length) {
      console.log(`[gymExpiry] ${result.rows.length} assinatura(s) vencida(s) processada(s)`);
    }
  } catch (err: any) {
    console.error('[gymExpiry] checkExpiredToday:', err.message);
  }
}

// ── Assinaturas que vencem em 3 DIAS ─────────────────────────
async function checkExpiringSoon(): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT
        s.id            AS sub_id,
        s.plan_name,
        s.expiry_date,
        s.renewal_cycle,
        s.client_id,
        c.name          AS client_name,
        c.whatsapp      AS client_whatsapp,
        c.email         AS client_email,
        e.id            AS est_id,
        e.name          AS est_name,
        e.gym_notify_expiry_wa,
        e.gym_notify_billing_wa,
        e.gym_notify_billing_email
      FROM gym_subscriptions s
      JOIN gym_clients c ON c.id = s.client_id
      JOIN establishments e ON e.id = s.establishment_id
      WHERE s.status = 'active'
        AND s.expiry_date = CURRENT_DATE + INTERVAL '3 days'
        AND NOT EXISTS (
          SELECT 1 FROM gym_client_notifications n
          WHERE n.subscription_id = s.id AND n.type = 'expiry_soon'
        )
    `);

    const waQueue: WaQueueItem[] = [];

    for (const row of result.rows) {
      const cycleLabel = CYCLE_LABEL[row.renewal_cycle] || row.renewal_cycle;
      const expiryFmt  = new Date(row.expiry_date + 'T12:00:00').toLocaleDateString('pt-BR');

      // Portal (sempre)
      await pool.query(
        `INSERT INTO gym_client_notifications
           (establishment_id, client_id, subscription_id, type, title, message)
         VALUES ($1,$2,$3,'expiry_soon',$4,$5)`,
        [row.est_id, row.client_id, row.sub_id,
         `⏰ Plano vence em 3 dias: ${row.plan_name}`,
         `Seu plano ${cycleLabel} na ${row.est_name} vence em ${expiryFmt}. Renove com antecedência!`]
      ).catch(() => {});

      // Email de lembrete
      if (row.gym_notify_billing_email && row.client_email) {
        sendExpirySoonEmail(
          row.client_email, row.client_name, row.est_name,
          row.plan_name, cycleLabel, expiryFmt
        ).catch(() => {});
      }

      // WA de lembrete
      const sendWa = row.gym_notify_billing_wa || row.gym_notify_expiry_wa;
      if (sendWa && row.client_whatsapp) {
        waQueue.push({
          estId: row.est_id,
          phone: row.client_whatsapp,
          msg: `⏰ *Lembrete, ${row.client_name}!*\n\nSeu plano *${row.plan_name}* na *${row.est_name}* vence em *${expiryFmt}* (3 dias).\n\nRenove com antecedência para não perder o acesso!`,
        });
      }
    }

    if (waQueue.length) {
      sendWaQueue(waQueue).catch(() => {});
      console.log(`[gymExpiry] ${waQueue.length} lembrete(s) WA enfileirado(s)`);
    }

    if (result.rows.length) {
      console.log(`[gymExpiry] ${result.rows.length} aviso(s) de vencimento próximo enviado(s)`);
    }
  } catch (err: any) {
    console.error('[gymExpiry] checkExpiringSoon:', err.message);
  }
}
