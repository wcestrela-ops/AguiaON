// Fix de produção 23 — mensagem de cobrança configurável por estabelecimento.
//
// Antes, cada rotina de cobrança tinha o próprio texto fixo (hardcoded),
// ligeiramente diferente uma da outra: o job automático de rastreamento por
// veículo (trackingBillingJob.ts/gerarCobrancasDoDia), a recorrência de
// cliente (gerarCobrancasRecorrentesClientes), o lembrete de cobrança
// sincronizada do Asaas (enviarLembretesCobrancasAsaas), e os dois botões de
// reenvio manual "Cobrar via WhatsApp" (agenda/index.ts). O Carlos pediu pra
// poder editar esse texto e também poder mandar o código Pix Copia e Cola
// numa mensagem separada da principal — mais fácil de copiar no celular
// (mesmo padrão que o fluxo de checkout do delivery já usa em delivery.ts,
// só que lá não é opcional).
//
// Configurável em `establishments.business_config`:
//   - mensagem_cobranca_template (texto, com os placeholders abaixo)
//   - cobranca_pix_separado (boolean)
// Editável em Configurações → Rastreamento no painel da loja (loja.html).

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
  pixPayload?: string | null;
  invoiceUrl?: string | null;
}

export const MENSAGEM_COBRANCA_PADRAO =
`💳 *Olá, {{nome}}!*

Você tem uma cobrança{{descricao}} no valor de *{{valor}}*{{vencimento}}.

{{pagamento}}

Após pagar, a confirmação é automática!`;

/**
 * Monta a(s) mensagem(ns) de cobrança a enviar pro cliente. Normalmente 1 —
 * ou 2 se `pixSeparado` estiver ligado e houver um código Pix (a segunda
 * mensagem é só o código puro, sem mais nada, pra facilitar copiar no
 * celular — quem manda essa fila decide o delay entre as duas).
 */
export function montarMensagensCobranca(
  template: string | null | undefined,
  dados: DadosMensagemCobranca,
  pixSeparado: boolean
): string[] {
  const tpl = (template && template.trim()) ? template : MENSAGEM_COBRANCA_PADRAO;
  const valorFmt = `R$ ${Number(dados.valor || 0).toFixed(2).replace('.', ',')}`;

  let pagamentoBloco = '';
  if (dados.pixPayload && pixSeparado) {
    pagamentoBloco = '👇 O código Pix Copia e Cola vem na próxima mensagem.';
  } else if (dados.pixPayload) {
    pagamentoBloco = `Pix Copia e Cola:\n\`${dados.pixPayload}\``;
  } else if (dados.invoiceUrl) {
    pagamentoBloco = `Link para pagamento:\n${dados.invoiceUrl}`;
  }

  const principal = tpl
    .replace(/\{\{nome\}\}/g, dados.nome || '')
    .replace(/\{\{empresa\}\}/g, dados.empresa || '')
    .replace(/\{\{modulo\}\}/g, dados.modulo || '')
    .replace(/\{\{plano\}\}/g, dados.plano || '')
    .replace(/\{\{valor\}\}/g, valorFmt)
    .replace(/\{\{descricao\}\}/g, dados.descricao ? ` (${dados.descricao})` : '')
    .replace(/\{\{vencimento\}\}/g, dados.vencimentoLabel ? ` — vencimento ${dados.vencimentoLabel}` : '')
    .replace(/\{\{pagamento\}\}/g, pagamentoBloco)
    // Placeholders soltos, pra quem preferir montar o texto do próprio jeito
    // em vez de usar o bloco {{pagamento}} pronto:
    .replace(/\{\{pix\}\}/g, (dados.pixPayload && !pixSeparado) ? dados.pixPayload : '')
    .replace(/\{\{link\}\}/g, dados.invoiceUrl || '');

  const mensagens = [principal];
  if (pixSeparado && dados.pixPayload) mensagens.push(dados.pixPayload);
  return mensagens;
}
