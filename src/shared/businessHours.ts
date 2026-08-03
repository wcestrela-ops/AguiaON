/**
 * Utilitário de horário de funcionamento.
 * Verifica se o estabelecimento está aberto no momento da chamada.
 */

import pool from './db';

export interface BusinessHoursRow {
  day_of_week: number;
  open_time: string;  // "09:00"
  close_time: string; // "22:00"
  is_closed: boolean;
}

export interface StoreStatus {
  is_open: boolean;
  message: string;          // Mensagem amigável para o cliente
  next_open?: string;       // ex: "Abrimos amanhã às 11:00"
}

const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/**
 * Converte "HH:MM" em minutos desde meia-noite.
 * "00:00" como horário de fechamento é tratado como 24:00 (1440 min) — fim do dia.
 */
function timeToMinutes(t: string, isClose = false): number {
  const [h, m] = t.split(':').map(Number);
  const total = h * 60 + m;
  return isClose && total === 0 ? 1440 : total;
}

/**
 * Verifica se o estabelecimento está aberto agora.
 * Retorna status e mensagem para exibir ao cliente.
 */
export async function checkStoreOpen(estId: string): Promise<StoreStatus> {
  try {
    // Primeiro: verificar toggle manual is_open
    const estRes = await pool.query(
      `SELECT settings FROM establishments WHERE id = $1`,
      [estId]
    );
    if (estRes.rows.length) {
      const settings = estRes.rows[0].settings || {};
      if (settings.is_open === false) {
        return {
          is_open: false,
          message: 'A loja está fechada no momento. Tente novamente mais tarde.',
        };
      }
    }

    const res = await pool.query(
      `SELECT day_of_week, open_time, close_time, is_closed
       FROM business_hours WHERE establishment_id = $1 ORDER BY day_of_week ASC`,
      [estId]
    );

    // Sem horários cadastrados → considera sempre aberto
    if (!res.rows.length) return { is_open: true, message: '' };

    const hoursMap: Record<number, BusinessHoursRow> = {};
    res.rows.forEach((r: any) => { hoursMap[r.day_of_week] = r; });

    // Usa fuso de Brasília para evitar erros de virada de dia em servidores UTC
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayDow = now.getDay();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const todayConfig = hoursMap[todayDow];

    if (todayConfig) {
      if (todayConfig.is_closed) {
        const next = findNextOpen(hoursMap, todayDow);
        return {
          is_open: false,
          message: `Estamos fechados hoje.${next ? ` ${next}` : ''}`,
          next_open: next,
        };
      }

      const open  = timeToMinutes(todayConfig.open_time);
      const close = timeToMinutes(todayConfig.close_time, true);

      if (nowMinutes < open) {
        const opens = todayConfig.open_time.substring(0, 5);
        return {
          is_open: false,
          message: `Ainda não abrimos. Abrimos hoje às *${opens}*!`,
          next_open: `Abrimos hoje às ${opens}`,
        };
      }

      if (nowMinutes > close) {
        const next = findNextOpen(hoursMap, todayDow);
        return {
          is_open: false,
          message: `Encerramos por hoje.${next ? ` ${next}` : ''}`,
          next_open: next,
        };
      }

      // Dentro do horário
      const closes = todayConfig.close_time.substring(0, 5);
      return { is_open: true, message: `Estamos abertos até as ${closes}.` };
    }

    // Dia sem configuração → considera aberto
    return { is_open: true, message: '' };
  } catch {
    // Em caso de erro, não bloqueia o pedido
    return { is_open: true, message: '' };
  }
}

function findNextOpen(hoursMap: Record<number, BusinessHoursRow>, fromDay: number): string {
  for (let i = 1; i <= 7; i++) {
    const dow = (fromDay + i) % 7;
    const cfg = hoursMap[dow];
    if (cfg && !cfg.is_closed) {
      const label = i === 1 ? 'amanhã' : `na ${DAY_NAMES[dow]}`;
      return `Abrimos ${label} às ${cfg.open_time.substring(0, 5)}.`;
    }
  }
  return '';
}
