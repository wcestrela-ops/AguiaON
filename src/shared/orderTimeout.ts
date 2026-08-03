/**
 * Job de timeout de pedidos pendentes.
 * Roda a cada minuto e verifica pedidos que passaram do tempo configurado.
 *
 * Ação configurável por lojista (whatsapp_configs.timeout_action):
 *  - 'notify'  → só renotifica o lojista (padrão)
 *  - 'cancel'  → cancela o pedido e avisa o cliente
 */

import pool from './db';
import { sendWhatsAppMessage } from './waSender';

let running = false;

export function startOrderTimeoutJob(): void {
  // Roda 1 minuto após o boot e depois a cada 60s
  setTimeout(() => {
    runCheck();
    setInterval(runCheck, 60_000);
  }, 60_000);

  console.log('⏱️  Job de timeout de pedidos iniciado.');
}

async function runCheck(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Busca pedidos pendentes que ultrapassaram o timeout do lojista
    const res = await pool.query(`
      SELECT
        o.id, o.order_number, o.daily_code, o.establishment_id,
        o.customer_name, o.customer_phone, o.total, o.created_at,
        o.timeout_notified_at,
        e.name  AS store_name,
        e.owner_whatsapp,
        COALESCE(wc.pending_timeout_minutes, 30) AS timeout_minutes,
        COALESCE(wc.timeout_action, 'notify')    AS timeout_action
      FROM delivery_orders o
      JOIN establishments e ON e.id = o.establishment_id
      LEFT JOIN whatsapp_configs wc ON wc.establishment_id = o.establishment_id
      WHERE o.status = 'pending'
        AND o.created_at < NOW() - (COALESCE(wc.pending_timeout_minutes, 30) || ' minutes')::interval
    `);

    for (const order of res.rows) {
      try {
        if (order.timeout_action === 'cancel') {
          await handleCancel(order);
        } else {
          await handleNotify(order);
        }
      } catch (err: any) {
        console.error(`[orderTimeout] pedido ${order.id}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[orderTimeout] runCheck error:', err.message);
  } finally {
    running = false;
  }
}

async function handleNotify(order: any): Promise<void> {
  // Só renotifica se ainda não notificou, ou se já passou mais de 1h desde a última notificação
  if (order.timeout_notified_at) {
    const lastNotify = new Date(order.timeout_notified_at).getTime();
    if (Date.now() - lastNotify < 60 * 60 * 1000) return; // menos de 1h → ignora
  }

  await pool.query(
    `UPDATE delivery_orders SET timeout_notified_at=NOW() WHERE id=$1`,
    [order.id]
  );

  if (order.owner_whatsapp) {
    const code = order.daily_code ? ` (${order.daily_code})` : '';
    const msg = [
      `⚠️ *Pedido #${order.order_number}${code} ainda pendente!*`,
      `Cliente: ${order.customer_name}`,
      `Total: R$ ${Number(order.total).toFixed(2).replace('.', ',')}`,
      `Criado há ${order.timeout_minutes} minutos. Aguardando sua confirmação.`,
    ].join('\n');
    await sendWhatsAppMessage(order.establishment_id, order.owner_whatsapp, msg);
    console.log(`⚠️  Timeout notificado — pedido #${order.order_number} (${order.store_name})`);
  }
}

async function handleCancel(order: any): Promise<void> {
  await pool.query(
    `UPDATE delivery_orders SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status='pending'`,
    [order.id]
  );
  console.log(`❌ Pedido #${order.order_number} cancelado por timeout (${order.store_name})`);

  // Avisa o cliente
  if (order.customer_phone) {
    const msg = `😔 Seu pedido *#${order.order_number}* foi cancelado automaticamente pois não recebeu confirmação de *${order.store_name}* a tempo. Pedimos desculpas pelo inconveniente.`;
    await sendWhatsAppMessage(order.establishment_id, order.customer_phone, msg);
  }

  // Avisa o lojista
  if (order.owner_whatsapp) {
    const code = order.daily_code ? ` (${order.daily_code})` : '';
    const msg = `❌ Pedido *#${order.order_number}${code}* cancelado automaticamente por timeout de ${order.timeout_minutes} minutos.`;
    await sendWhatsAppMessage(order.establishment_id, order.owner_whatsapp, msg);
  }
}
