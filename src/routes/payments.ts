import { Router } from 'express';
import pool from '../shared/db';
import { sendWhatsAppMessage, msgStatusClienteAsync } from '../shared/waSender';
import { decrypt } from '../shared/cryptoUtil';
import { sseEmitEvent } from './delivery';
import { markInvoicePaid } from '../shared/platformBilling';

// Cria tabela de falhas de webhook na inicialização
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_failures (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        payload JSONB,
        error TEXT,
        establishment_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch { /* ignora se já existe */ }
})();

// Persiste falha de webhook para auditoria (fire-and-forget)
async function logWebhookFailure(provider: string, payload: any, error: string, estId?: string) {
  try {
    await pool.query(
      `INSERT INTO webhook_failures (provider, payload, error, establishment_id)
       VALUES ($1,$2,$3,$4)`,
      [provider, JSON.stringify(payload), error, estId || null]
    );
    if (estId) sseEmitEvent(estId, { type: 'WEBHOOK_FAILURE', provider, error });
  } catch { /* não deve quebrar o fluxo */ }
}


const CYCLE_DAYS: Record<string, number> = {
  weekly: 7, monthly: 30, bimonthly: 60,
  quarterly: 90, semiannual: 180, annual: 365,
};

async function renewGymSubscription(subId: string, estName: string): Promise<void> {
  const subRes = await pool.query(
    `SELECT s.*, c.whatsapp, c.name AS client_name, e.id AS est_id
     FROM gym_subscriptions s
     JOIN gym_clients c ON c.id = s.client_id
     JOIN establishments e ON e.id = s.establishment_id
     WHERE s.id = $1 LIMIT 1`,
    [subId]
  );
  if (!subRes.rows.length) return;
  const sub = subRes.rows[0];

  const days = CYCLE_DAYS[sub.renewal_cycle] || 30;
  const newExpiry = new Date();
  newExpiry.setDate(newExpiry.getDate() + days);
  const newExpiryStr = newExpiry.toISOString().split('T')[0];

  await pool.query(
    `UPDATE gym_subscriptions
     SET status='active', expiry_date=$1, pending_pix_code=NULL, pending_payment_provider=NULL, updated_at=NOW()
     WHERE id=$2`,
    [newExpiryStr, subId]
  );

  await pool.query(
    `INSERT INTO gym_client_notifications
       (establishment_id, client_id, subscription_id, type, title, message)
     VALUES ($1,$2,$3,'renewed',$4,$5)`,
    [sub.est_id, sub.client_id, subId,
     `✅ Plano renovado: ${sub.plan_name}`,
     `Pagamento confirmado! Seu plano foi renovado até ${newExpiry.toLocaleDateString('pt-BR')}.`]
  ).catch(() => {});

  if (sub.whatsapp) {
    const msg = `✅ *Pagamento confirmado!*\n\nOlá, ${sub.client_name}! Seu plano *${sub.plan_name}* na *${estName}* foi renovado com sucesso.\n\nNovo vencimento: *${newExpiry.toLocaleDateString('pt-BR')}*. Obrigado!`;
    sendWhatsAppMessage(sub.est_id, sub.whatsapp, msg).catch(() => {});
  }

  console.log(`✅ [gymRenovacao] Assinatura ${subId} renovada até ${newExpiryStr}`);
}
import { encrypt } from '../shared/cryptoUtil';

const router = Router();

// ─────────────────────────────────────────────────────────────
// GET /api/payments/mp-callback
// Rota de Callback do Mercado Pago para OAuth do Lojista
// ─────────────────────────────────────────────────────────────
const mpOAuthCallback: import('express').RequestHandler = async (req, res) => {
    const { code, state } = req.query; // 'state' deve carregar o ID da loja

    if (!code || !state) {
        return res.status(400).send("Código de autorização ou estado ausente.");
    }

    try {
        // Lê credenciais do banco (admin panel) com fallback para env vars
        const gsRes = await pool.query(
            `SELECT key, value FROM global_settings WHERE key IN ('mp_client_id','mp_client_secret','mp_redirect_uri')`
        );
        const gs: Record<string, string> = {};
        gsRes.rows.forEach((r: any) => { gs[r.key] = r.value; });

        const clientId     = decrypt(gs.mp_client_id     || '') || process.env.MP_CLIENT_ID     || '';
        const clientSecret = decrypt(gs.mp_client_secret  || '') || process.env.MP_CLIENT_SECRET || '';
        const redirectUri  = gs.mp_redirect_uri   || process.env.MP_REDIRECT_URI  || '';

        if (!clientId || !clientSecret || !redirectUri) {
            console.error('[MP OAuth] Credenciais incompletas:', { clientId: !!clientId, clientSecret: !!clientSecret, redirectUri });
            return res.status(500).send('Mercado Pago não configurado. Acesse o painel admin e preencha as credenciais.');
        }

        console.log('[MP OAuth] redirect_uri:', redirectUri);

        const response = await fetch('https://api.mercadopago.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                'client_id': clientId,
                'client_secret': clientSecret,
                'grant_type': 'authorization_code',
                'code': code as string,
                'redirect_uri': redirectUri,
            })
        });

        console.log('[MP OAuth] status da troca:', response.status);

        const data = await response.json();

        if (!response.ok) {
            console.error('Erro OAuth Mercado Pago:', data);
            throw new Error(data.message || "Erro ao trocar código por token.");
        }

        // 2. Salva no Banco de Dados vinculado à loja
        // Ensure mp_public_key column exists
        await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS mp_public_key TEXT`).catch(() => {});

        await pool.query(
            `UPDATE establishments SET
                mp_access_token = $1,
                mp_refresh_token = $2,
                mp_user_id = $3,
                mp_public_key = $4,
                mp_status = true,
                updated_at = NOW()
             WHERE slug = $5`,
            [encrypt(data.access_token), encrypt(data.refresh_token), data.user_id, data.public_key || null, state]
        );

        // Redireciona de volta para o painel do lojista com sucesso
        res.redirect(`/loja?status=mp_connected`);
    } catch (err: any) {
        console.error('Erro no callback MP:', err.message);
        res.status(500).send("Erro ao conectar conta: " + err.message);
    }
};

router.get('/callback', mpOAuthCallback);
router.get('/mp-callback', mpOAuthCallback);

// ─────────────────────────────────────────────────────────────
// POST /api/payments/webhook/asaas
// Recebe notificações de pagamento do Asaas
// ─────────────────────────────────────────────────────────────
router.post('/webhook/asaas', async (req, res) => {
    // Asaas envia sempre 200 esperado antes de qualquer processamento
    res.status(200).send('OK');

    const { event, payment } = req.body;
    // Só nos interessa pagamento confirmado
    if (!['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'].includes(event)) return;
    if (!payment?.externalReference) return;

    const orderId = payment.externalReference;

    try {
        // Fatura de billing da plataforma (Fase 5 — o que a empresa paga a vocês)
        if (orderId.startsWith('platform_')) {
            const invoiceId = orderId.replace('platform_', '');
            await markInvoicePaid(invoiceId);
            console.log(`💰 Asaas PIX confirmado — fatura da plataforma ${invoiceId}`);
            return;
        }

        // Renovação de assinatura gym
        if (orderId.startsWith('gym_')) {
            const subId = orderId.replace('gym_', '');
            const estRes = await pool.query(`SELECT name FROM establishments e JOIN gym_subscriptions s ON s.establishment_id=e.id WHERE s.id=$1 LIMIT 1`, [subId]);
            await renewGymSubscription(subId, estRes.rows[0]?.name || '');
            return;
        }

        const orderRes = await pool.query(
            `SELECT * FROM delivery_orders WHERE id=$1 AND status='pending' AND payment_method='pix'`,
            [orderId]
        );
        if (!orderRes.rows.length) return;
        const order = orderRes.rows[0];

        await pool.query(
            `UPDATE delivery_orders SET payment_status='paid', status='confirmed', updated_at=NOW() WHERE id=$1`,
            [orderId]
        );

        console.log(`💰 Asaas PIX confirmado — pedido #${order.order_number}`);

        if (order.customer_phone) {
            const estRes = await pool.query(`SELECT name FROM establishments WHERE id=$1`, [order.establishment_id]);
            const storeName = estRes.rows[0]?.name || '';
            const msg = await msgStatusClienteAsync(order, 'confirmed', storeName, order.establishment_id);
            if (msg) await sendWhatsAppMessage(order.establishment_id, order.customer_phone, msg);
        }
    } catch (err: any) {
        console.error('[webhook/asaas] FALHA no processamento do pedido', orderId, '—', err.message);
        // Busca estId para notificar o lojista via SSE (best-effort)
        const estLookup = orderId && !orderId.startsWith('gym_')
            ? await pool.query(`SELECT establishment_id FROM delivery_orders WHERE id=$1 LIMIT 1`, [orderId]).catch(() => null)
            : null;
        const estId = estLookup?.rows[0]?.establishment_id;
        await logWebhookFailure('asaas', req.body, err.message, estId);
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/payments/webhook/mercadopago
// Recebe notificações de pagamento do Mercado Pago
// ─────────────────────────────────────────────────────────────
router.get('/webhook/mercadopago', (_req, res) => res.status(200).send('OK'));

router.post('/webhook/mercadopago', async (req, res) => {
    res.status(200).send('OK');

    const { type, data, action } = req.body;

    // Suporta formato Webhooks (type=payment) e IPN legado (action=payment.updated)
    const isPaymentEvent = type === 'payment' || action === 'payment.updated' || action === 'payment.created';
    if (!isPaymentEvent || !data?.id) return;

    let est: any = null;
    try {
        const paymentId = String(data.id);

        // Tenta encontrar o lojista pelo user_id enviado pelo MP (query param ou body)
        const userId = req.query['user_id'] || req.body.user_id;

        let accessToken = '';

        if (userId) {
            const estRes = await pool.query(
                `SELECT id, name, mp_access_token FROM establishments WHERE mp_user_id=$1 LIMIT 1`,
                [String(userId)]
            );
            if (estRes.rows.length) {
                est = estRes.rows[0];
                accessToken = decrypt(est.mp_access_token || '');
            }
        }

        // Fallback: busca qualquer loja com MP conectado para tentar o token
        // (funciona quando MP não envia user_id)
        if (!accessToken) {
            const allRes = await pool.query(
                `SELECT id, name, mp_access_token FROM establishments WHERE mp_status=true AND mp_access_token IS NOT NULL`
            );
            for (const row of allRes.rows) {
                const token = decrypt(row.mp_access_token || '');
                if (!token || token === row.mp_access_token) continue;
                const testRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (testRes.ok) {
                    const testData = await testRes.json() as any;
                    if (testData.id && testData.external_reference) {
                        // Valida que o pedido referenciado pertence a esta loja
                        const ownerCheck = await pool.query(
                            `SELECT id FROM delivery_orders WHERE id=$1 AND establishment_id=$2 LIMIT 1`,
                            [testData.external_reference, row.id]
                        );
                        if (ownerCheck.rows.length) {
                            accessToken = token;
                            est = row;
                            break;
                        }
                    }
                }
            }
        }

        if (!accessToken || !est) {
            console.warn('[webhook/mercadopago] Nenhum token válido encontrado para payment', paymentId);
            return;
        }

        // Busca detalhes do pagamento
        const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const payment = await mpRes.json() as any;

        console.log(`[webhook/mercadopago] payment ${paymentId} status=${payment.status} ext_ref=${payment.external_reference}`);

        if (payment.status !== 'approved') return;

        const orderId = payment.external_reference;
        if (!orderId) return;

        // Renovação de assinatura gym
        if (orderId.startsWith('gym_')) {
            await renewGymSubscription(orderId.replace('gym_', ''), est.name);
            return;
        }

        // Confirma que o pedido pertence à loja identificada (proteção dupla)
        const orderRes = await pool.query(
            `SELECT * FROM delivery_orders WHERE id=$1 AND establishment_id=$2 AND status='pending'`,
            [orderId, est.id]
        );
        if (!orderRes.rows.length) return;
        const order = orderRes.rows[0];

        await pool.query(
            `UPDATE delivery_orders SET payment_status='paid', status='confirmed', updated_at=NOW() WHERE id=$1`,
            [orderId]
        );

        console.log(`💰 Mercado Pago PIX confirmado — pedido #${order.order_number}`);

        if (order.customer_phone) {
            const msg = await msgStatusClienteAsync(order, 'confirmed', est.name, est.id);
            if (msg) await sendWhatsAppMessage(est.id, order.customer_phone, msg);
        }
    } catch (err: any) {
        console.error('[webhook/mercadopago] FALHA no processamento —', err.message);
        await logWebhookFailure('mercadopago', req.body, err.message, est?.id);
    }
});

export default router;
