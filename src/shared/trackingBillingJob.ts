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
import { createCustomer as createAsaasCustomer, createPixCharge as createAsaasPixCharge, getPixPayload as getAsaasPixPayload } from './asaasClient';
import { ensureTables as ensureAgendaTables } from '../routes/agenda/index';
import { montarMensagensCobranca, DadosMensagemCobranca, montarMensagemResumoAtraso, FaturaAtrasada } from './cobrancaMensagem';

function randomDelay(minMs = 8_000, maxMs = 20_000): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Data de hoje em America/Sao_Paulo no formato YYYY-MM-DD — mesmo formato que
// `vencimento` guarda (vem do `dueDate` do Asaas, sempre YYYY-MM-DD), pra dar
// pra comparar com `=` direto em vez de parsear datas.
function hojeSaoPauloISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Mesma data, mas em dd/mm/aaaa — formato usado nas mensagens (o padrão que
// a empresa já usava mostra a data por extenso, ex: "vencimento em
// 05/08/2026", não a palavra "hoje").
function hojeSaoPauloBR(): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Fix de produção 23 — cada item da fila agora carrega uma OU DUAS mensagens
// (a segunda só existe quando `cobranca_pix_separado` está ligado nas
// configurações do estabelecimento — o código Pix vai sozinho, sem mais
// texto, facilitando copiar no celular). O delay anti-bloqueio de sempre
// (8-20s) continua sendo ENTRE clientes diferentes; entre a mensagem
// principal e o Pix separado do MESMO cliente usa um intervalo curto fixo
// (só pra não ficar tudo colado, sem precisar do delay anti-ban completo).
interface WaQueueItem { estId: string; phone: string; msgs: string[]; }

async function sendWaQueue(items: WaQueueItem[]): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(randomDelay());
    const { estId, phone, msgs } = items[i];
    (async () => {
      for (let j = 0; j < msgs.length; j++) {
        if (j > 0) await sleep(1_500);
        try { await sendWhatsAppMessage(estId, phone, msgs[j]); }
        catch (err: any) { console.error(`[trackingBilling] WA falhou para ${phone}:`, err.message); }
      }
    })().catch(() => {});
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

  // Garante que agenda_cliente_asaas_cache (e a coluna lembrete_enviado do
  // Fix 22) já existam — essa migração é lazy (só roda no primeiro request a
  // /agenda/*), e esse job roda de forma independente desde a subida do
  // servidor, sem passar por lá.
  await ensureAgendaTables();

  // Fix de produção 32 — gerarCobrancasDoDia() (cobrança automática POR
  // VEÍCULO) foi desativada. O Carlos confirmou que a Frota nunca deveria
  // emitir fatura — é só sincronização com o GPSWOX + vínculo com o cliente.
  // Cobrança de verdade continua só no nível do Cliente, pelas duas funções
  // abaixo (recorrência mensal fixa e cobrança avulsa).
  // await gerarCobrancasDoDia();
  await gerarCobrancasRecorrentesClientes();
  await enviarLembretesCobrancasAsaas();
  await enviarResumoAtrasos();
  await marcarInadimplentes();
}

// Fix de produção 24 — resumo de faturas atrasadas, agrupado por cliente.
// Pedido do Carlos: quando o cliente acumula mais de uma fatura vencida,
// mandar UM aviso consolidado (não um por fatura) — mesmo padrão que a
// empresa já usava. A frequência de reenvio é configurável pelo lojista em
// Configurações → Rastreamento (`business_config.aviso_atraso_frequencia_dias`
// — 0/vazio desativa o aviso pra essa empresa).
//
// Escopo: cobrança de CLIENTE (agenda_cliente_asaas_cache), que tem data de
// vencimento explícita. Cobrança por VEÍCULO (agenda_frota_charges) só
// guarda "competência" (mês), sem um dia exato de vencimento — continua só
// marcando "inadimplente" em silêncio, como já fazia (marcarInadimplentes),
// sem entrar nesse resumo por enquanto.
async function enviarResumoAtrasos(): Promise<void> {
  try {
    const hoje = hojeSaoPauloISO();

    const atrasadas = await pool.query(`
      SELECT ac.id, ac.cliente_id, ac.valor, ac.vencimento, ac.invoice_url, ac.invoice_number,
             cli.nome, cli.telefone, cli.aviso_atraso_enviado_em,
             ac.establishment_id, est.name AS estab_name, est.business_config
      FROM agenda_cliente_asaas_cache ac
      JOIN agenda_clientes cli ON cli.id = ac.cliente_id
      JOIN establishments est ON est.id = ac.establishment_id
      WHERE ac.tipo = 'payment'
        AND ac.vencimento < $1
        AND ac.status IN ('PENDING', 'AWAITING_RISK_ANALYSIS', 'OVERDUE')
        AND cli.telefone IS NOT NULL
      ORDER BY ac.cliente_id, ac.vencimento
    `, [hoje]);

    if (!atrasadas.rows.length) return;

    const porCliente = new Map<string, typeof atrasadas.rows>();
    for (const row of atrasadas.rows) {
      if (!porCliente.has(row.cliente_id)) porCliente.set(row.cliente_id, []);
      porCliente.get(row.cliente_id)!.push(row);
    }

    const waQueue: WaQueueItem[] = [];
    const hojeMs = new Date(`${hoje}T00:00:00Z`).getTime();
    let totalAvisados = 0;

    for (const [clienteId, faturas] of porCliente) {
      const bc = faturas[0].business_config || {};
      const freqDias = parseInt(bc.aviso_atraso_frequencia_dias, 10);
      if (!freqDias || freqDias <= 0) continue; // aviso desativado pra essa empresa

      const ultimoAviso = faturas[0].aviso_atraso_enviado_em;
      if (ultimoAviso) {
        const diasDesde = Math.floor((Date.now() - new Date(ultimoAviso).getTime()) / 86_400_000);
        if (diasDesde < freqDias) continue; // ainda dentro do intervalo configurado pelo lojista
      }

      const faturasMsg: FaturaAtrasada[] = faturas.map(f => ({
        faturaNumero: f.invoice_number,
        vencimentoLabel: new Date(`${f.vencimento}T00:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' }),
        diasAtraso: Math.max(1, Math.floor((hojeMs - new Date(`${f.vencimento}T00:00:00Z`).getTime()) / 86_400_000)),
        valor: f.valor,
        invoiceUrl: f.invoice_url,
      }));

      const msg = montarMensagemResumoAtraso(faturas[0].estab_name, faturas[0].nome, faturasMsg);
      waQueue.push({ estId: faturas[0].establishment_id, phone: faturas[0].telefone, msgs: [msg] });
      await pool.query(`UPDATE agenda_clientes SET aviso_atraso_enviado_em=NOW() WHERE id=$1`, [clienteId]);
      totalAvisados++;
    }

    if (waQueue.length) {
      sendWaQueue(waQueue).catch(() => {});
      console.log(`[trackingBilling] ${totalAvisados} resumo(s) de fatura atrasada enviado(s).`);
    }
  } catch (err: any) {
    console.error('[trackingBilling] enviarResumoAtrasos:', err.message);
  }
}

// Fix de produção 22 — pedido do Carlos: depois de "Sincronizar" com o Asaas
// (que só traz cobrança já existente lá pro cache local, sem avisar
// ninguém), o cliente nunca recebia lembrete nenhum no dia do vencimento —
// só cobrança feita por dentro do sistema (recorrência de cliente, acima)
// avisava. Isso cobre qualquer cobrança pendente no cache (sincronizada do
// Asaas OU gerada aqui) cujo vencimento seja hoje, com o mesmo delay
// anti-bloqueio de sempre entre um envio e outro. `lembrete_enviado` evita
// mandar 2x: a recorrência de cliente já marca a própria linha como avisada
// na hora que gera (ela manda a mensagem na hora, não precisa esperar essa
// varredura), então só sobra aqui o que ainda não foi avisado por ninguém.
async function enviarLembretesCobrancasAsaas(): Promise<void> {
  try {
    const hoje = hojeSaoPauloISO();
    const pendentes = await pool.query(`
      SELECT ac.id, ac.asaas_id, ac.valor, ac.descricao, ac.pix_payload, ac.invoice_url, ac.invoice_number,
             cli.nome, cli.telefone, ac.establishment_id, est.business_config
      FROM agenda_cliente_asaas_cache ac
      JOIN agenda_clientes cli ON cli.id = ac.cliente_id
      JOIN establishments est ON est.id = ac.establishment_id
      WHERE ac.tipo = 'payment'
        AND ac.vencimento = $1
        AND ac.status IN ('PENDING', 'AWAITING_RISK_ANALYSIS')
        AND COALESCE(ac.lembrete_enviado, false) = false
        AND cli.telefone IS NOT NULL
    `, [hoje]);

    if (!pendentes.rows.length) return;

    const waQueue: WaQueueItem[] = [];
    const idsAvisados: string[] = [];

    for (const c of pendentes.rows) {
      if (!c.pix_payload && !c.invoice_url) continue; // nada pra mandar ainda — tenta de novo amanhã

      // Fix de produção 25 — cobrança trazida por sincronização nunca teve o
      // Pix Copia e Cola buscado (só é buscado na hora que A GENTE cria a
      // cobrança) — busca sob demanda aqui, só quando falta, e guarda no
      // cache pra próxima vez não precisar buscar de novo.
      let pixPayload = c.pix_payload;
      if (!pixPayload && c.asaas_id) {
        pixPayload = await getAsaasPixPayload(c.establishment_id, c.asaas_id);
        if (pixPayload) {
          await pool.query(`UPDATE agenda_cliente_asaas_cache SET pix_payload=$1 WHERE id=$2`, [pixPayload, c.id]);
        }
      }

      const bc = c.business_config || {};
      const dados: DadosMensagemCobranca = {
        nome: c.nome, valor: c.valor, descricao: c.descricao,
        vencimentoLabel: hojeSaoPauloBR(), faturaNumero: c.invoice_number,
        pixPayload, invoiceUrl: c.invoice_url,
      };
      waQueue.push({
        estId: c.establishment_id,
        phone: c.telefone,
        msgs: montarMensagensCobranca(bc.mensagem_cobranca_template, dados, !!bc.cobranca_pix_separado),
      });
      idsAvisados.push(c.id);
    }

    if (idsAvisados.length) {
      await pool.query(`UPDATE agenda_cliente_asaas_cache SET lembrete_enviado=true WHERE id = ANY($1::uuid[])`, [idsAvisados]);
      sendWaQueue(waQueue).catch(() => {});
      console.log(`[trackingBilling] ${idsAvisados.length} lembrete(s) de cobrança (Asaas) enviado(s).`);
    }
  } catch (err: any) {
    console.error('[trackingBilling] enviarLembretesCobrancasAsaas:', err.message);
  }
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
      SELECT ac.id, ac.nome, ac.telefone, ac.establishment_id, ac.asaas_customer_id,
             ac.valor_recorrente, ac.descricao_recorrente, est.business_config
      FROM agenda_clientes ac
      JOIN establishments est ON est.id = ac.establishment_id
      WHERE ac.recorrencia_ativa = true
        AND ac.dia_cobranca_recorrente = $1
        AND ac.valor_recorrente IS NOT NULL AND ac.valor_recorrente > 0
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

        // Fix de produção 22: já marca lembrete_enviado=true quando essa
        // linha for gerada e notificada aqui mesmo (na hora), pra a varredura
        // diária de "cobrança do Asaas vencendo hoje" (enviarLembretesCobrancasAsaas,
        // que cobre cobrança sincronizada de fora) não mandar uma segunda
        // mensagem pro mesmo cliente sobre a mesma cobrança.
        const vaiAvisarAgora = !!(cliente.telefone && (pixPayload || payment.invoiceUrl));

        // Idempotência: ON CONFLICT evita duplicar a cobrança do mesmo mês
        const inserted = await pool.query(
          `INSERT INTO agenda_cliente_asaas_cache
             (cliente_id, establishment_id, tipo, asaas_id, valor, status, vencimento, descricao, invoice_url, pix_payload, competencia, lembrete_enviado, invoice_number)
           VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (cliente_id, competencia) WHERE competencia IS NOT NULL DO NOTHING
           RETURNING id`,
          [cliente.id, cliente.establishment_id, payment.id, payment.value, payment.status,
           payment.dueDate, payment.description || null, payment.invoiceUrl || null, pixPayload || null, competencia, vaiAvisarAgora, payment.invoiceNumber || null]
        );
        if (!inserted.rows.length) continue; // já existia (reinício do processo ou já cobrado)
        totalGeradas++;

        if (vaiAvisarAgora) {
          const bc = cliente.business_config || {};
          const dados: DadosMensagemCobranca = {
            nome: cliente.nome, valor: Number(cliente.valor_recorrente),
            descricao: cliente.descricao_recorrente, vencimentoLabel: hojeSaoPauloBR(),
            faturaNumero: payment.invoiceNumber, pixPayload, invoiceUrl: payment.invoiceUrl,
          };
          waQueue.push({
            estId: cliente.establishment_id,
            phone: cliente.telefone,
            msgs: montarMensagensCobranca(bc.mensagem_cobranca_template, dados, !!bc.cobranca_pix_separado),
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

// Fix de produção 32 — DESATIVADA (não chamada mais em runCheck() acima).
// Mantida no arquivo, comentada a chamada, por cautela — não apagada — mas
// cobrança por veículo não deve mais rodar (ver nota em runCheck()).
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
                `UPDATE agenda_frota_charges SET pix_code=$1, pix_provider=$2, asaas_payment_id=$3, invoice_url=$4, invoice_number=$5 WHERE id=$6`,
                [pix.code, pix.provider, pix.provider_payment_id || null, pix.invoice_url || null, pix.invoice_number || null, charge.id]
              );
              if (v.cliente_telefone) {
                const bc = est.business_config || {};
                const dados: DadosMensagemCobranca = {
                  nome: v.cliente_nome || 'cliente', empresa: est.name, modulo: 'Rastreamento',
                  plano: v.plano_nome, valor: preco, vencimentoLabel: hojeSaoPauloBR(),
                  faturaNumero: pix.invoice_number, pixPayload: pix.code, invoiceUrl: pix.invoice_url,
                };
                waQueue.push({
                  estId: est.id,
                  phone: v.cliente_telefone,
                  msgs: montarMensagensCobranca(bc.mensagem_cobranca_template, dados, !!bc.cobranca_pix_separado),
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
