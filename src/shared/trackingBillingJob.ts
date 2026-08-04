/**
 * TRACKING BILLING JOB — AguiaON (Fase 7)
 *
 * Cobrança recorrente do módulo Rastreamento: portado do serviço financeiro
 * do Águia Auto (services/api/src/services/financeiro-service.js /
 * billing-consolidation-service.js) e adaptado ao mesmo padrão já testado e
 * validado do gymExpiryJob.ts — roda todo dia às 09:15 horário de Brasília.
 *
 * Diferente do modelo do gym (data de vencimento por assinatura), o
 * Rastreamento usa um único "dia do mês" por empresa (business_config.dia_cobranca,
 * configurável em Configurações → Rastreamento). Quando esse dia chega:
 *  1. Para cada veículo ativo com plano vinculado, gera a cobrança do mês
 *     corrente (idempotente — UNIQUE(agenda_frota_id, competencia) evita
 *     cobrança duplicada em reinícios do processo).
 *  2. Gera o PIX (Asaas → Mercado Pago → chave manual, mesma cadeia de
 *     failover do pixService.ts).
 *  3. Envia ao cliente via WhatsApp, com o mesmo delay anti-ban do
 *     gymExpiryJob.ts.
 *
 * Só roda para empresas com business_config.cobranca_automatica = true
 * (opt-in do lojista, configurável no painel).
 */

import pool from './db';
import { sendWhatsAppMessage } from './waSender';
import { generateFrotaPix } from './pixService';
import { createCustomer as createAsaasCustomer, createPixCharge as createAsaasPixCharge } from './asaasClient';

function randomDelay(minMs = 8_000, maxMs = 20_000): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface WaQueueItem { estId: string; phone: string; msg: string; }

async function sendWaQueue(items: WaQueueItem[]): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(randomDelay());
    const { estId, phone, msg } = items[i];
    sendWhatsAppMessage(estId, phone, msg).catch((err: any) =>
      console.error(`[trackingBilling] WA falhou para ${phone}:`, err.message)
    );
  }
}

export function startTrackingBillingJob(): void {
  runCheck().catch(() => {});
  setInterval(() => runCheck().catch(() => {}), 60_000);
}

async function runCheck(): Promise<void> {
  const nowHHMM = new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });
  if (nowHHMM !== '09:15') return;

  await gerarCobrancasDoDia();
  await gerarCobrancasRecorrentesClientes();
  await marcarInadimplentes();
}

// Recorrência no nível do CLIENTE (Fase 14) — separada da recorrência por
// veículo acima. Um cliente pode ter um valor fixo mensal (ex: pacote de
// serviços, taxa de gestão) cobrado dele diretamente, independente de quantos
// veículos tem vinculados. Opt-in por cliente (agenda_clientes.recorrencia_ativa),
// não depende do business_config.cobranca_automatica da empresa (que é
// especificamente da recorrência por veículo).
async function gerarCobrancasRecorrentesClientes(): Promise<void> {
  try {
    const diaHoje = parseInt(
      new Date().toLocaleDateString('pt-BR', { day: '2-digit', timeZone: 'America/Sao_Paulo' }),
      10
    );
    const competencia = new Date().toISOString().slice(0, 7); // YYYY-MM

    const clientes = await pool.query(`
      SELECT id, nome, telefone, establishment_id, asaas_customer_id,
             valor_recorrente, descricao_recorrente
      FROM agenda_clientes
      WHERE recorrencia_ativa = true
        AND dia_cobranca_recorrente = $1
        AND valor_recorrente IS NOT NULL AND valor_recorrente > 0
    `, [diaHoje]);

    if (!clientes.rows.length) return;

    const waQueue: WaQueueItem[] = [];
    let totalGeradas = 0;

    for (const cliente of clientes.rows) {
      try {
        let asaasCustomerId = cliente.asaas_customer_id;
        if (!asaasCustomerId) {
          const created = await createAsaasCustomer(cliente.establishment_id, {
            name: cliente.nome, phone: cliente.telefone || undefined,
          });
          asaasCustomerId = created.id;
          await pool.query(`UPDATE agenda_clientes SET asaas_customer_id=$1, updated_at=NOW() WHERE id=$2`, [asaasCustomerId, cliente.id]);
        }

        const { payment, pixPayload } = await createAsaasPixCharge(cliente.establishment_id, {
          customerId: asaasCustomerId,
          value: Number(cliente.valor_recorrente),
          description: cliente.descricao_recorrente || `Mensalidade — ${cliente.nome}`,
        });

        // Idempotência: ON CONFLICT evita duplicar a cobrança do mesmo mês
        const inserted = await pool.query(
          `INSERT INTO agenda_cliente_asaas_cache
             (cliente_id, establishment_id, tipo, asaas_id, valor, status, vencimento, descricao, invoice_url, pix_payload, competencia)
           VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (cliente_id, competencia) WHERE competencia IS NOT NULL DO NOTHING
           RETURNING id`,
          [cliente.id, cliente.establishment_id, payment.id, payment.value, payment.status,
           payment.dueDate, payment.description || null, payment.invoiceUrl || null, pixPayload || null, competencia]
        );
        if (!inserted.rows.length) continue; // já existia (reinício do processo ou já cobrado)
        totalGeradas++;

        if (cliente.telefone && pixPayload) {
          waQueue.push({
            estId: cliente.establishment_id,
            phone: cliente.telefone,
            msg: `💳 *Olá, ${cliente.nome}!*\n\nSua mensalidade venceu hoje${cliente.descricao_recorrente ? ` (${cliente.descricao_recorrente})` : ''}.\n\nPix Copia e Cola:\n\`${pixPayload}\`\n\nApós pagar, a confirmação é automática!`,
          });
        }
      } catch (cliErr: any) {
        console.error(`[trackingBilling] recorrência de cliente falhou (cliente ${cliente.id}):`, cliErr.message);
      }
    }

    if (waQueue.length) sendWaQueue(waQueue).catch(() => {});
    if (totalGeradas) {
      console.log(`[trackingBilling] ${totalGeradas} cobrança(s) recorrente(s) de cliente gerada(s), ${waQueue.length} aviso(s) WA enfileirado(s)`);
    }
  } catch (err: any) {
    console.error('[trackingBilling] gerarCobrancasRecorrentesClientes:', err.message);
  }
}

// Marca como "inadimplente" todo veículo ativo do módulo Rastreamento que
// tenha uma cobrança de mês ANTERIOR ainda pendente (não paga). Roda pra
// todas as empresas do nicho, independente do opt-in de cobrança automática
// — cobrança manual (botão "Cobrar" na Frota) também deve gerar esse status.
// Reversão para "ativo" acontece em payments.ts (renewFrotaCharge) quando o
// pagamento é confirmado e não sobra nenhuma outra competência em aberto.
async function marcarInadimplentes(): Promise<void> {
  try {
    const competenciaAtual = new Date().toISOString().slice(0, 7);
    const r = await pool.query(`
      UPDATE agenda_frota f
      SET status = 'inadimplente', updated_at = NOW()
      WHERE f.status = 'ativo'
        AND f.plano_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM agenda_frota_charges c
          WHERE c.agenda_frota_id = f.id AND c.status = 'pending' AND c.competencia < $1
        )
      RETURNING f.id
    `, [competenciaAtual]);
    if (r.rowCount) {
      console.log(`[trackingBilling] ${r.rowCount} veículo(s) marcado(s) como inadimplente(s) por cobrança em atraso.`);
    }
  } catch (err: any) {
    console.error('[trackingBilling] marcarInadimplentes:', err.message);
  }
}

async function gerarCobrancasDoDia(): Promise<void> {
  try {
    const diaHoje = parseInt(
      new Date().toLocaleDateString('pt-BR', { day: '2-digit', timeZone: 'America/Sao_Paulo' }),
      10
    );

    const estabs = await pool.query(`
      SELECT id, name, business_config
      FROM establishments
      WHERE vertical_slug = 'rastreamento'
        AND COALESCE((business_config->>'cobranca_automatica')::boolean, false) = true
        AND COALESCE((business_config->>'dia_cobranca')::int, 0) = $1
    `, [diaHoje]);

    if (!estabs.rows.length) return;

    const competencia = new Date().toISOString().slice(0, 7); // YYYY-MM
    const waQueue: WaQueueItem[] = [];
    let totalGeradas = 0;

    for (const est of estabs.rows) {
      try {
        const veiculos = await pool.query(`
          SELECT f.id, f.cliente_nome, f.cliente_telefone, f.plano_id,
                 s.preco AS plano_preco, s.nome AS plano_nome
          FROM agenda_frota f
          JOIN agenda_servicos s ON s.id = f.plano_id
          WHERE f.establishment_id = $1 AND f.status = 'ativo' AND f.plano_id IS NOT NULL
        `, [est.id]);

        for (const v of veiculos.rows) {
          const preco = parseFloat(v.plano_preco) || 0;
          if (preco <= 0) continue;

          // Idempotência: ON CONFLICT evita duplicar cobrança da mesma competência
          const inserted = await pool.query(
            `INSERT INTO agenda_frota_charges (agenda_frota_id, establishment_id, competencia, valor)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (agenda_frota_id, competencia) DO NOTHING
             RETURNING *`,
            [v.id, est.id, competencia, preco]
          );
          if (!inserted.rows.length) continue; // já existia (reinício do processo ou já cobrado)
          const charge = inserted.rows[0];
          totalGeradas++;

          try {
            const pix = await generateFrotaPix(est.id, charge.id, preco, v.cliente_nome || 'Cliente');
            if (pix) {
              await pool.query(
                `UPDATE agenda_frota_charges SET pix_code=$1, pix_provider=$2, asaas_payment_id=$3 WHERE id=$4`,
                [pix.code, pix.provider, pix.provider_payment_id || null, charge.id]
              );
              if (v.cliente_telefone) {
                waQueue.push({
                  estId: est.id,
                  phone: v.cliente_telefone,
                  msg: `📡 *Olá, ${v.cliente_nome || 'cliente'}!*\n\nSua mensalidade de rastreamento (*${v.plano_nome}*) na *${est.name}* venceu hoje.\n\n${pix.message}`,
                });
              }
            } else {
              console.warn(`[trackingBilling] sem método de pagamento configurado — empresa ${est.id}`);
            }
          } catch (pixErr: any) {
            console.error(`[trackingBilling] PIX falhou (veículo ${v.id}):`, pixErr.message);
          }
        }
      } catch (estErr: any) {
        console.error(`[trackingBilling] falha na empresa ${est.id}:`, estErr.message);
      }
    }

    if (waQueue.length) {
      sendWaQueue(waQueue).catch(() => {});
    }
    if (totalGeradas) {
      console.log(`[trackingBilling] ${totalGeradas} cobrança(s) de rastreamento gerada(s), ${waQueue.length} aviso(s) WA enfileirado(s)`);
    }
  } catch (err: any) {
    console.error('[trackingBilling] gerarCobrancasDoDia:', err.message);
  }
}
