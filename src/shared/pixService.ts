/**
 * Gerador de código PIX para pedidos do delivery.
 *
 * Suporta 3 modos conforme configuração do lojista:
 *  - manual_pix   → retorna a chave cadastrada formatada (copia e cola manual)
 *  - asaas        → gera cobrança via API Asaas e retorna o Pix Copia e Cola
 *  - mercadopago  → gera pagamento PIX via API MP e retorna o qr_code
 *
 * Failover: o método preferido do lojista é tentado primeiro; se falhar (API fora
 * do ar, credencial inválida, etc.) ou não estiver configurado, tenta os demais
 * métodos configurados em ordem fixa (asaas → mercadopago → manual_pix), no mesmo
 * espírito da cadeia de failover do smsSender.ts.
 */

import pool from './db';
import { decrypt, isSensitiveKey } from './cryptoUtil';

interface EstabPaymentConfig {
  preferred_payment_method: string;
  pix_key_type: string;
  pix_key_value: string;
  pix_receiver_name: string;
  asaas_api_key: string;
  asaas_wallet_id: string;
  mp_access_token: string;
  name: string;
}

async function getEstabConfig(estId: string): Promise<EstabPaymentConfig | null> {
  const res = await pool.query(
    `SELECT preferred_payment_method, pix_key_type, pix_key_value, pix_receiver_name,
            asaas_api_key, asaas_wallet_id, mp_access_token, name
     FROM establishments WHERE id = $1`,
    [estId]
  );
  if (!res.rows.length) return null;

  const config = res.rows[0];
  // Descriptografa chaves sensíveis
  for (const key in config) {
    if (isSensitiveKey(key) && typeof config[key] === 'string') {
      config[key] = decrypt(config[key]);
    }
  }
  return config;
}

// ─── PIX Manual ───────────────────────────────────────────────
function buildManualPixMessage(cfg: EstabPaymentConfig, total: number, orderNumber: number): string {
  const lines = [
    `💳 *Pagamento via PIX*`,
    ``,
    `Valor: *R$ ${total.toFixed(2).replace('.', ',')}*`,
    ``,
    `Chave PIX (${cfg.pix_key_type || 'chave'}):`,
    `\`${cfg.pix_key_value}\``,
  ];
  if (cfg.pix_receiver_name) lines.push(``, `Favorecido: ${cfg.pix_receiver_name}`);
  lines.push(``, `Após o pagamento, envie o comprovante aqui. Pedido *#${orderNumber}*.`);
  return lines.join('\n');
}

// ─── Asaas ────────────────────────────────────────────────────
// Fix de produção 24: além do Pix Copia e Cola, agora também devolve
// `invoiceUrl` (a fatura hospedada no Asaas — o link que aparece como
// "Fatura:" nas mensagens de cobrança/pagamento confirmado) e
// `invoiceNumber` (o "N°..." que identifica a fatura pro cliente, diferente
// do id interno do pagamento) — os dois já vêm de graça na resposta da
// criação do pagamento, só não eram lidos antes.
async function generateAsaasPix(cfg: EstabPaymentConfig, orderId: string, total: number, customerName: string): Promise<{ payload: string; paymentId: string; invoiceUrl: string | null; invoiceNumber: string | null } | null> {
  try {
    const apiKey = cfg.asaas_api_key;
    const baseUrl = 'https://api.asaas.com/v3';

    // 1. Busca ou cria cliente no Asaas
    const customerSearch = await fetch(
      `${baseUrl}/customers?name=${encodeURIComponent(customerName)}&limit=1`,
      { headers: { access_token: apiKey } }
    );
    const customerData = await customerSearch.json() as any;
    let customerId: string;

    if (customerData.data?.length) {
      customerId = customerData.data[0].id;
    } else {
      const createCustomer = await fetch(`${baseUrl}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', access_token: apiKey },
        body: JSON.stringify({ name: customerName }),
      });
      const newCustomer = await createCustomer.json() as any;
      customerId = newCustomer.id;
    }

    if (!customerId) return null;

    // 2. Cria cobrança PIX
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 1);
    const dueDateStr = dueDate.toISOString().split('T')[0];

    const chargeRes = await fetch(`${baseUrl}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: apiKey },
      body: JSON.stringify({
        customer: customerId,
        billingType: 'PIX',
        value: total,
        dueDate: dueDateStr,
        description: `Pedido #${orderId.slice(0, 8).toUpperCase()} — ${cfg.name}`,
        externalReference: orderId,
      }),
    });
    const charge = await chargeRes.json() as any;

    if (!charge.id) return null;

    // 3. Busca o Pix Copia e Cola
    const pixRes = await fetch(`${baseUrl}/payments/${charge.id}/pixQrCode`, {
      headers: { access_token: apiKey },
    });
    const pixData = await pixRes.json() as any;

    if (!pixData.payload) return null;
    return {
      payload: pixData.payload, // copia e cola
      paymentId: charge.id,
      invoiceUrl: charge.invoiceUrl || null,
      invoiceNumber: charge.invoiceNumber || null,
    };
  } catch (err: any) {
    console.error('[pixService] Asaas error:', err.message);
    return null;
  }
}

// ─── Mercado Pago ─────────────────────────────────────────────
async function generateMercadoPagoPix(
  cfg: EstabPaymentConfig,
  orderId: string,
  total: number,
  customerName: string,
  applicationFeePercent = 0
): Promise<string | null> {
  try {
    const token = cfg.mp_access_token;
    console.log(`[pixService/MP] gerando PIX — order=${orderId} total=${total} token=${token ? token.slice(0, 12) + '...' : 'VAZIO'}`);

    const applicationFee = applicationFeePercent > 0
      ? parseFloat((total * applicationFeePercent / 100).toFixed(2))
      : undefined;

    const payload: Record<string, any> = {
      transaction_amount: total,
      payment_method_id: 'pix',
      payer: {
        email: `pedido_${orderId.slice(0, 8)}@agonfood.com`,
        first_name: customerName.split(' ')[0] || 'Cliente',
        last_name: customerName.split(' ').slice(1).join(' ') || 'Cliente',
      },
      description: `Pedido — ${cfg.name}`,
      external_reference: orderId,
      notification_url: 'https://ag-on.com/api/payments/webhook/mercadopago?source_news=webhooks',
    };

    if (applicationFee) payload.application_fee = applicationFee;

    const res = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Idempotency-Key': orderId,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json() as any;
    console.log(`[pixService/MP] resposta HTTP=${res.status} id=${data.id} status=${data.status} error=${JSON.stringify(data.message || data.cause || '')}`);

    if (!res.ok) {
      console.error('[pixService/MP] payload enviado:', JSON.stringify(payload));
      return null;
    }

    return data?.point_of_interaction?.transaction_data?.qr_code || null;
  } catch (err: any) {
    console.error('[pixService] MercadoPago error:', err.message);
    return null;
  }
}

// ─── Cadeia de failover ─────────────────────────────────────────

export type PaymentMethod = 'manual_pix' | 'asaas' | 'mercadopago';

const FALLBACK_ORDER: PaymentMethod[] = ['asaas', 'mercadopago', 'manual_pix'];

/**
 * Monta a cadeia de métodos a tentar, na ordem: preferido do lojista primeiro,
 * depois os demais configurados (ordem fixa), pulando qualquer método cuja
 * credencial obrigatória não esteja presente. Função pura — sem I/O — para
 * ser testável sem banco/rede (ver src/__tests__/pixService.test.ts).
 */
export function buildPaymentChain(cfg: {
  preferred_payment_method?: string | null;
  asaas_api_key?: string | null;
  mp_access_token?: string | null;
  pix_key_value?: string | null;
}): PaymentMethod[] {
  const isConfigured = (method: PaymentMethod): boolean => {
    if (method === 'asaas') return Boolean(cfg.asaas_api_key);
    if (method === 'mercadopago') return Boolean(cfg.mp_access_token);
    if (method === 'manual_pix') return Boolean(cfg.pix_key_value);
    return false;
  };

  const raw = cfg.preferred_payment_method || 'manual_pix';
  const preferred: PaymentMethod = raw === 'mp' ? 'mercadopago' : (raw as PaymentMethod);

  const chain: PaymentMethod[] = [];
  if (isConfigured(preferred)) chain.push(preferred);
  for (const method of FALLBACK_ORDER) {
    if (method !== preferred && isConfigured(method) && !chain.includes(method)) {
      chain.push(method);
    }
  }
  return chain;
}

// ─── Função principal ─────────────────────────────────────────

export interface PixResult {
  /** Código copia-e-cola ou chave manual */
  code: string;
  /** Mensagem formatada pronta para enviar ao cliente */
  message: string;
  provider: PaymentMethod;
  /** true se o método preferido falhou e um método de fallback foi usado */
  used_failover: boolean;
  /** Id da cobrança no provedor (hoje só preenchido pra Asaas) — usado pra
   *  vincular a nota fiscal (scheduleInvoice) diretamente a essa cobrança. */
  provider_payment_id?: string;
  /** Fix de produção 24 — só preenchido pra Asaas: link da fatura hospedada
   *  (o que aparece como "Fatura:" na mensagem de cobrança/pagamento) e o
   *  número dela (o "N°..." que o cliente vê, diferente do id interno). */
  invoice_url?: string | null;
  invoice_number?: string | null;
}

/** Gera PIX para renovação de assinatura gym. Usa prefixo `gym_` no external_reference. */
export async function generateGymPix(
  estId: string,
  subId: string,
  total: number,
  clientName: string,
  clientEmail?: string
): Promise<PixResult | null> {
  const cfg = await getEstabConfig(estId);
  if (!cfg) return null;

  const chain = buildPaymentChain(cfg);
  if (!chain.length) return null;

  const externalRef = `gym_${subId}`;
  const description = `Renovação de plano — ${cfg.name}`;
  const totalFmt = `R$ ${total.toFixed(2).replace('.', ',')}`;

  for (let i = 0; i < chain.length; i++) {
    const method = chain[i];
    const usedFailover = i > 0;

    if (method === 'manual_pix') {
      const code = cfg.pix_key_value;
      const message = [
        `💳 *Renovação do seu plano*`,
        ``,
        `Valor: *${totalFmt}*`,
        ``,
        `Chave PIX (${cfg.pix_key_type || 'chave'}):`,
        `\`${code}\``,
        ``,
        cfg.pix_receiver_name ? `Favorecido: ${cfg.pix_receiver_name}` : '',
        ``,
        `Após pagar, envie o comprovante aqui para confirmar a renovação.`,
      ].filter(l => l !== undefined).join('\n');
      return { code, message, provider: 'manual_pix', used_failover: usedFailover };
    }

    if (method === 'asaas') {
      const asaas = await generateAsaasPix(cfg, externalRef, total, clientName);
      if (!asaas) { console.warn(`[pixService/gym] asaas falhou (est=${estId}), tentando próximo da cadeia...`); continue; }
      const code = asaas.payload;
      const message = [
        `💳 *Renovação do seu plano — ${cfg.name}*`,
        ``,
        `Valor: *${totalFmt}*`,
        ``,
        `Pix Copia e Cola:`,
        `\`${code}\``,
        ``,
        `⏱️ Válido por 24h. Após pagar a renovação é automática!`,
      ].join('\n');
      return { code, message, provider: 'asaas', used_failover: usedFailover };
    }

    if (method === 'mercadopago') {
      // Usa email real do cliente ou email genérico
      const email = clientEmail || `cliente_${subId.slice(0, 8)}@agonfood.com`;
      const code = await generateMercadoPagoPixWithEmail(cfg, externalRef, total, clientName, email, description);
      if (!code) { console.warn(`[pixService/gym] mercadopago falhou (est=${estId}), tentando próximo da cadeia...`); continue; }
      const message = [
        `💳 *Renovação do seu plano — ${cfg.name}*`,
        ``,
        `Valor: *${totalFmt}*`,
        ``,
        `Pix Copia e Cola:`,
        `\`${code}\``,
        ``,
        `⏱️ Após pagar a renovação é automática!`,
      ].join('\n');
      return { code, message, provider: 'mercadopago', used_failover: usedFailover };
    }
  }

  return null;
}

/**
 * Gera PIX para a mensalidade do módulo Rastreamento (cobrança do lojista
 * ao cliente final dono do veículo). Usa prefixo `frota_` no
 * external_reference — mesma cadeia de fallback e mesmo padrão de
 * generateGymPix(), portado do serviço financeiro do Águia Auto
 * (services/api/src/services/financeiro-service.js) e adaptado ao modelo
 * multi-tenant do AguiaON (credenciais do próprio lojista).
 */
export async function generateFrotaPix(
  estId: string,
  chargeId: string,
  total: number,
  clientName: string,
  clientEmail?: string
): Promise<PixResult | null> {
  const cfg = await getEstabConfig(estId);
  if (!cfg) return null;

  const chain = buildPaymentChain(cfg);
  if (!chain.length) return null;

  const externalRef = `frota_${chargeId}`;
  const description = `Mensalidade de rastreamento — ${cfg.name}`;
  const totalFmt = `R$ ${total.toFixed(2).replace('.', ',')}`;

  for (let i = 0; i < chain.length; i++) {
    const method = chain[i];
    const usedFailover = i > 0;

    if (method === 'manual_pix') {
      const code = cfg.pix_key_value;
      const message = [
        `📡 *Mensalidade de rastreamento*`,
        ``,
        `Valor: *${totalFmt}*`,
        ``,
        `Chave PIX (${cfg.pix_key_type || 'chave'}):`,
        `\`${code}\``,
        ``,
        cfg.pix_receiver_name ? `Favorecido: ${cfg.pix_receiver_name}` : '',
        ``,
        `Após pagar, envie o comprovante aqui para confirmar.`,
      ].filter(l => l !== undefined).join('\n');
      return { code, message, provider: 'manual_pix', used_failover: usedFailover };
    }

    if (method === 'asaas') {
      const asaas = await generateAsaasPix(cfg, externalRef, total, clientName);
      if (!asaas) { console.warn(`[pixService/frota] asaas falhou (est=${estId}), tentando próximo da cadeia...`); continue; }
      const code = asaas.payload;
      const message = [
        `📡 *Mensalidade de rastreamento — ${cfg.name}*`,
        ``,
        `Valor: *${totalFmt}*`,
        ``,
        `Pix Copia e Cola:`,
        `\`${code}\``,
        ``,
        `⏱️ Válido por 24h. Após pagar a confirmação é automática!`,
      ].join('\n');
      return {
        code, message, provider: 'asaas', used_failover: usedFailover, provider_payment_id: asaas.paymentId,
        invoice_url: asaas.invoiceUrl, invoice_number: asaas.invoiceNumber,
      };
    }

    if (method === 'mercadopago') {
      const email = clientEmail || `cliente_${chargeId.slice(0, 8)}@agonfood.com`;
      const code = await generateMercadoPagoPixWithEmail(cfg, externalRef, total, clientName, email, description);
      if (!code) { console.warn(`[pixService/frota] mercadopago falhou (est=${estId}), tentando próximo da cadeia...`); continue; }
      const message = [
        `📡 *Mensalidade de rastreamento — ${cfg.name}*`,
        ``,
        `Valor: *${totalFmt}*`,
        ``,
        `Pix Copia e Cola:`,
        `\`${code}\``,
        ``,
        `⏱️ Após pagar a confirmação é automática!`,
      ].join('\n');
      return { code, message, provider: 'mercadopago', used_failover: usedFailover };
    }
  }

  return null;
}

async function generateMercadoPagoPixWithEmail(
  cfg: EstabPaymentConfig,
  externalRef: string,
  total: number,
  customerName: string,
  email: string,
  description: string
): Promise<string | null> {
  try {
    const res = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.mp_access_token}`,
        'X-Idempotency-Key': externalRef,
      },
      body: JSON.stringify({
        transaction_amount: total,
        payment_method_id: 'pix',
        payer: {
          email,
          first_name: customerName.split(' ')[0],
          last_name: customerName.split(' ').slice(1).join(' ') || 'Cliente',
        },
        description,
        notification_url: 'https://ag-on.com/api/payments/webhook/mercadopago?source_news=webhooks',
        external_reference: externalRef,
      }),
    });
    const data = await res.json() as any;
    return data?.point_of_interaction?.transaction_data?.qr_code || null;
  } catch (err: any) {
    console.error('[pixService] MercadoPago gym error:', err.message);
    return null;
  }
}

export async function generatePix(
  estId: string,
  orderId: string,
  orderNumber: number,
  total: number,
  customerName: string
): Promise<PixResult | null> {
  const cfg = await getEstabConfig(estId);
  if (!cfg) return null;

  const chain = buildPaymentChain(cfg);
  if (!chain.length) return null;

  for (let i = 0; i < chain.length; i++) {
    const method = chain[i];
    const usedFailover = i > 0;

    // ── Manual PIX ──
    if (method === 'manual_pix') {
      const message = buildManualPixMessage(cfg, total, orderNumber);
      return { code: cfg.pix_key_value, message, provider: 'manual_pix', used_failover: usedFailover };
    }

    // ── Asaas ──
    if (method === 'asaas') {
      const asaas = await generateAsaasPix(cfg, orderId, total, customerName);
      if (!asaas) { console.warn(`[pixService] asaas falhou (est=${estId}, order=${orderId}), tentando próximo da cadeia...`); continue; }
      const code = asaas.payload;
      const message = [
        `💳 *Pague via PIX — Pedido #${orderNumber}*`,
        ``,
        `Valor: *R$ ${total.toFixed(2).replace('.', ',')}*`,
        ``,
        `👇 Copie o código PIX na próxima mensagem e cole no app do seu banco.`,
        `⏱️ Válido por 24 horas. Após pagar, envie o comprovante aqui.`,
      ].join('\n');
      return { code, message, provider: 'asaas', used_failover: usedFailover };
    }

    // ── Mercado Pago ──
    if (method === 'mercadopago') {
      // Busca taxa da plataforma para split
      const feeRes = await pool.query(`SELECT value FROM global_settings WHERE key='platform_fee_percent' LIMIT 1`);
      const feePercent = parseFloat(feeRes.rows[0]?.value || '0') || 0;
      const code = await generateMercadoPagoPix(cfg, orderId, total, customerName, feePercent);
      if (!code) { console.warn(`[pixService] mercadopago falhou (est=${estId}, order=${orderId}), tentando próximo da cadeia...`); continue; }
      const message = [
        `💳 *Pague via PIX — Pedido #${orderNumber}*`,
        ``,
        `Valor: *R$ ${total.toFixed(2).replace('.', ',')}*`,
        ``,
        `👇 Copie o código PIX na próxima mensagem e cole no app do seu banco.`,
        `⏱️ Após pagar, envie o comprovante aqui.`,
      ].join('\n');
      return { code, message, provider: 'mercadopago', used_failover: usedFailover };
    }
  }

  console.error(`[pixService] todos os métodos configurados falharam (est=${estId}, order=${orderId})`);
  return null;
}
