import pool from './db';
import { getSmtpSettings, sendEmail } from './mailer';
import { sendWhatsAppMessageWithStatus } from './waSender';

// Gera código de 6 dígitos
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Fix de produção 27 — este arquivo tinha SUA PRÓPRIA lógica de SMTP e de
// Evolution API, duplicada e divergente da que o resto do app já usa (e que
// o Carlos confirmou que funciona — Termo de Adesão por e-mail, cobranças
// por WhatsApp). Duas causas raiz encontradas pro "recuperação de senha não
// chega por e-mail nem WhatsApp":
//   1) E-mail: a porta do SMTP vinha HARDCODED em 587, ignorando o
//      `smtp_port` configurado em Configurações Globais — se a conta do
//      Carlos usa outra porta, a autenticação falhava (era exatamente o
//      erro "Invalid login" que apareceu no log). Corrigido reaproveitando
//      `mailer.ts` (mesmo módulo usado pelo Termo de Adesão), que já lê a
//      porta certa.
//   2) WhatsApp: buscava `evolution_url`/`evolution_token` sem o filtro
//      `category='WHATSAPP'` que o resto do app usa, e mandava pra uma
//      instância chamada `wa_platform_instance` — uma chave que não existe
//      em lugar nenhum do sistema (nunca foi salva por nenhuma tela), então
//      sempre caía no nome genérico "default", que não existe na Evolution
//      de verdade. Corrigido reaproveitando `waSender.ts` (o mesmo envio de
//      WhatsApp já usado por pedidos/cobranças), que resolve a instância
//      certa por estabelecimento.

// Envia via Email (SMTP configurado no admin) — mesma função usada pelo
// Termo de Adesão (`mailer.ts`), só muda o template.
async function sendViaEmail(to: string, code: string): Promise<boolean> {
  try {
    const settings = await getSmtpSettings();
    const subject = `${settings.pwa_name || 'Águia-ON'} — Código de verificação`;
    const html = `
      <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;background:#020617;color:#cbd5e1;border-radius:16px">
        <h2 style="color:#6366f1;margin:0 0 16px">Código de verificação</h2>
        <p style="margin:0 0 24px">Use o código abaixo para confirmar sua ação:</p>
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:24px;text-align:center">
          <span style="font-size:36px;font-weight:900;letter-spacing:12px;color:#fff">${code}</span>
        </div>
        <p style="margin:24px 0 0;font-size:12px;color:#475569">Válido por 10 minutos. Não compartilhe este código.</p>
      </div>
    `;
    return await sendEmail(to, subject, html);
  } catch (err: any) {
    console.error('❌ Falha ao enviar email OTP:', err.message);
    return false;
  }
}

// Envia via WhatsApp — precisa saber de QUAL estabelecimento (pra resolver a
// instância certa da Evolution, ou a API custom do lojista). Sem estId (ex:
// SuperAdmin, ou cliente de cadastro genérico sem loja vinculada) não tem
// como saber qual número/instância usar, então esse canal fica indisponível
// pra esses casos — o e-mail continua sendo a via de recuperação.
async function sendViaWhatsApp(estId: string | null | undefined, whatsapp: string, code: string): Promise<boolean> {
  if (!estId || !whatsapp) return false;
  try {
    const message = `*Código de verificação:*\n\n*${code}*\n\nVálido por 10 minutos. Não compartilhe este código.`;
    return await sendWhatsAppMessageWithStatus(estId, whatsapp, message);
  } catch (err: any) {
    console.error('❌ Falha ao enviar WhatsApp OTP:', err.message);
    return false;
  }
}

// --- FUNÇÃO PRINCIPAL ---
// Gera, salva e dispara o OTP pelos dois canais em paralelo
export async function sendOtp(
  userId: string,
  whatsapp: string,
  email: string | null,
  purpose: string = 'PROFILE_EDIT',
  estId?: string | null
): Promise<{ sent: boolean; channels: string[] }> {
  const code = generateCode();

  // Salva o código no banco (invalida anteriores do mesmo actor/propósito)
  await pool.query(
    'UPDATE otp_codes SET used = true WHERE actor_id = $1 AND purpose = $2 AND used = false',
    [userId, purpose]
  );
  await pool.query(
    'INSERT INTO otp_codes (actor_id, code, purpose) VALUES ($1, $2, $3)',
    [userId, code, purpose]
  );

  // Dispara pelos dois canais em paralelo
  const [emailOk, whatsappOk] = await Promise.all([
    email ? sendViaEmail(email, code) : Promise.resolve(false),
    sendViaWhatsApp(estId, whatsapp, code),
  ]);

  const channels: string[] = [];
  if (emailOk) channels.push('email');
  if (whatsappOk) channels.push('whatsapp');

  if (channels.length === 0) {
    // Nenhum canal configurado: exibe o código nos logs do servidor
    // Útil durante setup inicial antes de configurar WA e Email
    console.log(`\n====================================`);
    console.log(`🔐 OTP GERADO (sem canal configurado)`);
    console.log(`   Actor : ${userId}`);
    console.log(`   Código: ${code}`);
    console.log(`   Fins  : ${purpose}`);
    console.log(`====================================\n`);
    return { sent: true, channels: ['console'] };
  }

  return { sent: true, channels };
}

// Valida o OTP informado pelo usuário
export async function verifyOtp(userId: string, code: string, purpose: string = 'PROFILE_EDIT'): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM otp_codes
     WHERE actor_id = $1
       AND code = $2
       AND purpose = $3
       AND used = false
       AND expires_at > NOW()
     LIMIT 1`,
    [userId, code, purpose]
  );

  if (result.rows.length === 0) return false;

  await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [result.rows[0].id]);
  return true;
}