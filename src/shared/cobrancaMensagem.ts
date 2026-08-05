// Fix de produção 23/24 — mensagens de cobrança configuráveis por
// estabelecimento, replicando o padrão que a Águia Gestão Veicular já usava
// (herdado do Águia Auto): fatura com número, link hospedado, aviso de
// pagamento confirmado com comprovante, e resumo de faturas atrasadas
// agrupado por cliente. Escopo: só o módulo Rastreamento (cobrança de
// veículo e de cliente) — outros módulos continuam com a mensagem simples
// que já tinham.
//
// Antes (Fix 23), cada rotina de cobrança tinha o próprio texto fixo
// (hardcoded), ligeiramente diferente uma da outra. O Carlos pediu pra poder
// editar esse texto, mandar o Pix Copia e Cola numa mensagem separada (mais
// fácil de copiar no celular — mesmo padrão que o checkout do delivery já
// usa em delivery.ts, só que lá não é opcional), e (Fix 24) manter o padrão
// de mensagem que a empresa já usava: fatura com número e link hospedado
// (preferência sobre o Pix cru), aviso de pagamento confirmado com link do
// comprovante, e um resumo consolidado quando o cliente tem mais de uma
// fatura atrasada — com frequência de reenvio configurável pelo lojista.
//
// Configurável em `establishments.business_config` (Configurações →
// Rastreamento no painel da loja):
//   - mensagem_cobranca_template (texto — cobrança vencendo/pendente)
//   - mensagem_pagamento_confirmado_template (texto — aviso de pagamento)
//   - cobranca_pix_separado (boolean)
//   - aviso_atraso_frequencia_dias (número de dias entre um resumo de
//     atraso e outro pro mesmo cliente — 0/vazio desativa o aviso)

export interface DadosMensagemCobranca {
  nome: string;
  empresa?: string | null;
  modulo?: string | null;
  plano?: string | null;
  valor: number;
  descricao?: string | null;
  /** Texto livre pro contexto do vencimento, ex: "hoje", "10/08/2026" — quem
   *  chama decide a redação, essa função só encaixa no lugar certo. */
  vencimentoLabel?: string | null;
  /** "N°..." que o cliente vê na fatura (só existe pra cobrança via Asaas). */
  faturaNumero?: string | null;
  pixPayload?: string | null;
  invoiceUrl?: string | null;
}

export const MENSAGEM_COBRANCA_PADRAO =
`*{{empresa}}*
⚠️ *SUA FATURA ESTÁ DISPONÍVEL!* ⚠️
Prezado(a) *{{nome}}*, informamos que a sua fatura{{fatura_numero}}{{vencimento}}, no valor de *{{valor}}*, já encontra-se disponível para pagamento.
{{pagamento}}
⚠️ Caso já tenha efetuado o pagamento favor desconsiderar essa mensagem!
Obrigado pela preferência e conte sempre conosco!
🤖 Mensagem automática`;

/**
 * Monta a(s) mensagem(ns) de cobrança a enviar pro cliente. Normalmente 1 —
 * ou 2 se `pixSeparado` estiver ligado e houver um código Pix (a segunda
 * mensagem é só o código puro, sem mais nada, pra facilitar copiar no
 * celular — quem manda essa fila decide o delay entre as duas). O link da
 * fatura hospedada (quando existe — cobrança via Asaas) tem prioridade sobre
 * o Pix cru no corpo principal, igual ao padrão que a empresa já usava; o
 * Pix só aparece ali quando NÃO há link (manual_pix/mercadopago).
 */
export function montarMensagensCobranca(
  template: string | null | undefined,
  dados: DadosMensagemCobranca,
  pixSeparado: boolean
): string[] {
  const tpl = (template && template.trim()) ? template : MENSAGEM_COBRANCA_PADRAO;
  const valorFmt = `R$ ${Number(dados.valor || 0).toFixed(2).replace('.', ',')}`;

  let pagamentoBloco = '';
  if (dados.invoiceUrl) {
    pagamentoBloco = `*Fatura:* ${dados.invoiceUrl}`;
  } else if (dados.pixPayload && !pixSeparado) {
    pagamentoBloco = `Pix Copia e Cola:\n\`${dados.pixPayload}\``;
  } else if (dados.pixPayload && pixSeparado) {
    pagamentoBloco = '👇 O código Pix Copia e Cola vem na próxima mensagem.';
  }

  const principal = tpl
    .replace(/\{\{nome\}\}/g, dados.nome || '')
    .replace(/\{\{empresa\}\}/g, dados.empresa || '')
    .replace(/\{\{modulo\}\}/g, dados.modulo || '')
    .replace(/\{\{plano\}\}/g, dados.plano || '')
    .replace(/\{\{valor\}\}/g, valorFmt)
    .replace(/\{\{descricao\}\}/g, dados.descricao ? ` (${dados.descricao})` : '')
    .replace(/\{\{vencimento\}\}/g, dados.vencimentoLabel ? `, com vencimento em *${dados.vencimentoLabel}*` : '')
    .replace(/\{\{fatura_numero\}\}/g, dados.faturaNumero ? ` *N°${dados.faturaNumero}*` : '')
    .replace(/\{\{pagamento\}\}/g, pagamentoBloco)
    // Placeholders soltos, pra quem preferir montar o texto do próprio jeito
    // em vez de usar o bloco {{pagamento}} pronto:
    .replace(/\{\{pix\}\}/g, (dados.pixPayload && !pixSeparado) ? dados.pixPayload : '')
    .replace(/\{\{link\}\}/g, dados.invoiceUrl || '');

  const mensagens = [principal];
  if (pixSeparado && dados.pixPayload) mensagens.push(dados.pixPayload);
  return mensagens;
}

// ─────────────────────────────────────────────────────────────
// Pagamento confirmado (Fix de produção 24) — mesmo padrão de "PAGAMENTO
// CONFIRMADO" que a empresa já usava, com o link do comprovante quando
// disponível (só vem preenchido depois que o Asaas confirma o pagamento).
// ─────────────────────────────────────────────────────────────

export interface DadosPagamentoConfirmado {
  nome: string;
  empresa?: string | null;
  valor: number;
  descricao?: string | null;
  vencimentoLabel?: string | null;
  faturaNumero?: string | null;
  invoiceUrl?: string | null;
  comprovanteUrl?: string | null;
}

export const MENSAGEM_PAGAMENTO_CONFIRMADO_PADRAO =
`*{{empresa}}*
✅ *PAGAMENTO CONFIRMADO* ✅
Prezado(a) *{{nome}}*, informamos que recebemos o pagamento no valor de *{{valor}}*{{descricao}} referente a sua fatura{{fatura_numero}}{{vencimento}}.
{{links}}
Obrigado pela preferência e conte sempre conosco!
🤖 Mensagem automática`;

export function montarMensagemPagamentoConfirmado(
  template: string | null | undefined,
  dados: DadosPagamentoConfirmado
): string {
  const tpl = (template && template.trim()) ? template : MENSAGEM_PAGAMENTO_CONFIRMADO_PADRAO;
  const valorFmt = `R$ ${Number(dados.valor || 0).toFixed(2).replace('.', ',')}`;

  const links = [
    dados.invoiceUrl ? `*Fatura:* ${dados.invoiceUrl}` : '',
    dados.comprovanteUrl ? `*Comprovante:* ${dados.comprovanteUrl}` : '',
  ].filter(Boolean).join('\n');

  return tpl
    .replace(/\{\{nome\}\}/g, dados.nome || '')
    .replace(/\{\{empresa\}\}/g, dados.empresa || '')
    .replace(/\{\{valor\}\}/g, valorFmt)
    .replace(/\{\{descricao\}\}/g, dados.descricao ? ` (${dados.descricao})` : '')
    .replace(/\{\{vencimento\}\}/g, dados.vencimentoLabel ? ` com vencimento em *${dados.vencimentoLabel}*` : '')
    .replace(/\{\{fatura_numero\}\}/g, dados.faturaNumero ? ` *N°${dados.faturaNumero}*` : '')
    .replace(/\{\{links\}\}/g, links);
}

// ─────────────────────────────────────────────────────────────
// Resumo de faturas atrasadas (Fix de produção 24) — pedido do Carlos:
// quando um cliente acumula mais de uma fatura vencida, manda UMA mensagem
// consolidada (em vez de uma por fatura) — mesmo padrão que a empresa já
// usava. A frequência de reenvio (pra não repetir todo dia enquanto o
// cliente não paga) é configurável pelo lojista em Configurações →
// Rastreamento (`aviso_atraso_frequencia_dias`) — quem decide QUANDO chamar
// essa função é o job (trackingBillingJob.ts), não ela mesma.
// ─────────────────────────────────────────────────────────────

export interface FaturaAtrasada {
  faturaNumero?: string | null;
  vencimentoLabel: string;
  diasAtraso: number;
  valor: number;
  invoiceUrl?: string | null;
}

export function montarMensagemResumoAtraso(
  empresaNome: string,
  clienteNome: string,
  faturas: FaturaAtrasada[]
): string {
  const valorTotal = faturas.reduce((s, f) => s + Number(f.valor || 0), 0);
  const valorTotalFmt = `R$ ${valorTotal.toFixed(2).replace('.', ',')}`;

  const blocos = faturas.map(f => {
    const linhas = [
      `🧾 Fatura${f.faturaNumero ? ` N°${f.faturaNumero}` : ''}`,
      `- Vencimento: ${f.vencimentoLabel}`,
      `- Atraso: ${f.diasAtraso} dia${f.diasAtraso === 1 ? '' : 's'}`,
      `- Valor: R$ ${Number(f.valor || 0).toFixed(2).replace('.', ',')}`,
    ];
    if (f.invoiceUrl) linhas.push(`- Link Fatura: ${f.invoiceUrl}`);
    return linhas.join('\n');
  }).join('\n\n');

  return `*${empresaNome}*
Prezado(a) ${clienteNome}, informamos que você possui ${faturas.length} fatura${faturas.length === 1 ? '' : 's'} vencida${faturas.length === 1 ? '' : 's'} no valor total de *${valorTotalFmt}*.
⚠️ Por favor, regularize sua situação evitando transtornos e a suspensão do serviço prestado. ⚠️
${blocos}

Obrigado pela preferência e conte sempre conosco!
🤖 Mensagem automática`;
}
