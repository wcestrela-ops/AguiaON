/**
 * ══════════════════════════════════════════════════════════════
 *  Águia-ON — Camada de Blindagem de Dados (Data Shield)
 *  Versão: 1.0
 *
 *  Anonimiza OBRIGATORIAMENTE qualquer texto antes de enviá-lo
 *  a provedores de IA externos (Groq, OpenAI, Gemini, Anthropic).
 *
 *  Detecta e substitui por placeholders:
 *    → CPF, CNPJ, RG
 *    → Telefone (qualquer formato BR)
 *    → E-mail
 *    → Placas (Mercosul e antiga)
 *    → CEP e endereços físicos
 *    → Valores monetários
 *    → Nomes de pessoas (heurística NER sem dependência externa)
 *
 *  Retorna { cleanText, keyMap } onde keyMap fica APENAS na VPS
 *  para des-anonimização posterior quando necessário.
 * ══════════════════════════════════════════════════════════════
 */

export interface AnonymizationResult {
  cleanText: string;
  /** Mapa placeholder → valor original. Guardar APENAS na VPS. */
  keyMap: Record<string, string>;
}

// ── Palavras que parecem nome próprio mas NÃO são pessoas ─────
const NON_NAME_WORDS = new Set([
  // Dias da semana
  'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo',
  // Meses
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
  // Títulos e prefixos comuns
  'Sr','Sra','Dr','Dra','Prof','Eng','Av','Rua','Alameda','Travessa',
  'Praça','Estrada','Rodovia','Avenida','Bloco','Torre','Bairro',
  // Termos de negócio / lugar
  'Brasil','São','Santo','Santa','Norte','Sul','Leste','Oeste',
  'Centro','Vila','Jardim','Parque','Cidade','Estado','Capital',
  // Siglas comuns
  'PIX','CPF','CNPJ','CEP','MEI','LTDA','SA','ME','EIRELI',
]);

// ── Regexes ───────────────────────────────────────────────────

// CPF: 000.000.000-00 ou 00000000000
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

// CNPJ: 00.000.000/0000-00 ou 00000000000000
const RE_CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?0001-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g;

// RG: vários formatos estaduais brasileiros (7-9 dígitos com separadores)
const RE_RG = /\b\d{1,2}\.?\d{3}\.?\d{3}-?[0-9Xx]\b/g;

// Telefone BR: +55, (11), 11 9xxxx-xxxx, etc.
const RE_PHONE = /(?:\+?55\s?)?(?:\(0?\d{2}\)|0?\d{2})[\s\-]?(?:9\s?)?\d{4}[\s\-]?\d{4}\b/g;

// E-mail
const RE_EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Placa Mercosul: ABC1D23 ou ABC1D2X
const RE_PLATE_MERCOSUL = /\b[A-Z]{3}\d[A-Z]\d{2}\b/g;

// Placa antiga: ABC-1234 ou ABC1234
const RE_PLATE_OLD = /\b[A-Z]{3}[\s\-]?\d{4}\b/g;

// CEP: 00000-000 ou 00000000
const RE_CEP = /\b\d{5}-?\d{3}\b/g;

// Endereço: linha que começa com padrão de logradouro
// Detecta: "Rua X, 123", "Av. Y, 456", "Al. Z, 789", etc.
const RE_ADDRESS = /\b(?:Rua|R\.|Av\.?|Avenida|Alameda|Al\.|Travessa|Tv\.|Praça|Pç\.?|Estrada|Est\.|Rod\.?|Rodovia|Largo|Beco)\s+[^\n,.]{3,40}(?:,\s*\d+[^\n,]{0,30})?/gi;

// Valor monetário: R$ 1.234,56 ou R$1234
const RE_MONEY = /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d{1,3}(?:\.\d{3})+,\d{2}/g;

// Nome de pessoa (heurística NER):
// Duas ou mais palavras Title Case consecutivas, excluindo as palavras da lista acima.
// Precedidas por indicadores comuns: "cliente", "sr.", "nome:", etc.
const RE_NAME_INDICATOR = /(?:(?:cliente|contratante|usuário|paciente|nome|sr\.?|sra\.?|dr\.?|dra\.?|prof\.?|eng\.?)\s+)([A-ZÁÉÍÓÚÀÃÕÂÊÎ][a-záéíóúàãõâêî]+(?:\s+(?:d[aeo]s?|e)\s+)?(?:\s+[A-ZÁÉÍÓÚÀÃÕÂÊÎ][a-záéíóúàãõâêî]+)+)/gi;

// Nome sem indicador: 2+ palavras Title Case que não sejam palavras conhecidas
const RE_NAME_BARE = /\b([A-ZÁÉÍÓÚÀÃÕÂÊÎ][a-záéíóúàãõâêî]{1,}(?:\s+(?:da?|de|do|dos|das|e)\s+)?(?:\s+[A-ZÁÉÍÓÚÀÃÕÂÊÎ][a-záéíóúàãõâêî]{1,}){1,4})\b/g;

// ── Helpers ───────────────────────────────────────────────────

function isLikelyPersonName(candidate: string): boolean {
  const words = candidate.trim().split(/\s+/);
  if (words.length < 2) return false;

  // Rejeita se qualquer palavra significativa for da lista de exclusão
  const significantWords = words.filter(w => !/^(da?|de|do|dos|das|e)$/i.test(w));
  if (significantWords.some(w => NON_NAME_WORDS.has(w))) return false;

  // Rejeita strings muito longas (provável endereço ou frase)
  if (words.length > 5) return false;

  // Rejeita se contiver número
  if (/\d/.test(candidate)) return false;

  // Todas as palavras significativas devem ser Title Case
  return significantWords.every(w => /^[A-ZÁÉÍÓÚÀÃÕÂÊÎ][a-záéíóúàãõâêî]+$/.test(w));
}

class PlaceholderCounter {
  private counters: Record<string, number> = {};
  private reverseMap: Map<string, string> = new Map(); // original → placeholder

  next(prefix: string): string {
    this.counters[prefix] = (this.counters[prefix] || 0) + 1;
    return `[${prefix}_${this.counters[prefix]}]`;
  }

  getOrCreate(prefix: string, original: string): string {
    const normalised = original.trim();
    if (this.reverseMap.has(normalised)) return this.reverseMap.get(normalised)!;
    const ph = this.next(prefix);
    this.reverseMap.set(normalised, ph);
    return ph;
  }
}

// ── Função principal ──────────────────────────────────────────

/**
 * Anonimiza `text` substituindo dados sensíveis por placeholders.
 *
 * @param text  Texto original (prompt ou mensagem do usuário)
 * @returns     { cleanText, keyMap }  —  keyMap deve ficar SOMENTE na VPS
 */
export function anonymize(text: string): AnonymizationResult {
  const keyMap: Record<string, string> = {};
  const counter = new PlaceholderCounter();

  function replace(match: string, prefix: string): string {
    const ph = counter.getOrCreate(prefix, match);
    keyMap[ph] = match;
    return ph;
  }

  let out = text;

  // 1. E-mails (antes de nomes para evitar capturar partes do e-mail como nome)
  out = out.replace(RE_EMAIL, m => replace(m, 'EMAIL'));

  // 2. CNPJ (antes de CPF — mais específico)
  out = out.replace(RE_CNPJ, m => replace(m, 'CNPJ'));

  // 3. CPF
  out = out.replace(RE_CPF, m => replace(m, 'CPF'));

  // 4. RG — aplica apenas se não parecer CPF já substituído
  out = out.replace(RE_RG, m => {
    // Evita re-processar se já for placeholder
    if (m.startsWith('[')) return m;
    return replace(m, 'RG');
  });

  // 5. Placas (Mercosul primeiro — mais específico)
  out = out.replace(RE_PLATE_MERCOSUL, m => replace(m, 'PLACA'));
  out = out.replace(RE_PLATE_OLD, m => replace(m, 'PLACA'));

  // 6. Telefones
  out = out.replace(RE_PHONE, m => replace(m, 'FONE'));

  // 7. CEP
  out = out.replace(RE_CEP, m => replace(m, 'CEP'));

  // 8. Endereços físicos
  out = out.replace(RE_ADDRESS, m => replace(m, 'ENDERECO'));

  // 9. Valores monetários
  out = out.replace(RE_MONEY, m => replace(m, 'VALOR'));

  // 10. Nomes com indicador (ex: "cliente João Silva")
  out = out.replace(RE_NAME_INDICATOR, (fullMatch, nameCapture) => {
    const prefix = fullMatch.slice(0, fullMatch.indexOf(nameCapture));
    const ph = replace(nameCapture, 'NOME');
    return prefix + ph;
  });

  // 11. Nomes sem indicador (heurística NER)
  out = out.replace(RE_NAME_BARE, (m) => {
    if (m.startsWith('[')) return m; // já é placeholder
    if (!isLikelyPersonName(m)) return m;
    return replace(m, 'NOME');
  });

  return { cleanText: out, keyMap };
}

/**
 * Restaura texto anonimizado usando o mapa de chaves.
 * Usar SOMENTE dentro da VPS — nunca expor keyMap externamente.
 */
export function deanonymize(text: string, keyMap: Record<string, string>): string {
  let out = text;
  for (const [placeholder, original] of Object.entries(keyMap)) {
    // Escapa colchetes para uso em regex
    const escaped = placeholder.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    out = out.replace(new RegExp(escaped, 'g'), original);
  }
  return out;
}

/**
 * Anonimiza um array de mensagens AIMessage[], retornando
 * as mensagens limpas + o mapa consolidado de todas as mensagens.
 *
 * Mensagens com role 'system' são anonimizadas mais suavemente
 * (apenas CPF/e-mail/telefone), pois geralmente contêm apenas
 * regras de negócio sem dados reais de clientes.
 */
export function anonymizeMessages(
  messages: Array<{ role: string; content: string }>
): { cleanMessages: Array<{ role: string; content: string }>; keyMap: Record<string, string> } {
  const combinedKeyMap: Record<string, string> = {};

  const cleanMessages = messages.map(msg => {
    const { cleanText, keyMap } = anonymize(msg.content);
    Object.assign(combinedKeyMap, keyMap);
    return { ...msg, content: cleanText };
  });

  return { cleanMessages, keyMap: combinedKeyMap };
}

/**
 * Verifica se um texto contém dados sensíveis sem anonimizá-lo.
 * Útil para logs de auditoria.
 */
export function hasSensitiveData(text: string): boolean {
  return (
    RE_CPF.test(text) ||
    RE_PHONE.test(text) ||
    RE_EMAIL.test(text) ||
    RE_PLATE_MERCOSUL.test(text) ||
    RE_PLATE_OLD.test(text) ||
    RE_CEP.test(text) ||
    RE_CNPJ.test(text)
  );
}
