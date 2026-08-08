import { Router } from 'express';
import crypto from 'crypto';
import pool from '../shared/db';
import { loadAIConfig, askAI, type AIMessage } from '../shared/aiProvider';
import { buildAgataPromptText, applyCoupon } from './delivery';
import { msgStatusCliente } from '../shared/waSender';
import { checkStoreOpen } from '../shared/businessHours';
import { decrypt } from '../shared/cryptoUtil';

const router = Router();

/**
 * Remove o DDI 55 (Brasil) do número vindo da Evolution API.
 * A Evolution entrega: 559998158272@s.whatsapp.net
 * O banco armazena:    9998158272  (sem DDI)
 * Se o número tiver 12+ dígitos e começar com 55 → remove o 55.
 */
function stripCountryCode(jid: string): string {
  const digits = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length >= 12) return digits.slice(2);
  return digits;
}

// ─────────────────────────────────────────────────────────────
// POST /webhooks/evolution
// Valida assinatura HMAC-SHA256 se WEBHOOK_SECRET estiver configurado
// ─────────────────────────────────────────────────────────────
router.post('/evolution', async (req, res) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signature) {
      return res.status(401).send('Missing signature');
    }
    const rawBody = JSON.stringify(req.body);
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).send('Invalid signature');
    }
  }
  const data = req.body;

  if (data.event !== 'messages.upsert') return res.status(200).send('Event ignored');

  const message = data.data;
  const fromMe  = message?.key?.fromMe === true;

  const remoteJid    = message?.key?.remoteJid || '';
  const instanceName = data.instance || '';
  const messageText  = message?.message?.conversation
                    || message?.message?.extendedTextMessage?.text
                    || '';

  // Lookup estId pelo instance_name no banco (suporta qualquer formato de nome)
  try {
    const instRes = await pool.query(
      `SELECT establishment_id FROM whatsapp_configs WHERE instance_name=$1 LIMIT 1`,
      [instanceName]
    );
    // Fallback legado: nome no formato est_<UUID>
    const estId = instRes.rows[0]?.establishment_id
      || (instanceName.startsWith('est_') ? instanceName.replace('est_', '') : null);
    if (!estId) return res.status(200).send('Instance not found');

    // Persiste mensagem no banco para histórico do chat
    const msgTimestamp = message?.messageTimestamp || Math.floor(Date.now() / 1000);
    const msgType = Object.keys(message?.message || {})[0] || 'conversation';
    // Salva com o JID exato do Evolution para o lookup ser consistente
    await pool.query(
      `INSERT INTO wa_messages
         (establishment_id, remote_jid, from_me, message_text, message_type, wa_timestamp, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (establishment_id, remote_jid, wa_timestamp, from_me) DO NOTHING`,
      [estId, remoteJid, fromMe, messageText, msgType, msgTimestamp, JSON.stringify(message)]
    ).catch(() => {}); // ignora se tabela ainda não existe (migração lazy)

    // Emite evento wa_message para o painel do lojista (chat em tempo real)
    const { emitToStore } = await import('../shared/socketio');
    emitToStore(estId, 'wa_message', {
      from:        remoteJid,
      fromMe,
      text:        messageText,
      timestamp:   msgTimestamp,
      messageType: msgType,
    });

    // Mensagens próprias (fromMe) não passam pela IA/flows
    if (!message || fromMe) return res.status(200).send('OK');

    const [configRes, globalRes] = await Promise.all([
      pool.query(`SELECT * FROM whatsapp_configs WHERE establishment_id=$1`, [estId]),
      pool.query(`SELECT key, value FROM global_settings WHERE category IN ('WHATSAPP')`),
    ]);

    const config = configRes.rows[0];
    if (!config) return res.status(200).send('No config');

    const globalMap: Record<string, string> = {};
    globalRes.rows.forEach(r => { globalMap[r.key] = r.key === 'evolution_token' ? decrypt(r.value) : r.value; });

    // LGPD: detecta pedido de opt-out ("PARAR", "STOP", "CANCELAR MENSAGENS")
    const optOutKeywords = ['parar', 'stop', 'cancelar mensagens', 'nao quero mais', 'não quero mais'];
    const normalizedText = messageText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (optOutKeywords.some(kw => normalizedText === kw || normalizedText.startsWith(kw + ' '))) {
      const phone = stripCountryCode(remoteJid);
      await pool.query(
        `UPDATE users SET whatsapp_optout = true, whatsapp_optout_at = NOW() WHERE whatsapp = $1`,
        [phone]
      );
      const evoUrl   = globalMap.evolution_url   || '';
      const evoToken = globalMap.evolution_token || '';
      await sendMessage(instanceName, remoteJid,
        'Você foi removido das nossas comunicações automáticas. Para reativar, envie ATIVAR.',
        evoUrl, evoToken
      );
      // Detecta pedido de reativação
      return res.status(200).send('OK');
    }

    // LGPD: detecta pedido de reativação ("ATIVAR", "INICIAR")
    const optInKeywords = ['ativar', 'iniciar', 'quero receber', 'reativar'];
    if (optInKeywords.some(kw => normalizedText === kw)) {
      const phone = stripCountryCode(remoteJid);
      await pool.query(
        `UPDATE users SET whatsapp_optout = false, whatsapp_optout_at = NULL WHERE whatsapp = $1`,
        [phone]
      );
      const evoUrl   = globalMap.evolution_url   || '';
      const evoToken = globalMap.evolution_token || '';
      await sendMessage(instanceName, remoteJid,
        'Ótimo! Você voltou a receber nossas mensagens. Envie PARAR a qualquer momento para cancelar.',
        evoUrl, evoToken
      );
      return res.status(200).send('OK');
    }

    // A. Comando de entregador: "sex 2 entregue"
    const deliveryCommand = await tryDeliveryCommand(estId, remoteJid, messageText);
    if (deliveryCommand) {
      const { url: evoUrl, token: evoToken } = { url: globalMap.evolution_url || '', token: globalMap.evolution_token || '' };
      await sendMessage(instanceName, remoteJid, deliveryCommand, evoUrl, evoToken);
      return res.status(200).send('OK');
    }

    // B. Verifica palavras-chave (Flows)
    const flowsRes = await pool.query(
      `SELECT * FROM whatsapp_flows WHERE establishment_id=$1 AND is_active=true`, [estId]
    );
    const matchedFlow = flowsRes.rows.find(f =>
      messageText.toLowerCase().includes(f.trigger_keyword.toLowerCase())
    );

    let responseText = '';

    if (matchedFlow) {
      responseText = matchedFlow.response_text;
    } else if (config.enable_ai) {
      // C. IA com capacidade de criar pedidos (Ágata Food Mode)
      responseText = await getAIResponse(estId, messageText, remoteJid);
    }

    if (responseText) {
      const delay = Math.floor(
        Math.random() * ((config.delay_max || 3) - (config.delay_min || 1) + 1) + (config.delay_min || 1)
      ) * 1000;

      const evolutionUrl   = globalMap.evolution_url   || '';
      const evolutionToken = globalMap.evolution_token || '';

      if (config.typing_effect) {
        await sendPresence(instanceName, remoteJid, 'composing', evolutionUrl, evolutionToken);
      }

      setTimeout(async () => {
        await sendMessage(instanceName, remoteJid, responseText, evolutionUrl, evolutionToken);
        if (config.typing_effect) {
          await sendPresence(instanceName, remoteJid, 'paused', evolutionUrl, evolutionToken);
        }
      }, delay);
    }

    res.status(200).send('OK');
  } catch (err: any) {
    console.error('Webhook Error:', err.message);
    res.status(500).send('Error');
  }
});


// ─────────────────────────────────────────────────────────────
// Comando de entregador via WhatsApp: "sex 2 entregue"
// ─────────────────────────────────────────────────────────────

// Mapeamento de nomes de dias (abreviados e completos) para os códigos gerados
const DAY_ALIASES: Record<string, string> = {
  dom: 'dom', domingo: 'dom',
  seg: 'seg', segunda: 'seg', 'segunda-feira': 'seg',
  ter: 'ter', terca: 'ter', 'terça': 'ter', 'terça-feira': 'ter',
  qua: 'qua', quarta: 'qua', 'quarta-feira': 'qua',
  qui: 'qui', quinta: 'qui', 'quinta-feira': 'qui',
  sex: 'sex', sexta: 'sex', 'sexta-feira': 'sex',
  sab: 'sab', sábado: 'sab', sabado: 'sab',
};

/**
 * Verifica se a mensagem é um comando de entregador (ex: "sex 2 entregue").
 * Confirma que o remetente é um entregador ativo da loja.
 * Se válido: marca o pedido como entregue e retorna a mensagem de confirmação.
 * Se inválido ou não reconhecido: retorna null (fluxo normal continua).
 */
async function tryDeliveryCommand(estId: string, remoteJid: string, text: string): Promise<string | null> {
  // Padrão: {dia} {número} entregue  (case insensitive, sem acentos opcionais)
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const match = normalized.match(/^([a-z\-]+)\s+(\d+)\s+entregue?$/);
  if (!match) return null;

  const dayAlias = DAY_ALIASES[match[1]];
  const seq      = match[2];
  if (!dayAlias) return null;

  const dailyCode = `${dayAlias} ${seq}`;

  // Extrai o número de telefone do remetente (sem DDI 55)
  const phone = stripCountryCode(remoteJid);

  try {
    // Valida que o remetente é entregador ativo desta loja
    const driverRes = await pool.query(
      `SELECT em.id FROM establishment_members em
       JOIN users u ON u.id = em.user_id
       WHERE em.establishment_id=$1
         AND em.member_role='entregador'
         AND em.is_active=true
         AND u.whatsapp=$2
       LIMIT 1`,
      [estId, phone]
    );
    if (!driverRes.rows.length) return null; // não é entregador → fluxo normal

    // Busca o pedido pelo código diário (hoje ou ontem, para cobrir viradas de dia)
    const orderRes = await pool.query(
      `SELECT * FROM delivery_orders
       WHERE establishment_id=$1
         AND daily_code=$2
         AND status NOT IN ('delivered','cancelled')
         AND created_at >= NOW() - INTERVAL '36 hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      [estId, dailyCode]
    );

    if (!orderRes.rows.length) {
      return `❌ Pedido *${dailyCode}* não encontrado ou já finalizado.`;
    }

    const order = orderRes.rows[0];

    // Dá baixa no pedido
    await pool.query(
      `UPDATE delivery_orders SET status='delivered', updated_at=NOW() WHERE id=$1`,
      [order.id]
    );

    // Libera mesa se houver
    if (order.table_id) {
      await pool.query(
        `UPDATE restaurant_tables SET status='livre', current_order_id=NULL, updated_at=NOW() WHERE id=$1`,
        [order.table_id]
      );
    }

    // Notifica o cliente via WA (em background)
    if (order.customer_phone) {
      const estRes = await pool.query(`SELECT name FROM establishments WHERE id=$1`, [estId]);
      const storeName = estRes.rows[0]?.name || '';
      const clientMsg = msgStatusCliente(order, 'delivered', storeName);
      // Importa sendWhatsAppMessage dinamicamente para evitar dependência circular
      const { sendWhatsAppMessage } = await import('../shared/waSender');
      sendWhatsAppMessage(estId, order.customer_phone, clientMsg).catch(() => {});
    }

    console.log(`✅ Pedido ${dailyCode} (#${order.order_number}) entregue via comando WA`);
    return `✅ Pedido *${dailyCode}* — #${order.order_number} marcado como *entregue*!\nCliente: ${order.customer_name}`;
  } catch (err: any) {
    console.error('[tryDeliveryCommand] erro:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Extrai pedido estruturado da resposta da IA (entre marcadores)
// ─────────────────────────────────────────────────────────────
interface OrderIntent {
  customer_name: string;
  customer_address?: string;
  delivery_type: 'delivery' | 'pickup';
  payment_method: string;
  notes?: string;
  coupon_code?: string;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
    variant?: string;
    options?: string[];
  }>;
}

function extractOrder(text: string): { cleanText: string; order: OrderIntent | null } {
  const match = text.match(/\[\[PEDIDO\]\]([\s\S]*?)\[\[\/PEDIDO\]\]/);
  if (!match) return { cleanText: text, order: null };

  const cleanText = text.replace(/\[\[PEDIDO\]\][\s\S]*?\[\[\/PEDIDO\]\]/g, '').trim();
  try {
    const order = JSON.parse(match[1].trim()) as OrderIntent;
    return { cleanText, order };
  } catch {
    return { cleanText, order: null };
  }
}

// ─────────────────────────────────────────────────────────────
// Cria o pedido no banco a partir da intenção da Ágata
// ─────────────────────────────────────────────────────────────
async function createOrderFromAgata(estId: string, whatsapp: string, order: OrderIntent): Promise<{ id: string; order_number: number; total: number } | null> {
  try {
    const [estRes, seqRes, dailySeqRes, defaultDriverRes] = await Promise.all([
      pool.query(`SELECT delivery_tax, free_delivery_over, min_order, name FROM establishments WHERE id=$1`, [estId]),
      pool.query(`SELECT COALESCE(MAX(order_number), 0) + 1 AS next FROM delivery_orders WHERE establishment_id=$1`, [estId]),
      pool.query(`SELECT COUNT(*) + 1 AS seq FROM delivery_orders WHERE establishment_id=$1 AND created_at::date = CURRENT_DATE`, [estId]),
      pool.query(
        `SELECT em.user_id FROM establishment_members em
         WHERE em.establishment_id=$1 AND em.is_default=true AND em.is_active=true LIMIT 1`,
        [estId]
      ),
    ]);

    const est        = estRes.rows[0] || {};
    const orderNumber = seqRes.rows[0].next;
    const dayNames   = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const dailyCode  = `${dayNames[new Date().getDay()]} ${dailySeqRes.rows[0].seq}`;
    const assignedTo = (order.delivery_type !== 'pickup' && defaultDriverRes.rows[0])
      ? defaultDriverRes.rows[0].user_id : null;

    const subtotal = order.items.reduce((acc, it) => acc + (it.price * it.quantity), 0);

    let tax = 0;
    if (order.delivery_type === 'delivery') {
      tax = +(est.delivery_tax || 0);
      if (est.free_delivery_over && subtotal >= +est.free_delivery_over) tax = 0;
    }

    // Aplica cupom de desconto (se informado — erros de cupom são ignorados silenciosamente)
    let discount = 0;
    let appliedCouponCode: string | null = null;
    if (order.coupon_code) {
      try {
        const couponResult = await applyCoupon(estId, order.coupon_code, subtotal);
        if (couponResult.discount > 0) {
          discount = couponResult.discount;
          appliedCouponCode = order.coupon_code;
        }
      } catch {
        // Cupom inválido/expirado — segue sem desconto
      }
    }

    const total = subtotal + tax - discount;

    const itemsJson = order.items.map(it => ({
      name: it.name, quantity: it.quantity, price: it.price,
      variant: it.variant || null, options: it.options || [],
    }));

    const result = await pool.query(
      `INSERT INTO delivery_orders
         (establishment_id, customer_name, customer_phone, customer_address,
          delivery_type, items, subtotal, delivery_tax, discount, total, notes,
          source, order_number, payment_method, daily_code, assigned_to, coupon_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'agata_wa',$12,$13,$14,$15,$16) RETURNING id, order_number, total`,
      [estId,
       order.customer_name || 'Cliente WhatsApp',
       stripCountryCode(whatsapp),
       order.customer_address || null,
       order.delivery_type || 'delivery',
       JSON.stringify(itemsJson),
       subtotal, tax, discount, total,
       order.notes || null,
       orderNumber,
       order.payment_method || 'na_entrega',
       dailyCode, assignedTo, appliedCouponCode]
    );

    return result.rows[0];
  } catch (err: any) {
    console.error('createOrderFromAgata error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Obtém ou cria a memória de conversa do cliente
// ─────────────────────────────────────────────────────────────
async function getOrCreateConversationMemory(estId: string, whatsapp: string) {
  let memory = await pool.query(
    `SELECT * FROM ai_memory WHERE whatsapp=$1 AND establishment_id=$2 LIMIT 1`,
    [whatsapp, estId]
  );
  if (!memory.rows.length) {
    memory = await pool.query(
      `INSERT INTO ai_memory (whatsapp, establishment_id, messages, context_json)
       VALUES ($1,$2,'[]','{}') RETURNING *`,
      [whatsapp, estId]
    );
  }
  return memory.rows[0];
}

// ─────────────────────────────────────────────────────────────
// Constrói o prompt da IA com base no contexto do estabelecimento
// ─────────────────────────────────────────────────────────────
async function buildPromptForUser(
  est: any,
  p: any,
  aiCfg: any,
  bc: any,
  isFoodMode: boolean,
  mem: any,
  userMessage: string
): Promise<AIMessage[]> {
  let storeClosedNote = '';
  let catalogSection = '';

  if (isFoodMode) {
    const storeStatus = await checkStoreOpen(est.id);
    if (!storeStatus.is_open) {
      storeClosedNote = `\n\nIMPORTANTE: A loja está FECHADA agora. ${storeStatus.message} NÃO aceite pedidos. Informe o cliente educadamente e diga quando abriremos.`;
    }
    const catalogText = await buildAgataPromptText(est.id);
    if (catalogText) {
      catalogSection = `\n\nCARDÁPIO ATUAL (use exatamente esses nomes e preços):\n${catalogText}\n\n* = obrigatório`;
    }
  }

  const memoryCtx = mem.summary ? `\n\nMEMÓRIA DESTE CLIENTE:\n${mem.summary}` : '';
  const recentCtx = (mem.messages as any[] || []).slice(-6)
    .map((m: any) => `${m.role === 'user' ? 'Cliente' : 'Ágatha'}: ${m.content}`)
    .join('\n');

  const orderInstructions = isFoodMode ? `
INSTRUÇÕES PARA PEDIDOS:
Quando o cliente quiser fazer um pedido, colete: nome, endereço (ou se vai retirar), itens, tamanhos/opcionais e forma de pagamento.
Quando tiver todos os dados, inclua NO FINAL da sua resposta (oculto para o cliente) o bloco:
[[PEDIDO]]
{
  "customer_name": "Nome do cliente",
  "customer_address": "Endereço completo ou null se retirada",
  "delivery_type": "delivery ou pickup",
  "payment_method": "na_entrega, pix ou cartao",
  "notes": "observações ou null",
  "items": [
    {"name": "Nome exato do produto", "quantity": 1, "price": 0.00, "variant": "tamanho se houver", "options": ["opcional1"]}
  ]
}
[[/PEDIDO]]
Se o cliente disser "o de sempre" ou "o mesmo de antes", use a memória para identificar o último pedido.
Se não tiver certeza dos dados, pergunte antes de criar o pedido.
` : '';

  return [
    {
      role: 'system',
      content: `Você é a ${p.name || 'Ágatha'}, assistente virtual da ${est?.name || 'nossa loja'}.
Personalidade: ${p.mood || aiCfg.prompt || bc.agata_mood || 'Prestativa e amigável.'}.
${p.forbidden_topics ? `Não fale sobre: ${p.forbidden_topics}.` : ''}
${aiCfg.knowledge || bc.agata_knowledge ? `Contexto: ${aiCfg.knowledge || bc.agata_knowledge}` : ''}
Responda em português, de forma natural e curta, ideal para WhatsApp. Nunca saia do personagem.${catalogSection}${storeClosedNote}${orderInstructions}${memoryCtx}${recentCtx ? `\n\nCONVERSA RECENTE:\n${recentCtx}` : ''}`,
    },
    { role: 'user', content: userMessage },
  ];
}

// ─────────────────────────────────────────────────────────────
// Lida com a criação do pedido gerado pela IA
// ─────────────────────────────────────────────────────────────
async function handleOrderCreation(estId: string, whatsapp: string, order: OrderIntent): Promise<string> {
  const created = await createOrderFromAgata(estId, whatsapp, order);
  if (!created) return '';

  console.log(`🛒 Pedido #${created.order_number} criado via Ágata WA (est: ${estId})`);
  
  // Notifica app de impressão via Socket.io
  const { emitToStore } = await import('../shared/socketio');
  emitToStore(estId, 'new_order', created);

  return `\n\n✅ Pedido *#${created.order_number}* registrado! Total: *R$ ${Number(created.total).toFixed(2).replace('.', ',')}*\nAcompanhe em: ${process.env.BASE_URL || ''}/pedido/${created.id}`;
}

// ─────────────────────────────────────────────────────────────
// Persiste o histórico da conversa e atualiza o resumo
// ─────────────────────────────────────────────────────────────
function updateConversationMemory(mem: any, userMessage: string, finalResponse: string, cfg: any) {
  const MAX = 30;
  const updated = [
    ...(mem.messages || []),
    { role: 'user',  content: userMessage,   ts: new Date().toISOString() },
    { role: 'agata', content: finalResponse, ts: new Date().toISOString() },
  ].slice(-MAX);

  pool.query(
    `UPDATE ai_memory SET messages=$1, last_interaction=NOW() WHERE id=$2`,
    [JSON.stringify(updated), mem.id]
  ).catch(() => {});

  if (updated.length % 8 === 0) {
    refreshWhatsAppSummary(mem.id, updated, mem.summary || '', cfg).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// Gera resposta da IA para o WhatsApp (com suporte a pedidos)
// ─────────────────────────────────────────────────────────────
async function getAIResponse(estId: string, userMessage: string, whatsapp: string): Promise<string> {
  try {
    const [estRes, personalityRes, cfg] = await Promise.all([
      pool.query(`SELECT id, name, settings, business_config FROM establishments WHERE id=$1`, [estId]),
      pool.query(`SELECT name, mood, forbidden_topics FROM agata_personality LIMIT 1`),
      loadAIConfig(),
    ]);

    const est   = estRes.rows[0];
    const aiCfg = est?.settings?.ai || {};
    const bc    = est?.business_config || {};
    const p     = personalityRes.rows[0] || {};

    const isFoodMode = bc.agata_knowledge?.toLowerCase().includes('cardápio')
                    || bc.agata_knowledge?.toLowerCase().includes('pedido')
                    || aiCfg.knowledge?.toLowerCase().includes('cardápio')
                    || aiCfg.knowledge?.toLowerCase().includes('pedido');

    const mem = await getOrCreateConversationMemory(estId, whatsapp);
    const messages = await buildPromptForUser(est, p, aiCfg, bc, isFoodMode, mem, userMessage);

    const { response, provider } = await askAI(cfg, messages, 600);
    console.log(`📱 WhatsApp IA respondeu via [${provider}] para ${whatsapp}`);

    if (!response) return 'Olá! No momento estou processando muitas mensagens. Pode repetir, por favor?';

    const { cleanText, order } = extractOrder(response);
    let finalResponse = cleanText;

    if (order && isFoodMode) {
      finalResponse += await handleOrderCreation(estId, whatsapp, order);
    }

    updateConversationMemory(mem, userMessage, finalResponse, cfg);

    return finalResponse;
  } catch (err: any) {
    console.error('getAIResponse error:', err.message);
    return 'Olá! No momento estou com dificuldades. Pode repetir em instantes?';
  }
}

async function refreshWhatsAppSummary(memId: string, messages: any[], existing: string, cfg: any) {
  const transcript = messages.slice(-20)
    .map((m: any) => `${m.role === 'user' ? 'Cliente' : 'Ágatha'}: ${m.content}`)
    .join('\n');

  const msgs: AIMessage[] = [
    { role: 'system', content: 'Produza um resumo conciso (máximo 3 frases) com preferências do cliente, últimos pedidos, decisões tomadas e pontos importantes para atendimentos futuros. Use terceira pessoa. Inclua itens pedidos com frequência.' },
    { role: 'user',   content: `Resumo anterior: ${existing || 'Nenhum.'}\n\nConversa:\n${transcript}\n\nNovo resumo:` },
  ];

  const { response } = await askAI(cfg, msgs, 200);
  if (response) {
    await pool.query(`UPDATE ai_memory SET summary=$1 WHERE id=$2`, [response, memId]);
  }
}

// ── Helpers Evolution API ────────────────────────────────────
async function sendPresence(instance: string, jid: string, presence: string, baseUrl: string, token: string) {
  try {
    await fetch(`${baseUrl}/chat/sendPresence/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: token },
      body: JSON.stringify({ number: jid, presence }),
    });
  } catch {}
}

async function sendMessage(instance: string, jid: string, text: string, baseUrl: string, token: string) {
  try {
    await fetch(`${baseUrl}/messages/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: token },
      body: JSON.stringify({ number: jid, text, linkPreview: false }),
    });
  } catch {}
}

export default router;
