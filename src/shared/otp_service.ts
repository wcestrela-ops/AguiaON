import nodemailer from 'nodemailer';
import pool from './db';
import { decrypt } from './cryptoUtil';

// Gera código de 6 dígitos
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Lê as configurações de SMTP e Evolution diretamente do banco
async function getSettings(): Promise<Record<string, string>> {
  const result = await pool.query('SELECT key, value FROM global_settings');
  return Object.fromEntries(result.rows.map((r: any) => [r.key, r.key === 'evolution_token' ? decrypt(r.value) : r.value]));
}

// Envia via Email (SMTP configurado no admin)
async function sendViaEmail(to: string, code: string, settings: Record<string, string>): Promise<boolean> {
  try {
    if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) return false;

    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: 587,
      secure: false,
      auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    });

    await transporter.sendMail({
      from: settings.smtp_from || settings.smtp_user,
      to,
      subject: `${settings.pwa_name || 'Águia-ON'} — Código de verificação`,
      html: `
        <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;background:#020617;color:#cbd5e1;border-radius:16px">
          <h2 style="color:#6366f1;margin:0 0 16px">Código de verificação</h2>
          <p style="margin:0 0 24px">Use o código abaixo para confirmar sua ação:</p>
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:24px;text-align:center">
            <span style="font-size:36px;font-weight:900;letter-spacing:12px;color:#fff">${code}</span>
          </div>
          <p style="margin:24px 0 0;font-size:12px;color:#475569">Válido por 10 minutos. Não compartilhe este código.</p>
        </div>
      `,
    });

    return true;
  } catch (err: any) {
    console.error('❌ Falha ao enviar email OTP:', err.message);
    return false;
  }
}

// Envia via WhatsApp (Evolution API configurada no admin)
async function sendViaWhatsApp(whatsapp: string, code: string, settings: Record<string, string>): Promise<boolean> {
  try {
    if (!settings.evolution_url || !settings.evolution_token) return false;

    const appName = settings.pwa_name || 'Águia-ON';
    const message = `*${appName}* — Código de verificação:\n\n*${code}*\n\nVálido por 10 minutos. Não compartilhe este código.`;

    const instance = settings.wa_platform_instance || 'default';
    const response = await fetch(`${settings.evolution_url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': settings.evolution_token,
      },
      body: JSON.stringify({
        number: whatsapp.replace(/\D/g, ''),
        text: message,
      }),
    });

    return response.ok;
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
  purpose: string = 'PROFILE_EDIT'
): Promise<{ sent: boolean; channels: string[] }> {
  const code = generateCode();
  const settings = await getSettings();

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
    email ? sendViaEmail(email, code, settings) : Promise.resolve(false),
    sendViaWhatsApp(whatsapp, code, settings),
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