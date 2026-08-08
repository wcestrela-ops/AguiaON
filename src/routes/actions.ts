import { Router } from 'express';
import pool from '../shared/db';
import { requireAuth } from '../shared/authMiddleware';
import { loadAIConfig, askAI, type AIMessage } from '../shared/aiProvider';

const router = Router();
router.use(requireAuth);

// ─── Helpers de memória ───────────────────────────────────────────────────────

async function getMemory(userId: string, establishmentId: string | null) {
  try {
    const existing = await pool.query(
      `SELECT * FROM ai_memory WHERE user_id = $1 AND establishment_id IS NOT DISTINCT FROM $2 LIMIT 1`,
      [userId, establishmentId]
    );
    if (existing.rows.length) return existing.rows[0];

    const created = await pool.query(
      `INSERT INTO ai_memory (user_id, establishment_id, messages, context_json)
       VALUES ($1, $2, '[]', '{}') RETURNING *`,
      [userId, establishmentId]
    );
    return created.rows[0];
  } catch {
    // Tabela pode não existir — retorna memória vazia sem bloquear
    return { id: null, messages: [], summary: null, context_json: {} };
  }
}

async function appendMessages(memoryId: string, userMsg: string, agataMsg: string, current: any[]) {
  if (!memoryId) return;
  const MAX = 30;
  const updated = [
    ...current,
    { role: 'user',  content: userMsg,  ts: new Date().toISOString() },
    { role: 'agata', content: agataMsg, ts: new Date().toISOString() },
  ].slice(-MAX);

  try {
    await pool.query(
      `UPDATE ai_memory SET messages = $1, last_interaction = NOW() WHERE id = $2`,
      [JSON.stringify(updated), memoryId]
    );
  } catch { /* não bloqueia */ }
  return updated;
}

async function refreshSummaryAsync(memoryId: string, messages: any[], existingSummary: string) {
  if (!memoryId || messages.length < 4) return;

  try {
    const cfg = await loadAIConfig();
    const transcript = messages.slice(-20)
      .map((m: any) => `${m.role === 'user' ? 'Cliente' : 'Ágatha'}: ${m.content}`)
      .join('\n');

    const prompt: AIMessage[] = [
      {
        role: 'system',
        content: 'Você é um assistente de CRM. Produza um resumo conciso (máximo 3 frases) com os pontos mais importantes da conversa: preferências do cliente, decisões tomadas e informações relevantes para atendimentos futuros. Use terceira pessoa ao se referir ao cliente.',
      },
      {
        role: 'user',
        content: `Resumo anterior: ${existingSummary || 'Nenhum ainda.'}\n\nConversa recente:\n${transcript}\n\nNovo resumo:`,
      },
    ];

    const { response } = await askAI(cfg, prompt, 200);
    if (response) {
      await pool.query(`UPDATE ai_memory SET summary = $1 WHERE id = $2`, [response, memoryId]);
    }
  } catch { /* não bloqueia */ }
}

// ─────────────────────────────────────────────────────────────
// POST /actions/ask — Chat com Ágatha (memória + fallback chain)
// ─────────────────────────────────────────────────────────────
router.post('/ask', async (req, res) => {
  const user = (req as any).user;
  const { prompt, establishment_id } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt obrigatório.' });

  const userId = user.userId || user.id;
  // Usa o establishment_id do body; fallback para o do JWT (clientes autenticados via portal)
  const estId  = establishment_id || user.establishmentId || null;

  // ── 1. Carrega config de IA (obrigatório) ─────────────────────
  let cfg;
  try {
    cfg = await loadAIConfig();
  } catch (err: any) {
    console.error('[actions/ask] loadAIConfig falhou:', err.message);
    return res.status(503).json({
      response: 'Não foi possível conectar ao serviço de IA. Verifique as configurações no painel Admin.',
      provider: 'none',
    });
  }

  // ── 2. Carrega dados auxiliares com fallbacks individuais ──────
  const [personalityRes, estRes, memory] = await Promise.allSettled([
    pool.query(`SELECT name, mood, forbidden_topics FROM agata_personality LIMIT 1`),
    estId
      ? pool.query(`SELECT name, vertical_slug, business_config, settings FROM establishments WHERE id = $1`, [estId])
      : Promise.resolve({ rows: [] as any[] }),
    getMemory(userId, estId),
  ]);

  const p   = personalityRes.status === 'fulfilled' ? (personalityRes.value.rows[0] || {}) : {};
  const est = estRes.status === 'fulfilled' ? (estRes.value.rows[0] || null) : null;
  const mem = memory.status === 'fulfilled' ? memory.value : { id: null, messages: [], summary: null };

  const bc = est?.business_config || {};

  // ── 3. Monta system prompt ────────────────────────────────────
  const nicheKnowledge = bc.agata_knowledge || est?.settings?.ai?.knowledge || '';
  const nicheMood      = bc.agata_mood      || est?.settings?.ai?.prompt    || '';
  const estName        = est?.name          || 'nossa empresa';

  const memoryCtx = mem.summary
    ? `\n\nMEMÓRIA DESTE CLIENTE:\n${mem.summary}`
    : '';

  const recentCtx = ((mem.messages as any[]) || []).slice(-6)
    .map((m: any) => `${m.role === 'user' ? 'Cliente' : 'Ágatha'}: ${m.content}`)
    .join('\n');

  const messages: AIMessage[] = [
    {
      role: 'system',
      content: `Você é a Ágatha, assistente virtual de ${estName}.
Personalidade: ${nicheMood || p.mood || 'Prestativa e amigável.'}.
${p.forbidden_topics ? `Não fale sobre: ${p.forbidden_topics}.` : ''}
${nicheKnowledge ? `Contexto do negócio: ${nicheKnowledge}` : ''}
Responda de forma curta, objetiva e natural. Nunca saia do personagem.${memoryCtx}${recentCtx ? `\n\nCONTEXTO DA CONVERSA:\n${recentCtx}` : ''}`,
    },
    { role: 'user', content: prompt },
  ];

  // ── 4. Chama IA ────────────────────────────────────────────────
  try {
    const { response, provider } = await askAI(cfg, messages);

    if (!response) {
      console.warn('[actions/ask] Todos os provedores retornaram vazio. Config:', {
        primary: cfg.primary,
        hasGroq: !!cfg.groqKey,
        hasOpenAI: !!cfg.openaiKey,
        hasGemini: !!cfg.geminiKey,
        hasLocal: !!cfg.localUrl,
        hasAnthropic: !!cfg.anthropicKey,
      });
      return res.json({
        response: 'Desculpe, não consigo responder agora. Nenhum provedor de IA está disponível. Verifique as chaves de API no painel Admin.',
        provider: 'none',
      });
    }

    res.json({ response, provider, has_memory: !!mem.summary });

    // Persiste em background sem bloquear a resposta
    if (mem.id) {
      appendMessages(mem.id, prompt, response, mem.messages || [])
        .then(updated => updated && refreshSummaryAsync(mem.id, updated, mem.summary || ''))
        .catch(() => {});
    }

  } catch (err: any) {
    console.error('[actions/ask] askAI lançou exceção:', err.message);
    res.status(500).json({
      error: 'Erro interno ao consultar IA.',
      response: 'Ocorreu um erro inesperado. Por favor, tente novamente.',
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /actions/memory — Histórico do usuário para o portal
// ─────────────────────────────────────────────────────────────
router.get('/memory', async (req, res) => {
  const user = (req as any).user;
  const establishmentId = (req.query.establishment_id as string) || null;

  try {
    const result = await pool.query(
      `SELECT summary, messages, context_json, last_interaction
       FROM ai_memory
       WHERE user_id = $1 AND establishment_id IS NOT DISTINCT FROM $2 LIMIT 1`,
      [user.userId || user.id, establishmentId]
    );

    if (!result.rows.length) return res.json({ summary: null, messages: [], context_json: {} });

    const mem = result.rows[0];
    res.json({
      summary:          mem.summary,
      messages:         (mem.messages || []).slice(-20),
      context_json:     mem.context_json,
      last_interaction: mem.last_interaction,
    });
  } catch (err: any) {
    // Tabela pode não existir ainda
    res.json({ summary: null, messages: [], context_json: {} });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /actions/memory — Apaga memória do usuário
// ─────────────────────────────────────────────────────────────
router.delete('/memory', async (req, res) => {
  const user = (req as any).user;
  const establishmentId = (req.query.establishment_id as string) || null;

  try {
    await pool.query(
      `UPDATE ai_memory SET summary = NULL, messages = '[]', context_json = '{}'
       WHERE user_id = $1 AND establishment_id IS NOT DISTINCT FROM $2`,
      [user.userId || user.id, establishmentId]
    );
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // silencia se tabela não existir
  }
});

// ─────────────────────────────────────────────────────────────
// POST /actions/execute — Ferramentas da IA
// ─────────────────────────────────────────────────────────────
router.post('/execute', async (req, res) => {
  const { tool, params } = req.body;

  try {
    const toolCheck = await pool.query('SELECT * FROM ai_tools WHERE name = $1 AND is_active = true', [tool]);
    if (!toolCheck.rows.length) return res.status(403).json({ error: 'Ação não permitida ou desativada' });

    let result: any;
    switch (tool) {
      case 'create_appointment':
        result = { success: true, message: 'Agendamento simulado com sucesso' };
        break;
      default:
        return res.status(404).json({ error: 'Lógica da ferramenta não implementada' });
    }

    await pool.query(
      'INSERT INTO ai_action_logs (tool_name, params, status, response_data) VALUES ($1, $2, $3, $4)',
      [tool, params, 'SUCCESS', result]
    );

    res.json(result);
  } catch {
    res.status(500).json({ error: 'Erro ao executar ação da IA' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /actions/status — Diagnóstico do estado da IA (admin)
// ─────────────────────────────────────────────────────────────
router.get('/status', async (_req, res) => {
  try {
    const cfg = await loadAIConfig();
    res.json({
      primary:      cfg.primary,
      providers: {
        local:     { configured: !!cfg.localUrl,     url: cfg.localUrl || null },
        gemini:    { configured: !!cfg.geminiKey },
        groq:      { configured: !!cfg.groqKey,      model: cfg.groqModel },
        openai:    { configured: !!cfg.openaiKey,    model: cfg.openaiModel },
        anthropic: { configured: !!cfg.anthropicKey },
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
