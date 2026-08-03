/**
 * AG-ON AI Provider — Motor de IA unificado com fallback automático
 *
 * Ordem de prioridade (configurável via global_settings.ai_primary_provider):
 *   local (Ollama) → gemini → groq → openai → anthropic
 *
 * As chaves são lidas e descriptografadas direto do banco.
 */

import pool from './db';
import { decrypt, isSensitiveKey } from './cryptoUtil';
import { anonymizeMessages } from './anonymizer';

// ── Tipos ────────────────────────────────────────────────────
export type AIProvider = 'local' | 'gemini' | 'groq' | 'openai' | 'anthropic';

export interface AIConfig {
  primary:      AIProvider;
  localUrl:     string;
  localModel:   string;
  geminiKey:    string;
  groqKey:      string;
  groqModel:    string;
  openaiKey:    string;
  openaiModel:  string;
  anthropicKey: string;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIResult {
  response: string;
  provider: AIProvider | 'none';
}

// ── Carrega configurações do banco ───────────────────────────
export async function loadAIConfig(): Promise<AIConfig> {
  const KEYS = [
    'ai_primary_provider',
    'ai_local_url', 'ai_local_model',
    'ai_gemini_key',
    'ai_groq_key', 'ai_groq_model',
    'ai_openai_key', 'ai_openai_model',
    'ai_atmos_key',
  ];

  const result = await pool.query(
    `SELECT key, value FROM global_settings WHERE key = ANY($1)`,
    [KEYS]
  );

  const m: Record<string, string> = {};
  result.rows.forEach(r => {
    const val = isSensitiveKey(r.key) ? decrypt(r.value) : r.value;
    // Sanidade: se o valor descriptografado ainda parece um ciphertext (iv:hex),
    // a ENCRYPTION_KEY provavelmente está diferente da que criptografou o valor.
    if (isSensitiveKey(r.key) && /^[0-9a-f]{32}:[0-9a-f]+$/i.test(val)) {
      console.error(`🔐 [loadAIConfig] Chave "${r.key}" não pôde ser descriptografada — verifique a variável ENCRYPTION_KEY no servidor.`);
      m[r.key] = ''; // trata como não configurada
    } else {
      m[r.key] = val;
    }
  });

  const cfg: AIConfig = {
    primary:      (m.ai_primary_provider as AIProvider) || 'groq',
    localUrl:     m.ai_local_url    || '',
    localModel:   m.ai_local_model  || 'llama3',
    geminiKey:    m.ai_gemini_key   || '',
    groqKey:      m.ai_groq_key     || '',
    groqModel:    m.ai_groq_model   || 'llama-3.1-8b-instant',
    openaiKey:    m.ai_openai_key   || '',
    openaiModel:  m.ai_openai_model || 'gpt-4o-mini',
    anthropicKey: m.ai_atmos_key    || '',
  };

  // Log de diagnóstico (sem expor as chaves)
  console.log(`[loadAIConfig] primary=${cfg.primary} | groq=${!!cfg.groqKey} | openai=${!!cfg.openaiKey} | gemini=${!!cfg.geminiKey} | anthropic=${!!cfg.anthropicKey} | local=${!!cfg.localUrl}`);

  return cfg;
}

// ── Implementações dos provedores ────────────────────────────

async function callLocal(url: string, model: string, messages: AIMessage[], maxTokens: number): Promise<string> {
  const base = url.replace(/\/$/, '');
  // Ollama native API
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { num_predict: maxTokens } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json() as any;
  return data.message?.content || '';
}

async function callGemini(apiKey: string, messages: AIMessage[], maxTokens: number): Promise<string> {
  const text = messages
    .map(m => `${m.role === 'system' ? '[Sistema]' : m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
    .join('\n\n');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
      }),
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  if (data.error) throw new Error(`Gemini API error: ${JSON.stringify(data.error).slice(0, 200)}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGroq(apiKey: string, model: string, messages: AIMessage[], maxTokens: number): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'llama3-8b-8192', messages, max_tokens: maxTokens, temperature: 0.7 }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Groq HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

async function callOpenAI(apiKey: string, model: string, messages: AIMessage[], maxTokens: number): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, max_tokens: maxTokens, temperature: 0.7 }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(apiKey: string, messages: AIMessage[], maxTokens: number): Promise<string> {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const userMsgs  = messages.filter(m => m.role !== 'system');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system:     systemMsg,
      messages:   userMsgs,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  return data.content?.[0]?.text || '';
}

// ── Ordem de fallback ─────────────────────────────────────────
function providerOrder(primary: AIProvider): AIProvider[] {
  const all: AIProvider[] = ['local', 'gemini', 'groq', 'openai', 'anthropic'];
  return [primary, ...all.filter(p => p !== primary)];
}

function hasCredential(provider: AIProvider, cfg: AIConfig): boolean {
  switch (provider) {
    case 'local':     return !!cfg.localUrl;
    case 'gemini':    return !!cfg.geminiKey;
    case 'groq':      return !!cfg.groqKey;
    case 'openai':    return !!cfg.openaiKey;
    case 'anthropic': return !!cfg.anthropicKey;
  }
}

// ── Função principal ──────────────────────────────────────────
export async function askAI(
  cfg: AIConfig,
  messages: AIMessage[],
  maxTokens = 400
): Promise<AIResult> {
  // ── Blindagem obrigatória: anonimiza ANTES de enviar a qualquer IA ──
  let shieldedMessages = messages;
  try {
    const { cleanMessages, keyMap } = anonymizeMessages(messages);
    shieldedMessages = cleanMessages as AIMessage[];
    if (Object.keys(keyMap).length > 0) {
      console.log(`🛡️  DataShield: ${Object.keys(keyMap).length} dado(s) sensível(eis) anonimizado(s).`);
    }
  } catch (shieldErr: any) {
    // Nunca bloqueia a IA por falha no anonymizer — loga e continua com mensagens originais
    console.error(`⚠️ DataShield falhou (usando mensagens originais): ${shieldErr.message}`);
  }

  const order = providerOrder(cfg.primary);

  for (const provider of order) {
    if (!hasCredential(provider, cfg)) continue;

    try {
      let response = '';
      switch (provider) {
        case 'local':
          response = await callLocal(cfg.localUrl, cfg.localModel, shieldedMessages, maxTokens);
          break;
        case 'gemini':
          response = await callGemini(cfg.geminiKey, shieldedMessages, maxTokens);
          break;
        case 'groq':
          response = await callGroq(cfg.groqKey, cfg.groqModel, shieldedMessages, maxTokens);
          break;
        case 'openai':
          response = await callOpenAI(cfg.openaiKey, cfg.openaiModel, shieldedMessages, maxTokens);
          break;
        case 'anthropic':
          response = await callAnthropic(cfg.anthropicKey, shieldedMessages, maxTokens);
          break;
      }
      if (response.trim()) {
        console.log(`✅ AI respondeu via [${provider}]`);
        return { response: response.trim(), provider };
      }
    } catch (err: any) {
      console.warn(`⚠️ AI provider [${provider}] falhou: ${err.message} — tentando próximo...`);
    }
  }

  return { response: '', provider: 'none' };
}
