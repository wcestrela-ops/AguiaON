import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function askAgata(prompt: string) {
  // 1. Busca qual IA está ativa no SuperAdmin
  const config = await pool.query('SELECT * FROM ai_providers WHERE is_active = true LIMIT 1');
  
  if (config.rows.length === 0) throw new Error("Nenhum provedor de IA configurado no Admin.");

  const { provider_name, api_key, api_url, model_name } = config.rows[0];

  // 2. Lógica Flexível (Exemplo para Groq/OpenAI que usam o mesmo formato)
  if (provider_name === 'openai' || provider_name === 'groq' || provider_name === 'local') {
    const response = await fetch(`${api_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model_name,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    return data.choices[0].message.content;
  }

  // 3. Lógica para Gemini (Google)
  if (provider_name === 'gemini') {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model_name}:generateContent?key=${api_key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }
}
