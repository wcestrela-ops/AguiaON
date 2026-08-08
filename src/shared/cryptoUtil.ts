import crypto from 'crypto';

const RAW_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-prod';
// Usa SHA-256 para garantir que a chave tenha sempre 32 bytes, independente do tamanho da ENCRYPTION_KEY.
const ENCRYPTION_KEY = crypto.createHash('sha256').update(String(RAW_KEY)).digest('base64').substring(0, 32);
const IV_LENGTH = 16;

/**
 * Criptografa um texto usando AES-256-CBC com um IV aleatório.
 * O formato de saída é "iv:texto_criptografado" em hexadecimal.
 * @param text O texto plano para criptografar.
 * @returns A string criptografada.
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Descriptografa uma string.
 * Suporta o novo formato ("iv:texto_criptografado") e o formato legado (apenas hexadecimal).
 * @param encrypted O texto criptografado.
 * @returns O texto plano descriptografado, ou a string original se a descriptografia falhar.
 */
export function decrypt(encrypted: string): string {
  if (!encrypted) return '';
  try {
    // Novo formato com IV
    const parts = encrypted.split(':');
    const ivHex = parts.shift();
    if (!ivHex) return encrypted;

    const iv = Buffer.from(ivHex, 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return encrypted;
  }
}

/**
 * Verifica se o nome de uma chave de configuração sugere que ela contém um valor sensível.
 * @param key O nome da chave (ex: 'api_key', 'smtp_secret').
 * @returns True se a chave provavelmente contém um valor sensível.
 */
export function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return lowerKey.includes('key') || lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('pass');
}