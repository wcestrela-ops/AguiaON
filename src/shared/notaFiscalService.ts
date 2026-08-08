/**
 * Serviço de Nota Fiscal (NFS-e via Asaas) — AguiaON, Fase 13
 *
 * Centraliza o disparo de emissão de nota fiscal a partir do momento em que
 * uma cobrança é confirmada como paga (webhook do Asaas/Mercado Pago em
 * payments.ts, ou o resync manual). Usa a configuração fiscal que o lojista
 * preenche uma vez em Configurações → Rastreamento → Nota Fiscal
 * (agenda_fiscal_config) — CNAE, RPS, serviço municipal e alíquotas fixas
 * por empresa, já que o Rastreamento presta sempre o mesmo tipo de serviço.
 *
 * Importante: nunca lança exceção pra quem chama — emissão de nota é
 * "melhor esforço" depois que o pagamento já foi confirmado; um erro aqui
 * não pode derrubar o webhook de pagamento. Erros ficam registrados em
 * agenda_notas_fiscais.erro pra o lojista ver e emitir manualmente se precisar.
 */

import pool from './db';
import { scheduleInvoice, InvoiceTaxes } from './asaasClient';

interface EmitirNotaInput {
  estId: string;
  paymentAsaasId?: string | null;
  customerAsaasId?: string | null;
  clienteId?: string | null;
  agendaFrotaId?: string | null;
  value: number;
  description: string;
}

export async function emitirNotaFiscal(input: EmitirNotaInput): Promise<void> {
  const { estId, paymentAsaasId, customerAsaasId, clienteId, agendaFrotaId, value, description } = input;
  try {
    const cfgRes = await pool.query(`SELECT * FROM agenda_fiscal_config WHERE establishment_id=$1`, [estId]);
    const cfg = cfgRes.rows[0];
    if (!cfg || !cfg.ativo || !cfg.emissao_automatica) return; // não configurado / emissão automática desligada

    if (!paymentAsaasId && !customerAsaasId) {
      console.warn(`[notaFiscal] sem payment nem customer Asaas pra vincular a nota (est=${estId}) — pulando emissão (provavelmente pago fora do Asaas).`);
      return;
    }

    const taxes: InvoiceTaxes = {
      retainIss: !!cfg.retain_iss,
      iss: Number(cfg.iss_pct) || 0,
      pis: Number(cfg.pis_pct) || 0,
      cofins: Number(cfg.cofins_pct) || 0,
      csll: Number(cfg.csll_pct) || 0,
      inss: Number(cfg.inss_pct) || 0,
      ir: Number(cfg.ir_pct) || 0,
    };

    const effectiveDate = new Date().toISOString().split('T')[0];

    const invoice = await scheduleInvoice(estId, {
      payment: paymentAsaasId || undefined,
      customer: !paymentAsaasId ? (customerAsaasId || undefined) : undefined,
      serviceDescription: description,
      value,
      effectiveDate,
      municipalServiceId: cfg.municipal_service_id || undefined,
      municipalServiceCode: cfg.municipal_service_code || undefined,
      municipalServiceName: cfg.municipal_service_name || description,
      taxes,
    });

    await pool.query(
      `INSERT INTO agenda_notas_fiscais (establishment_id, cliente_id, agenda_frota_id, asaas_payment_id, asaas_invoice_id, status, valor, pdf_url, xml_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (asaas_payment_id) WHERE asaas_payment_id IS NOT NULL
       DO UPDATE SET status=$6, asaas_invoice_id=$5, pdf_url=$8, xml_url=$9, updated_at=NOW()`,
      [estId, clienteId || null, agendaFrotaId || null, paymentAsaasId || null, invoice.id, invoice.status, value, invoice.pdfUrl || null, invoice.xmlUrl || null]
    );

    console.log(`[notaFiscal] nota agendada (est=${estId}, invoice=${invoice.id}, status=${invoice.status})`);
  } catch (err: any) {
    console.error(`[notaFiscal] falha ao emitir (est=${estId}):`, err.message);
    try {
      await pool.query(
        `INSERT INTO agenda_notas_fiscais (establishment_id, cliente_id, agenda_frota_id, asaas_payment_id, status, valor, erro)
         VALUES ($1,$2,$3,$4,'ERROR',$5,$6)
         ON CONFLICT (asaas_payment_id) WHERE asaas_payment_id IS NOT NULL
         DO UPDATE SET status='ERROR', erro=$6, updated_at=NOW()`,
        [estId, clienteId || null, agendaFrotaId || null, paymentAsaasId || null, value, err.message]
      );
    } catch { /* nem o log de erro deve derrubar o fluxo de pagamento */ }
  }
}
