/**
 * Utilitário de envio WhatsApp — AG-ON
 *
 * Suporta dois modos por estabelecimento:
 *  - evolution  → Evolution API própria do AG-ON (instância est_UUID)
 *  - custom     → API de terceiros (URL + token configurados pelo lojista)
 *
 * Mensagens de status são customizáveis pelo lojista via whatsapp_configs.
 * Variáveis disponíveis nos templates: {nome}, {pedido}, {codigo}, {total}, {loja}
 */

import pool from './db';
import { decrypt, isSensitiveKey } from './cryptoUtil';

// ─── Cache de config Evolution (global, 60s) ─────────────────
let evoCacheTs = 0;
let evoCache = { url: '', token: '' };

async function getEvolutionConfig(): Promise<{ url: string; token: string }> {
  if (Date.now() - evoCacheTs < 60_000) return evoCache;
  const res = await pool.query(
    `SELECT key, value FROM global_settings WHERE category='WHATSAPP' AND key IN ('evolution_url','evolution_token')`
  );
  const map: Record<string, string> = {};
  for (const r of res.rows) {
    map[r.key] = isSensitiveKey(r.key) ? decrypt(r.value) : r.value;
  }
  evoCache = { url: map.evolution_url || '', token: map.evolution_token || '' };
  evoCacheTs = Date.now();
  return evoCache;
}

// ─── Config do lojista (cache curto por estId) ────────────────
const waConfigCache: Record<string, { data: any; ts: number }> = {};

async function getEstabWAConfig(estId: string): Promise<any> {
  const cached = waConfigCache[estId];
  if (cached && Date.now() - cached.ts < 30_000) return cached.data;

  const res = await pool.query(
    `SELECT api_type, custom_api_url, custom_api_token,
            msg_new_order, msg_confirmed, msg_preparing, msg_delivering,
            msg_ready_delivery, msg_ready_pickup, msg_delivered, msg_cancelled
     FROM whatsapp_configs WHERE establishment_id=$1`,
    [estId]
  );
  const data = res.rows[0] || {};
  // Descriptografa o token da API customizada
  if (data.custom_api_token) {
    data.custom_api_token = decrypt(data.custom_api_token);
  }
  waConfigCache[estId] = { data, ts: Date.now() };
  return data;
}

/** Invalida cache de um estabelecimento (chamar após salvar config) */
export function invalidateWAConfigCache(estId: string): void {
  delete waConfigCache[estId];
}

// ─── Substituição de variáveis no template ────────────────────
function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

// ─── Envio via Evolution API ─────────────────────────────────
async function sendViaEvolution(estId: string, phone: string, text: string): Promise<void> {
  const { url, token } = await getEvolutionConfig();
  if (!url || !token) {
    console.warn('[waSender] Evolution não configurado.');
    return;
  }

  // Busca o nome real da instância salvo no banco (pode diferir do padrão est_UUID)
  const cfgRes = await pool.query(
    `SELECT instance_name FROM whatsapp_configs WHERE establishment_id=$1`, [estId]
  );
  const instance = cfgRes.rows[0]?.instance_name || `est_${estId}`;
  const digits = phone.replace(/\D/g, '');
  // Garante código do país Brasil (55) se não informado
  const normalized = digits.startsWith('55') ? digits : `55${digits}`;
  const jid = phone.includes('@') ? phone : `${normalized}@s.whatsapp.net`;

  const headers = { 'Content-Type': 'application/json', apikey: token };

  const bodyV2 = JSON.stringify({ number: jid, text, options: { delay: 0, presence: 'composing' } });
  const bodyV1 = JSON.stringify({ number: jid, text, linkPreview: false });

  let res = await fetch(`${url}/message/sendText/${instance}`, { method: 'POST', headers, body: bodyV2 });

  if (res.status === 404) {
    res = await fetch(`${url}/messages/sendText/${instance}`, { method: 'POST', headers, body: bodyV1 });
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[waSender/evolution] HTTP=${res.status} instance=${instance} err=${errText}`);
  } else {
    console.log(`[waSender/evolution] ✅ enviado → ${instance} phone=${phone.slice(0,8)}...`);
  }
}

// ─── Envio via API de terceiros ───────────────────────────────
async function sendViaCustomAPI(apiUrl: string, apiToken: string, phone: string, text: string): Promise<void> {
  const cleanPhone = phone.replace(/\D/g, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

  // Tenta detectar se é URL com query params (token na URL) ou header
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ number: cleanPhone, text, message: text, phone: cleanPhone }),
  });
  if (!res.ok) console.error(`[waSender/custom] ${res.status} ${await res.text()}`);
}

// ─── Função principal de envio ────────────────────────────────

/**
 * Envia mensagem WhatsApp respeitando a configuração da API do lojista.
 */
// Garante coluna LGPD na primeira chamada
let _lgpdMigrated = false;
async function ensureLgpdColumns() {
  if (_lgpdMigrated) return;
  _lgpdMigrated = true;
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_optout BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_optout_at TIMESTAMPTZ`).catch(() => {});
}

export async function sendWhatsAppMessage(estId: string, phone: string, text: string): Promise<void> {
  if (!phone || !text) return;
  try {
    await ensureLgpdColumns();
    // LGPD: respeita opt-out do usuário antes de qualquer envio
    const optRes = await pool.query(
      `SELECT whatsapp_optout FROM users WHERE whatsapp = $1 LIMIT 1`,
      [phone.replace(/\D/g, '')]
    );
    if (optRes.rows[0]?.whatsapp_optout === true) {
      console.log(`[waSender] Envio bloqueado por opt-out LGPD — phone: ${phone}`);
      return;
    }

    const cfg = await getEstabWAConfig(estId);
    if (cfg.api_type === 'custom' && cfg.custom_api_url) {
      await sendViaCustomAPI(cfg.custom_api_url, cfg.custom_api_token || '', phone, text);
    } else {
      await sendViaEvolution(estId, phone, text);
    }
  } catch (err: any) {
    console.error('[waSender] Erro:', err.message);
  }
}

/** Busca o WhatsApp do dono do estabelecimento */
export async function getOwnerWhatsApp(estId: string): Promise<string | null> {
  const res = await pool.query(`SELECT owner_whatsapp FROM establishments WHERE id=$1`, [estId]);
  return res.rows[0]?.owner_whatsapp || null;
}

// ─── Templates de mensagem ────────────────────────────────────

/** Monta as variáveis de substituição de um pedido */
function orderVars(order: any, storeName = ''): Record<string, string> {
  return {
    nome:              order.customer_name || '',
    pedido:            String(order.order_number || ''),
    codigo:            order.daily_code || '',
    total:             `R$ ${Number(order.total || 0).toFixed(2).replace('.', ',')}`,
    loja:              storeName,
    endereco:          order.customer_address || '',
    pagamento:         order.payment_method === 'pix' ? 'PIX' : order.payment_method === 'cartao' ? 'Cartão' : 'Na entrega',
    entregador:        order.driver_name || '',
    fone_entregador:   order.driver_phone || '',
  };
}

export function msgNovosPedidoLojista(order: any, storeName: string): string {
  const source = order.source === 'agata_wa' ? '🤖 via Ágata WA' : order.source === 'totem' ? '📟 Totem' : '🌐 Online';
  const items = (order.items || []).map((it: any) =>
    `  • ${it.quantity}x ${it.name}${it.variant ? ` (${it.variant})` : ''} — R$${(+it.price * it.quantity).toFixed(2).replace('.', ',')}`
  ).join('\n');

  return [
    `🔔 *Novo Pedido #${order.order_number}* — ${storeName}`,
    order.daily_code ? `🏷️ Código do dia: *${order.daily_code}*` : '',
    `📦 Origem: ${source}`,
    ``,
    `👤 Cliente: ${order.customer_name}`,
    order.customer_phone ? `📞 ${order.customer_phone}` : '',
    order.delivery_type === 'delivery'
      ? `📍 Endereço: ${order.customer_address || 'Não informado'}`
      : `🏪 Retirada na loja`,
    ``,
    `*Itens:*`,
    items,
    ``,
    `💰 Subtotal: R$${(+order.subtotal).toFixed(2).replace('.', ',')}`,
    order.delivery_tax > 0 ? `🛵 Entrega: R$${(+order.delivery_tax).toFixed(2).replace('.', ',')}` : '',
    `💳 Total: *R$${(+order.total).toFixed(2).replace('.', ',')}*`,
    `💳 Pagamento: ${order.payment_method === 'pix' ? 'PIX' : order.payment_method === 'cartao' ? 'Cartão' : 'Na entrega'}`,
    order.notes ? `📝 Obs: ${order.notes}` : '',
  ].filter(Boolean).join('\n');
}

export async function msgConfirmacaoCliente(order: any, storeName: string, baseUrl: string, estId: string): Promise<string> {
  const cfg = await getEstabWAConfig(estId).catch(() => ({}));
  const vars = { ...orderVars(order, storeName), link: `${baseUrl}/pedido/${order.id}` };
  if (cfg.msg_new_order) return applyTemplate(cfg.msg_new_order, vars);

  const items = (order.items || []).map((it: any) =>
    `  • ${it.quantity}x ${it.name}${it.variant ? ` (${it.variant})` : ''}`
  ).join('\n');

  return [
    `✅ *Pedido recebido, ${order.customer_name}!*`,
    ``,
    `*${storeName}* recebeu seu pedido e já está analisando! 🎉`,
    ``,
    `🧾 *#${order.order_number}*${order.daily_code ? ` (cód. ${order.daily_code})` : ''}`,
    items ? `\n*Itens:*\n${items}` : '',
    ``,
    `💰 Total: *R$${(+order.total).toFixed(2).replace('.', ',')}*`,
    `💳 Pagamento: ${order.payment_method === 'pix' ? 'PIX' : order.payment_method === 'cartao' ? 'Cartão' : 'Na entrega'}`,
    order.delivery_type === 'pickup' ? `🏪 Retirada na loja` : `📍 Entrega: ${order.customer_address || 'endereço registrado'}`,
    ``,
    `📲 Acompanhe em tempo real:`,
    `${baseUrl}/pedido/${order.id}`,
  ].filter(l => l !== '').join('\n');
}

/**
 * Retorna a mensagem de status para o cliente.
 * Usa o template customizado do lojista se disponível.
 */
export async function msgStatusClienteAsync(
  order: any,
  status: string,
  storeName: string,
  estId: string
): Promise<string> {
  const cfg = await getEstabWAConfig(estId).catch(() => ({}));
  const vars = orderVars(order, storeName);

  // Mapa status → coluna de template
  const templateKey: Record<string, string> = {
    confirmed:  'msg_confirmed',
    preparing:  'msg_preparing',
    delivering: 'msg_delivering',
    delivered:  'msg_delivered',
    cancelled:  'msg_cancelled',
  };

  // "Pronto" tem variação delivery vs pickup
  if (status === 'ready') {
    const key = order.delivery_type === 'pickup' ? 'msg_ready_pickup' : 'msg_ready_delivery';
    const tpl = cfg[key];
    if (tpl) return applyTemplate(tpl, vars);
  }

  const key = templateKey[status];
  if (key && cfg[key]) return applyTemplate(cfg[key], vars);

  // Defaults
  const defaults: Record<string, string> = {
    confirmed:  `✅ Seu pedido *#${order.order_number}* foi *confirmado* por ${storeName}!`,
    preparing:  `👨‍🍳 Seu pedido *#${order.order_number}* está sendo *preparado*!`,
    delivering: order.driver_name
      ? `🛵 Seu pedido *#${order.order_number}* *saiu para entrega*!\n\nEntregador: *${order.driver_name}*${order.driver_phone ? `\n📞 ${order.driver_phone}` : ''}\n\nFique de olho na porta! 🚪`
      : `🛵 Seu pedido *#${order.order_number}* *saiu para entrega*! Fique de olho na porta. 🚪`,
    delivered:  `🎉 Pedido *#${order.order_number}* *entregue*! Bom apetite! 😋`,
    cancelled:  `❌ Seu pedido *#${order.order_number}* foi *cancelado*. Fale com ${storeName} para mais informações.`,
  };
  return defaults[status] || '';
}

/** Versão síncrona mantida para compatibilidade com tryDeliveryCommand */
export function msgStatusCliente(order: any, status: string, storeName: string): string {
  const defaults: Record<string, string> = {
    confirmed:  `✅ Seu pedido *#${order.order_number}* foi *confirmado* por ${storeName}!`,
    preparing:  `👨‍🍳 Seu pedido *#${order.order_number}* está sendo *preparado*!`,
    delivering: `🛵 Seu pedido *#${order.order_number}* *saiu para entrega*!`,
    delivered:  `🎉 Pedido *#${order.order_number}* *entregue*! Bom apetite! 😋`,
    cancelled:  `❌ Seu pedido *#${order.order_number}* foi *cancelado*. Fale com ${storeName}.`,
  };
  return defaults[status] || '';
}

export function msgEntregador(order: any, storeName: string): string {
  const gpsLink = (order.lat && order.lng)
    ? `https://www.google.com/maps?q=${order.lat},${order.lng}`
    : null;
  const textLink = order.customer_address
    ? `https://maps.google.com/?q=${encodeURIComponent(order.customer_address)}`
    : null;
  const lines: string[] = [
    `🛵 *Nova entrega — ${storeName}*`,
    `Pedido *#${order.order_number}*${order.daily_code ? ` (${order.daily_code})` : ''}`,
    ``,
    `👤 Cliente: ${order.customer_name}`,
    `📞 Telefone: ${order.customer_phone || 'Não informado'}`,
    `📍 Endereço: ${order.customer_address || 'Retirada na loja'}`,
    `💰 Total: R$${(+order.total).toFixed(2).replace('.', ',')}`,
    `💳 Pagamento: ${order.payment_method === 'pix' ? 'PIX (já pago)' : order.payment_method === 'cartao' ? 'Cartão na entrega' : 'Dinheiro na entrega'}`,
    order.notes ? `📝 Obs: ${order.notes}` : '',
  ];
  if (gpsLink) {
    lines.push('');
    lines.push(`📌 *Localização GPS (precisa):* ${gpsLink}`);
    if (textLink) lines.push(`🗺️ *Por endereço:* ${textLink}`);
  } else if (textLink) {
    lines.push('');
    lines.push(`🗺️ ${textLink}`);
  }
  return lines.filter(Boolean).join('\n');
}
