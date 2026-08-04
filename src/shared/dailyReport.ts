/**
 * Relatório Diário — Águia-ON
 *
 * Cada estabelecimento pode configurar:
 *   daily_report_enabled  BOOLEAN DEFAULT false
 *   daily_report_time     TIME    DEFAULT '23:00'  (horário local do servidor)
 *
 * O job roda a cada minuto e dispara o relatório uma única vez por dia,
 * por estabelecimento, quando o horário atual (HH:MM) bate com o configurado.
 * Usa a coluna `last_daily_report` (DATE) para garantir envio único por dia.
 */

import pool from './db';
import { sendWhatsAppMessage } from './waSender';

// ─── Job principal ────────────────────────────────────────────

export function startDailyReportJob(): void {
  // Roda imediatamente e depois a cada 60 s
  runCheck().catch(() => {});
  setInterval(() => runCheck().catch(() => {}), 60_000);
}

async function runCheck(): Promise<void> {
  const nowHHMM = new Date().toTimeString().slice(0, 5); // "HH:MM"

  // Busca estabelecimentos que têm relatório habilitado e cujo horário bate agora
  const res = await pool.query(
    `SELECT wc.establishment_id, wc.daily_report_time,
            wc.last_daily_report,
            e.owner_whatsapp, e.name AS store_name
     FROM whatsapp_configs wc
     JOIN establishments e ON e.id = wc.establishment_id
     WHERE wc.daily_report_enabled = true
       AND TO_CHAR(wc.daily_report_time::time, 'HH24:MI') = $1
       AND (wc.last_daily_report IS NULL OR wc.last_daily_report < CURRENT_DATE)`,
    [nowHHMM]
  );

  for (const row of res.rows) {
    try {
      await sendDailyReport(row.establishment_id, row.store_name, row.owner_whatsapp);

      // Marca como enviado hoje
      await pool.query(
        `UPDATE whatsapp_configs SET last_daily_report = CURRENT_DATE WHERE establishment_id = $1`,
        [row.establishment_id]
      );
    } catch (err: any) {
      console.error(`[dailyReport] erro para ${row.establishment_id}:`, err.message);
    }
  }
}

// ─── Gera e envia o relatório ─────────────────────────────────

async function sendDailyReport(estId: string, storeName: string, ownerWhatsApp: string): Promise<void> {
  if (!ownerWhatsApp) return;

  const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // Totais do dia
  const summaryRes = await pool.query(
    `SELECT
       COUNT(*)                                              AS total_orders,
       COUNT(*) FILTER (WHERE status = 'delivered')         AS delivered,
       COUNT(*) FILTER (WHERE status = 'cancelled')         AS cancelled,
       COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) AS revenue,
       COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0)  AS revenue_delivered
     FROM delivery_orders
     WHERE establishment_id = $1
       AND created_at::date = CURRENT_DATE`,
    [estId]
  );
  const s = summaryRes.rows[0];

  // Top 5 itens mais pedidos
  const itemsRes = await pool.query(
    `SELECT item->>'name' AS name,
            SUM((item->>'quantity')::int) AS qty
     FROM delivery_orders,
          jsonb_array_elements(items::jsonb) AS item
     WHERE establishment_id = $1
       AND created_at::date = CURRENT_DATE
       AND status != 'cancelled'
     GROUP BY item->>'name'
     ORDER BY qty DESC
     LIMIT 5`,
    [estId]
  );

  // Ticket médio
  const avgTicket = +s.total_orders > 0
    ? (+s.revenue / +s.total_orders).toFixed(2).replace('.', ',')
    : '0,00';

  const topItems = itemsRes.rows.length
    ? itemsRes.rows.map((r: any, i: number) => `  ${i + 1}. ${r.name} — ${r.qty}x`).join('\n')
    : '  (nenhum pedido)';

  const msg = [
    `📊 *Relatório do dia — ${storeName}*`,
    `📅 ${today}`,
    ``,
    `📦 Pedidos recebidos: *${s.total_orders}*`,
    `✅ Entregues: *${s.delivered}*`,
    `❌ Cancelados: *${s.cancelled}*`,
    ``,
    `💰 Receita bruta: *R$ ${(+s.revenue).toFixed(2).replace('.', ',')}*`,
    `🎉 Receita entregue: *R$ ${(+s.revenue_delivered).toFixed(2).replace('.', ',')}*`,
    `🧾 Ticket médio: *R$ ${avgTicket}*`,
    ``,
    `🏆 *Top itens do dia:*`,
    topItems,
  ].join('\n');

  await sendWhatsAppMessage(estId, ownerWhatsApp, msg);
  console.log(`[dailyReport] relatório enviado para ${storeName} (${estId})`);
}
