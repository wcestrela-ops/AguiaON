/**
 * Cliente Asaas — AguiaON
 *
 * Camada compartilhada pra falar com a API oficial do Asaas em nome de um
 * establishment (cada empresa usa a própria conta Asaas — `asaas_api_key`,
 * já configurada em Configurações → Pagamentos, mesma coluna que o
 * pixService.ts usa pra gerar cobrança avulsa). Este módulo adiciona o que
 * faltava: listar clientes já cadastrados na conta, criar cliente formal
 * (com CPF/telefone/email), e consultar assinaturas/cobranças por cliente —
 * usado pela Fase 12 (Clientes do Rastreamento) pra importar a base que o
 * lojista já tinha no Asaas antes de existir o AguiaON.
 *
 * Mesmo padrão de gpswoxClient.ts: `request()` central, credencial
 * descriptografada sob demanda, sem cache de dados (só a chamada HTTP).
 */

import pool from './db';
import { decrypt } from './cryptoUtil';

const BASE_URL = 'https://api.asaas.com/v3';

export interface AsaasCustomer {
  id: string;
  name: string;
  phone?: string | null;
  mobilePhone?: string | null;
  email?: string | null;
  cpfCnpj?: string | null;
}

export interface AsaasPayment {
  id: string;
  customer: string;
  subscription?: string | null;
  value: number;
  status: string; // PENDING | RECEIVED | CONFIRMED | OVERDUE | REFUNDED | ...
  dueDate: string;
  description?: string | null;
  invoiceUrl?: string | null;
  billingType?: string;
  /** Fix de produção 24 — "N°..." que o cliente vê na fatura, diferente do
   *  `id` interno (usado nas mensagens de cobrança/pagamento confirmado). */
  invoiceNumber?: string | null;
  /** Só vem preenchido depois de confirmado — link do comprovante de
   *  pagamento (também usado nas mensagens de pagamento confirmado). */
  transactionReceiptUrl?: string | null;
}

export interface AsaasSubscription {
  id: string;
  customer: string;
  value: number;
  status: string; // ACTIVE | INACTIVE | EXPIRED
  cycle: string;
  nextDueDate?: string | null;
  description?: string | null;
}

async function getApiKey(estId: string): Promise<string> {
  const r = await pool.query(`SELECT asaas_api_key FROM establishments WHERE id=$1`, [estId]);
  const raw = r.rows[0]?.asaas_api_key;
  if (!raw) throw new Error('Conta Asaas não configurada para esta empresa. Configure em Configurações → Pagamentos.');
  return decrypt(raw);
}

async function request(estId: string, path: string, opts: { method?: string; body?: any; query?: Record<string, string | number | undefined> } = {}): Promise<any> {
  const apiKey = await getApiKey(estId);
  let url = `${BASE_URL}${path}`;
  if (opts.query) {
    const qs = Object.entries(opts.query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', access_token: apiKey },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.errors?.[0]?.description || (data as any)?.message || `Asaas respondeu HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ─── Clientes ─────────────────────────────────────────────────

// Lista TODOS os clientes da conta Asaas, paginando automaticamente
// (limite de segurança de 1000 clientes por sincronização).
export async function listAllCustomers(estId: string): Promise<AsaasCustomer[]> {
  const all: AsaasCustomer[] = [];
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < 10; i++) { // hard cap: 10 páginas = até 1000 clientes
    const data = await request(estId, '/customers', { query: { offset, limit } });
    const rows: AsaasCustomer[] = data?.data || [];
    all.push(...rows);
    if (data?.hasMore !== true || rows.length < limit) break;
    offset += limit;
  }
  return all;
}

export async function createCustomer(estId: string, input: { name: string; phone?: string | null; mobilePhone?: string | null; email?: string | null; cpfCnpj?: string | null }): Promise<AsaasCustomer> {
  return request(estId, '/customers', {
    method: 'POST',
    body: {
      name: input.name,
      phone: input.phone || undefined,
      mobilePhone: input.mobilePhone || input.phone || undefined,
      email: input.email || undefined,
      cpfCnpj: input.cpfCnpj || undefined,
    },
  });
}

// ─── Cobranças e assinaturas por cliente ───────────────────────

// Fix de produção 25 — o Pix Copia e Cola só é buscado no Asaas na hora que
// A GENTE cria a cobrança (createPixCharge, logo depois do POST /payments).
// Cobrança trazida por sincronização (getCustomerPayments/sync-asaas) ou já
// existente no cache antes desse fix nunca teve esse código puxado — essa
// função busca sob demanda pra qualquer pagamento existente (dado o próprio
// asaas_id), usada pelo lembrete/reenvio quando falta o Pix no cache local.
export async function getPixPayload(estId: string, paymentId: string): Promise<string | null> {
  try {
    const data = await request(estId, `/payments/${paymentId}/pixQrCode`);
    return data?.payload || null;
  } catch (err: any) {
    console.warn(`[asaasClient] getPixPayload falhou (payment=${paymentId}):`, err.message);
    return null;
  }
}

export async function getCustomerPayments(estId: string, customerId: string): Promise<AsaasPayment[]> {
  const data = await request(estId, '/payments', { query: { customer: customerId, limit: 100 } });
  return data?.data || [];
}

export async function getCustomerSubscriptions(estId: string, customerId: string): Promise<AsaasSubscription[]> {
  const data = await request(estId, '/subscriptions', { query: { customer: customerId, limit: 100 } });
  return data?.data || [];
}

// ─── Cobrança avulsa (PIX) pra um cliente já cadastrado ────────
export async function createPixCharge(estId: string, input: { customerId: string; value: number; description?: string; dueDateDaysAhead?: number; externalReference?: string }): Promise<{ payment: AsaasPayment; pixPayload: string | null }> {
  const due = new Date();
  due.setDate(due.getDate() + (input.dueDateDaysAhead ?? 1));
  const payment: AsaasPayment = await request(estId, '/payments', {
    method: 'POST',
    body: {
      customer: input.customerId,
      billingType: 'PIX',
      value: input.value,
      dueDate: due.toISOString().split('T')[0],
      description: input.description || undefined,
      externalReference: input.externalReference || undefined,
    },
  });
  let pixPayload: string | null = null;
  try {
    const pix = await request(estId, `/payments/${payment.id}/pixQrCode`);
    pixPayload = pix?.payload || null;
  } catch { /* charge já foi criada; só o QR falhou — segue sem travar */ }
  return { payment, pixPayload };
}

// ─── Nota fiscal (NFS-e) ────────────────────────────────────────
// Schema confirmado na doc oficial (docs.asaas.com/reference/*.md — versão
// OpenAPI, lida em 08/2026). Suporta autenticação da prefeitura via
// usuário+senha ou token; certificado digital (upload de arquivo) ficou
// fora do escopo desta fatia — ver observação na Fase 13 do roadmap.

export interface MunicipalOptions {
  authenticationType: 'CERTIFICATE' | 'TOKEN' | 'USER_AND_PASSWORD';
  supportsCancellation: boolean;
  usesSpecialTaxRegimes: boolean;
  usesServiceListItem: boolean;
  usesStateInscription: boolean;
  specialTaxRegimesList: { label: string; value: string }[] | null;
  municipalInscriptionHelp?: string | null;
  specialTaxRegimeHelp?: string | null;
  serviceListItemHelp?: string | null;
  accessTokenHelp?: string | null;
  municipalServiceCodeHelp?: string | null;
}

export interface MunicipalService {
  id: string;
  description: string;
  issTax?: number;
}

export interface InvoiceTaxes {
  retainIss: boolean;
  iss: number;
  pis: number;
  cofins: number;
  csll: number;
  inss: number;
  ir: number;
}

export interface AsaasInvoice {
  id: string;
  status: string; // SCHEDULED | SYNCHRONIZED | AUTHORIZED | PROCESSING_CANCELLATION | CANCELED | CANCELLATION_DENIED | ERROR
  value: number;
  effectiveDate: string;
  pdfUrl?: string | null;
  xmlUrl?: string | null;
  statusDescription?: string | null;
}

// GET /v3/fiscalInfo/municipalOptions — o que a prefeitura da conta exige
export async function getMunicipalOptions(estId: string): Promise<MunicipalOptions> {
  return request(estId, '/fiscalInfo/municipalOptions');
}

// GET /v3/invoices/municipalServices — lista de serviços municipais (pode vir vazia
// se a prefeitura não disponibilizar; nesse caso usa-se municipalServiceCode manual)
export async function listMunicipalServices(estId: string, description?: string): Promise<MunicipalService[]> {
  const data = await request(estId, '/invoices/municipalServices', { query: { description, limit: 100 } });
  return data?.data || [];
}

// POST /v3/fiscalInfo — multipart/form-data (exigência da API, mesmo sem upload de arquivo)
export async function saveFiscalInfo(estId: string, input: {
  email: string;
  municipalInscription?: string;
  simplesNacional: boolean;
  culturalProjectsPromoter?: boolean;
  cnae?: string;
  specialTaxRegime?: string;
  serviceListItem?: string;
  nbsCode?: string;
  rpsSerie?: string;
  rpsNumber?: number;
  loteNumber?: number;
  username?: string;
  password?: string;
  accessToken?: string;
}): Promise<any> {
  const apiKey = await getApiKey(estId);
  const form = new FormData();
  Object.entries(input).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  });
  const res = await fetch(`${BASE_URL}/fiscalInfo`, {
    method: 'POST',
    headers: { access_token: apiKey },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.errors?.[0]?.description || `Asaas respondeu HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// POST /v3/invoices — agenda a emissão (effectiveDate=hoje emite em até ~15min)
export async function scheduleInvoice(estId: string, input: {
  payment?: string;
  installment?: string;
  customer?: string;
  serviceDescription: string;
  observations?: string;
  externalReference?: string;
  value: number;
  deductions?: number;
  effectiveDate: string; // YYYY-MM-DD
  municipalServiceId?: string | null;
  municipalServiceCode?: string | null;
  municipalServiceName: string;
  taxes: InvoiceTaxes;
}): Promise<AsaasInvoice> {
  if (!input.payment && !input.installment && !input.customer) {
    throw new Error('scheduleInvoice precisa de payment, installment ou customer para identificar a origem da nota.');
  }
  return request(estId, '/invoices', {
    method: 'POST',
    body: { deductions: 0, ...input },
  });
}
