import pool from './db';
import { buildAgataPromptText } from '../routes/delivery';

const DAY_NAMES = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

/**
 * Gera e persiste o contexto automático da Ágata para um estabelecimento.
 * Chamado após salvar produto, categoria ou configurações da loja.
 * O contexto é salvo em establishments.settings->>'ai'->>'knowledge'
 * e é lido por buildPromptForUser() no webhook.
 */
export async function syncAgataContext(estId: string): Promise<string> {
  // 1. Dados do estabelecimento
  const estRes = await pool.query(
    `SELECT name, business_config, settings FROM establishments WHERE id=$1`,
    [estId]
  );
  if (!estRes.rows[0]) throw new Error('Estabelecimento não encontrado');
  const est = estRes.rows[0];
  const bc  = est.business_config || {};

  // 2. Horários de funcionamento
  const hoursRes = await pool.query(
    `SELECT day_of_week, open_time, close_time, is_closed
     FROM business_hours
     WHERE establishment_id=$1
     ORDER BY day_of_week ASC`,
    [estId]
  );
  let horariosText = '';
  if (hoursRes.rows.length) {
    const dias = hoursRes.rows
      .filter((r: any) => !r.is_closed)
      .map((r: any) => `${DAY_NAMES[r.day_of_week]}: ${r.open_time?.slice(0,5)} às ${r.close_time?.slice(0,5)}`);
    if (dias.length) horariosText = `\nHorários de Funcionamento:\n${dias.join('\n')}`;
  }

  // 3. Catálogo de produtos (já formatado por buildAgataPromptText)
  const catalogText = await buildAgataPromptText(estId);

  // 4. Infos extras do business_config
  const extras: string[] = [];
  if (bc.estimated_time)   extras.push(`Tempo estimado de entrega: ${bc.estimated_time}`);
  if (bc.min_order)        extras.push(`Pedido mínimo: R$${Number(bc.min_order).toFixed(2)}`);
  if (bc.delivery_fee)     extras.push(`Taxa de entrega: R$${Number(bc.delivery_fee).toFixed(2)}`);
  if (bc.payment_methods?.length) extras.push(`Formas de pagamento: ${bc.payment_methods.join(', ')}`);

  // 5. Monta o conhecimento completo
  const knowledge = [
    `Loja: ${est.name}`,
    horariosText,
    extras.length ? extras.join('\n') : '',
    catalogText ? `\nCardápio:\n${catalogText}` : '',
  ].filter(Boolean).join('\n').trim();

  // 6. Persiste em settings.ai.knowledge (merge sem sobrescrever outras chaves de ai)
  await pool.query(
    `UPDATE establishments
     SET settings = jsonb_set(
       COALESCE(settings, '{}'),
       '{ai,knowledge}',
       to_jsonb($1::text)
     )
     WHERE id = $2`,
    [knowledge, estId]
  );

  return knowledge;
}
