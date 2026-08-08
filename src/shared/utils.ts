import pool from './db';

/**
 * Retorna o código de exibição do pedido idêntico ao painel do lojista.
 *
 * O banco já grava daily_code no formato "seg 9" (nome do dia + sequencial diário).
 * Esta função apenas retorna esse valor, ou monta um fallback se ele não existir.
 *
 * Exemplo: daily_code="seg 9" → "seg 9"
 */
export function formatOrderDisplayNumber(order: {
  daily_code?: string | number | null;
  order_number?: number | null;
  id?: string;
}): string {
  if (order.daily_code) return String(order.daily_code);
  if (order.order_number) return `#${order.order_number}`;
  return order.id?.slice(-6).toUpperCase() ?? '???';
}

/**
 * Gera um slug amigável e único para um estabelecimento.
 * @param name Nome do estabelecimento
 * @returns Slug limpo e verificado no banco de dados
 */
export async function generateUniqueSlug(name: string): Promise<string> {
    // 1. Limpa o nome: minúsculo, remove acentos e caracteres especiais
    let slug = name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^a-z0-9]+/g, '-')     // substitui tudo que não é letra ou número por hífen
        .replace(/^-|-$/g, '');          // remove hífens no início e fim

    if (!slug) slug = 'loja';

    // 2. Verifica se o slug já existe
    let finalSlug = slug;
    let counter = 1;
    
    while (true) {
        const result = await pool.query(`SELECT id FROM establishments WHERE slug = $1`, [finalSlug]);
        if (result.rows.length === 0) {
            break;
        }
        finalSlug = `${slug}-${counter}`;
        counter++;
    }

    return finalSlug;
}
