// Fix de produção 20 — utilitário compartilhado de e-mail via SMTP.
//
// Antes disso, `enviarCopiaTermoPorEmail` (o envio automático depois do
// aceite do Termo de Adesão) vivia só dentro de src/routes/landings.ts. O
// Carlos pediu um botão de "reenviar por e-mail" também na tela de Clientes
// (src/routes/agenda/index.ts) — em vez de copiar/colar a mesma leitura de
// SMTP + criação de transporter + template de e-mail num segundo arquivo (e
// arriscar os dois divergirem com o tempo), essa lógica foi extraída pra cá,
// e os dois arquivos passam a chamar as mesmas funções.
import nodemailer from 'nodemailer';
import pool from './db';
import { decrypt, isSensitiveKey } from './cryptoUtil';

// Fix de produção 33 — causa raiz real do "SMTP funciona no teste mas o
// e-mail não sai": `admin.ts` (POST /admin/settings/update) criptografa
// QUALQUER chave que pareça sensível (`isSensitiveKey` — contém "key",
// "secret", "token" ou "pass"), o que inclui `smtp_pass`. Essa função lia o
// valor cru do banco sem descriptografar, então `sendEmail()` tentava
// autenticar no SMTP usando o texto CRIPTOGRAFADO como se fosse a senha —
// falha de autenticação (ou, se a linha nunca foi salva, fica vazio e cai no
// aviso "SMTP não configurado"). O botão "Testar" em Configurações Globais
// nunca pegava esse bug porque ele testa com o valor DIGITADO na tela (em
// texto puro), nunca o que está de fato salvo no banco — por isso o teste
// sempre passava mesmo com o envio real quebrado.
export async function getSmtpSettings(): Promise<Record<string, string>> {
  const r = await pool.query(
    `SELECT key, value FROM global_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','pwa_name')`
  );
  return Object.fromEntries(r.rows.map((row: any) => [row.key, isSensitiveKey(row.key) ? decrypt(row.value) : row.value]));
}

// Best-effort: nunca lança — quem chama só decide o que fazer com o
// resultado (ex: registrar "email_termo_enviado" ou não), sem precisar de
// try/catch próprio.
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const settings = await getSmtpSettings();
    if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
      console.warn('[mailer] envio pulado — SMTP não configurado em Configurações Globais.');
      return false;
    }

    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: parseInt(settings.smtp_port || '587'),
      secure: false,
      auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    });

    await transporter.sendMail({
      from: settings.smtp_from || settings.smtp_user,
      to,
      subject,
      html,
    });
    return true;
  } catch (err: any) {
    console.error('[mailer] falha ao enviar e-mail:', err.message);
    return false;
  }
}

// Template do Termo de Adesão — usado tanto no envio automático (depois do
// aceite, em landings.ts) quanto no reenvio manual (a partir do cadastro do
// cliente já convertido, em agenda/index.ts).
export function buildTermoAdesaoEmailHtml(nome: string, moduloLabel: string, contratoTexto: string): string {
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#020617;color:#cbd5e1;border-radius:16px">
      <h2 style="color:#6366f1;margin:0 0 8px">Termo de Adesão</h2>
      <p style="margin:0 0 20px;color:#94a3b8">Olá, <strong style="color:#fff">${nome}</strong>! Aqui está a cópia do termo de adesão que você aceitou pra ${moduloLabel}.</p>
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:20px;white-space:pre-wrap;font-size:12px;color:#cbd5e1">${contratoTexto}</div>
      <p style="margin:24px 0 0;font-size:11px;color:#475569">Guarde este e-mail — ele é o comprovante do seu aceite eletrônico.</p>
    </div>
  `;
}
