/**
 * ROTAS DO MÓDULO AGENDA — integradas no core
 * Prefixo: /agenda
 *
 * Todas as rotas exigem JWT válido com role LOJISTA ou SUPERADMIN.
 * Tenant isolation automático via user.establishmentId do JWT.
 */
import { Router, Request, Response } from 'express';
import pool from '../../shared/db';
import { requireAuth, TokenPayload } from '../../shared/authMiddleware';

const router = Router();
router.use(requireAuth);

// Helper: retorna o establishment_id do JWT (ou lança 403)
function estabId(req: Request): string {
  const user = req.user as TokenPayload;
  if (user.role === 'SUPERADMIN') {
    // GET: query param | POST/PUT/PATCH: body
    return (req.body?.establishment_id as string) || (req.query.establishment_id as string) || '';
  }
  if (!user.establishmentId) throw { status: 403, message: 'Sem estabelecimento no token.' };
  return user.establishmentId;
}

// Auto-migração das tabelas do agenda (roda na primeira chamada)
let migrated = false;
async function ensureTables() {
  if (migrated) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_profissionais (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      user_id UUID,
      nome TEXT NOT NULL,
      especialidade TEXT,
      tipo_contrato TEXT DEFAULT 'CLT',
      email TEXT, telefone TEXT, foto_url TEXT,
      comissao_percentual NUMERIC(5,2) DEFAULT 0,
      horario_trabalho JSONB DEFAULT '{}',
      ativo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_servicos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      nome TEXT NOT NULL, descricao TEXT, categoria TEXT,
      duracao_minutos INTEGER NOT NULL DEFAULT 30,
      preco NUMERIC(10,2) NOT NULL DEFAULT 0,
      comissao_percentual NUMERIC(5,2),
      ordem INTEGER DEFAULT 0,
      ativo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_agendamentos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      profissional_id UUID, servico_id UUID, user_id UUID,
      cliente_nome TEXT NOT NULL, cliente_telefone TEXT, cliente_email TEXT,
      data DATE NOT NULL, hora_inicio TIME NOT NULL, hora_fim TIME,
      status TEXT NOT NULL DEFAULT 'pendente',
      observacoes TEXT,
      valor_total NUMERIC(10,2) DEFAULT 0,
      valor_pago  NUMERIC(10,2) DEFAULT 0,
      metodo_pagamento TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_bloqueios (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL, profissional_id UUID,
      data_inicio DATE NOT NULL, data_fim DATE,
      hora_inicio TIME, hora_fim TIME,
      dia_inteiro BOOLEAN NOT NULL DEFAULT false,
      motivo TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_produtos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      nome TEXT NOT NULL, descricao TEXT, categoria TEXT,
      preco NUMERIC(10,2) NOT NULL DEFAULT 0,
      custo NUMERIC(10,2) DEFAULT 0,
      estoque INTEGER DEFAULT 0,
      estoque_minimo INTEGER DEFAULT 0,
      unidade TEXT DEFAULT 'un', imagem_url TEXT,
      ativo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_vendas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      agendamento_id UUID, profissional_id UUID, user_id UUID,
      cliente_nome TEXT,
      itens JSONB NOT NULL DEFAULT '[]',
      subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
      desconto NUMERIC(10,2) NOT NULL DEFAULT 0,
      total    NUMERIC(10,2) NOT NULL DEFAULT 0,
      comissao_calculada NUMERIC(10,2) DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      metodo_pagamento TEXT, observacoes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_avaliacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      agendamento_id UUID, profissional_id UUID, user_id UUID,
      cliente_nome TEXT,
      nota SMALLINT NOT NULL CHECK (nota BETWEEN 1 AND 5),
      comentario TEXT,
      aprovado BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_frota (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id UUID NOT NULL,
      user_id UUID, cliente_nome TEXT, cliente_telefone TEXT,
      placa TEXT, modelo TEXT, ano INTEGER, cor TEXT,
      imei_rastreador TEXT, data_instalacao DATE,
      plano_id UUID,
      status TEXT DEFAULT 'ativo',
      observacoes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Colunas extras em establishments
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS vertical_slug TEXT NOT NULL DEFAULT 'generico'`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS active_features JSONB NOT NULL DEFAULT '[]'`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS business_config JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS setup_done BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_primaria TEXT`);
  await pool.query(`ALTER TABLE establishments ADD COLUMN IF NOT EXISTS cor_destaque TEXT`);
  migrated = true;
}

// Middleware de auto-migração
router.use(async (_req, _res, next) => {
  try { await ensureTables(); next(); }
  catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════
// DASHBOARD — resumo do dia
// ═══════════════════════════════════════════════════════
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const eid = estabId(req);
    const hoje = new Date().toISOString().split('T')[0];

    const [agendHoje, agendMes, vendasHoje, profCount, servCount] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM agenda_agendamentos WHERE establishment_id=$1 AND data=$2`, [eid, hoje]),
      pool.query(`SELECT COUNT(*) FROM agenda_agendamentos WHERE establishment_id=$1 AND data_trunc('month',data::timestamptz)=date_trunc('month',NOW())`, [eid]).catch(() =>
        pool.query(`SELECT COUNT(*) FROM agenda_agendamentos WHERE establishment_id=$1 AND data >= date_trunc('month', NOW()::date)`, [eid])),
      pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM agenda_vendas WHERE establishment_id=$1 AND created_at::date=$2 AND status='pago'`, [eid, hoje]),
      pool.query(`SELECT COUNT(*) FROM agenda_profissionais WHERE establishment_id=$1 AND ativo=true`, [eid]),
      pool.query(`SELECT COUNT(*) FROM agenda_servicos WHERE establishment_id=$1 AND ativo=true`, [eid]),
    ]);

    // Próximos agendamentos do dia
    const proximos = await pool.query(
      `SELECT a.*, p.nome AS profissional_nome, s.nome AS servico_nome
       FROM agenda_agendamentos a
       LEFT JOIN agenda_profissionais p ON p.id = a.profissional_id
       LEFT JOIN agenda_servicos s ON s.id = a.servico_id
       WHERE a.establishment_id=$1 AND a.data=$2 AND a.status NOT IN ('cancelado','faltou')
       ORDER BY a.hora_inicio LIMIT 10`,
      [eid, hoje]
    );

    res.json({
      hoje:            { agendamentos: parseInt(agendHoje.rows[0].count), faturamento: parseFloat(vendasHoje.rows[0].total) },
      mes:             { agendamentos: parseInt(agendMes.rows[0].count) },
      totais:          { profissionais: parseInt(profCount.rows[0].count), servicos: parseInt(servCount.rows[0].count) },
      proximos_hoje:   proximos.rows,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// PROFISSIONAIS
// ═══════════════════════════════════════════════════════
router.get('/profissionais', async (req, res) => {
  try {
    const eid = estabId(req);
    const { ativo } = req.query;
    let q = `SELECT * FROM agenda_profissionais WHERE establishment_id=$1`;
    const p: any[] = [eid];
    if (ativo !== undefined) { q += ` AND ativo=$2`; p.push(ativo === 'true'); }
    q += ` ORDER BY nome`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/profissionais', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, especialidade, tipo_contrato, email, telefone, foto_url, comissao_percentual, horario_trabalho } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_profissionais (establishment_id,nome,especialidade,tipo_contrato,email,telefone,foto_url,comissao_percentual,horario_trabalho)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [eid, nome, especialidade||null, tipo_contrato||'CLT', email||null, telefone||null, foto_url||null,
       comissao_percentual||0, horario_trabalho ? JSON.stringify(horario_trabalho) : '{}']
    );
    res.status(201).json({ success: true, profissional: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/profissionais/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, especialidade, tipo_contrato, email, telefone, foto_url, comissao_percentual, horario_trabalho, ativo } = req.body;
    const r = await pool.query(
      `UPDATE agenda_profissionais SET nome=$1,especialidade=$2,tipo_contrato=$3,email=$4,telefone=$5,
       foto_url=$6,comissao_percentual=$7,horario_trabalho=$8,ativo=$9,updated_at=NOW()
       WHERE id=$10 AND establishment_id=$11 RETURNING *`,
      [nome, especialidade||null, tipo_contrato||'CLT', email||null, telefone||null, foto_url||null,
       comissao_percentual||0, horario_trabalho ? JSON.stringify(horario_trabalho) : '{}',
       ativo !== undefined ? ativo : true, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, profissional: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/profissionais/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_profissionais SET ativo=false,updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// SERVIÇOS
// ═══════════════════════════════════════════════════════
router.get('/servicos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { ativo, categoria } = req.query;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_servicos WHERE establishment_id=$1`;
    if (ativo !== undefined) { q += ` AND ativo=$${p.length+1}`; p.push(ativo === 'true'); }
    if (categoria) { q += ` AND categoria=$${p.length+1}`; p.push(categoria); }
    q += ` ORDER BY ordem, nome`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/servicos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, duracao_minutos, preco, comissao_percentual, ordem } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_servicos (establishment_id,nome,descricao,categoria,duracao_minutos,preco,comissao_percentual,ordem)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [eid, nome, descricao||null, categoria||null, duracao_minutos||30, preco||0, comissao_percentual||null, ordem||0]
    );
    res.status(201).json({ success: true, servico: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/servicos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, duracao_minutos, preco, comissao_percentual, ordem, ativo } = req.body;
    const r = await pool.query(
      `UPDATE agenda_servicos SET nome=$1,descricao=$2,categoria=$3,duracao_minutos=$4,preco=$5,
       comissao_percentual=$6,ordem=$7,ativo=$8,updated_at=NOW()
       WHERE id=$9 AND establishment_id=$10 RETURNING *`,
      [nome, descricao||null, categoria||null, duracao_minutos||30, preco||0,
       comissao_percentual||null, ordem||0, ativo !== undefined ? ativo : true, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, servico: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/servicos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_servicos SET ativo=false,updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// AGENDAMENTOS
// ═══════════════════════════════════════════════════════
router.get('/agendamentos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { data, profissional_id, status, limit = 100, offset = 0 } = req.query as Record<string, string>;
    const p: any[] = [eid];
    let q = `SELECT a.*, p.nome AS profissional_nome, s.nome AS servico_nome, NULL AS servico_cor
             FROM agenda_agendamentos a
             LEFT JOIN agenda_profissionais p ON p.id=a.profissional_id
             LEFT JOIN agenda_servicos s ON s.id=a.servico_id
             WHERE a.establishment_id=$1`;
    if (data)            { q += ` AND a.data=$${p.length+1}`;             p.push(data); }
    if (profissional_id) { q += ` AND a.profissional_id=$${p.length+1}`;  p.push(profissional_id); }
    if (status)          { q += ` AND a.status=$${p.length+1}`;           p.push(status); }
    q += ` ORDER BY a.data, a.hora_inicio LIMIT ${Math.min(Number(limit),500)} OFFSET ${Number(offset)}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/agendamentos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, servico_id, user_id, cliente_nome, cliente_telefone, cliente_email,
            data, hora_inicio, hora_fim, status, observacoes, valor_total } = req.body;
    if (!cliente_nome || !data || !hora_inicio) return res.status(400).json({ error: 'cliente_nome, data e hora_inicio são obrigatórios' });
    const r = await pool.query(
      `INSERT INTO agenda_agendamentos
       (establishment_id,profissional_id,servico_id,user_id,cliente_nome,cliente_telefone,cliente_email,
        data,hora_inicio,hora_fim,status,observacoes,valor_total)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [eid, profissional_id||null, servico_id||null, user_id||null,
       cliente_nome, cliente_telefone||null, cliente_email||null,
       data, hora_inicio, hora_fim||null, status||'pendente', observacoes||null, valor_total||0]
    );
    res.status(201).json({ success: true, agendamento: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/agendamentos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, servico_id, cliente_nome, cliente_telefone, cliente_email,
            data, hora_inicio, hora_fim, status, observacoes, valor_total, valor_pago, metodo_pagamento } = req.body;
    const r = await pool.query(
      `UPDATE agenda_agendamentos SET profissional_id=$1,servico_id=$2,cliente_nome=$3,
       cliente_telefone=$4,cliente_email=$5,data=$6,hora_inicio=$7,hora_fim=$8,status=$9,
       observacoes=$10,valor_total=$11,valor_pago=$12,metodo_pagamento=$13,updated_at=NOW()
       WHERE id=$14 AND establishment_id=$15 RETURNING *`,
      [profissional_id||null, servico_id||null, cliente_nome, cliente_telefone||null, cliente_email||null,
       data, hora_inicio, hora_fim||null, status, observacoes||null,
       valor_total||0, valor_pago||0, metodo_pagamento||null, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, agendamento: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Cancela (soft delete via status)
router.delete('/agendamentos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_agendamentos SET status='cancelado',updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// BLOQUEIOS
// ═══════════════════════════════════════════════════════
router.get('/bloqueios', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, data_inicio, data_fim } = req.query as Record<string, string>;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_bloqueios WHERE establishment_id=$1`;
    if (profissional_id) { q += ` AND profissional_id=$${p.length+1}`; p.push(profissional_id); }
    if (data_inicio)     { q += ` AND data_inicio>=$${p.length+1}`;    p.push(data_inicio); }
    if (data_fim)        { q += ` AND data_inicio<=$${p.length+1}`;    p.push(data_fim); }
    q += ` ORDER BY data_inicio`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/bloqueios', async (req, res) => {
  try {
    const eid = estabId(req);
    const { profissional_id, data_inicio, data_fim, hora_inicio, hora_fim, dia_inteiro, motivo } = req.body;
    if (!data_inicio) return res.status(400).json({ error: 'data_inicio é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_bloqueios (establishment_id,profissional_id,data_inicio,data_fim,hora_inicio,hora_fim,dia_inteiro,motivo)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [eid, profissional_id||null, data_inicio, data_fim||null, hora_inicio||null, hora_fim||null, dia_inteiro||false, motivo||null]
    );
    res.status(201).json({ success: true, bloqueio: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/bloqueios/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`DELETE FROM agenda_bloqueios WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// PRODUTOS
// ═══════════════════════════════════════════════════════
router.get('/produtos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { ativo, categoria } = req.query;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_produtos WHERE establishment_id=$1`;
    if (ativo !== undefined) { q += ` AND ativo=$${p.length+1}`; p.push(ativo === 'true'); }
    if (categoria)           { q += ` AND categoria=$${p.length+1}`; p.push(categoria); }
    q += ` ORDER BY nome`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/produtos', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, preco, custo, estoque, estoque_minimo, unidade, imagem_url } = req.body;
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_produtos (establishment_id,nome,descricao,categoria,preco,custo,estoque,estoque_minimo,unidade,imagem_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [eid, nome, descricao||null, categoria||null, preco||0, custo||0, estoque||0, estoque_minimo||0, unidade||'un', imagem_url||null]
    );
    res.status(201).json({ success: true, produto: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/produtos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { nome, descricao, categoria, preco, custo, estoque, estoque_minimo, unidade, imagem_url, ativo } = req.body;
    const r = await pool.query(
      `UPDATE agenda_produtos SET nome=$1,descricao=$2,categoria=$3,preco=$4,custo=$5,
       estoque=$6,estoque_minimo=$7,unidade=$8,imagem_url=$9,ativo=$10,updated_at=NOW()
       WHERE id=$11 AND establishment_id=$12 RETURNING *`,
      [nome, descricao||null, categoria||null, preco||0, custo||0,
       estoque||0, estoque_minimo||0, unidade||'un', imagem_url||null, ativo !== undefined ? ativo : true,
       req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, produto: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/produtos/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_produtos SET ativo=false,updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// VENDAS / CAIXA
// ═══════════════════════════════════════════════════════
router.get('/vendas', async (req, res) => {
  try {
    const eid = estabId(req);
    const { status, limit = 50, offset = 0 } = req.query as Record<string, string>;
    const p: any[] = [eid];
    let q = `SELECT v.*, p.nome AS profissional_nome FROM agenda_vendas v
             LEFT JOIN agenda_profissionais p ON p.id=v.profissional_id
             WHERE v.establishment_id=$1`;
    if (status) { q += ` AND v.status=$${p.length+1}`; p.push(status); }
    q += ` ORDER BY v.created_at DESC LIMIT ${Math.min(Number(limit),200)} OFFSET ${Number(offset)}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/vendas', async (req, res) => {
  try {
    const eid = estabId(req);
    const { agendamento_id, profissional_id, user_id, cliente_nome, itens, subtotal, desconto, total, metodo_pagamento, observacoes } = req.body;
    if (!total) return res.status(400).json({ error: 'total é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_vendas (establishment_id,agendamento_id,profissional_id,user_id,cliente_nome,itens,subtotal,desconto,total,metodo_pagamento,observacoes,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pago') RETURNING *`,
      [eid, agendamento_id||null, profissional_id||null, user_id||null, cliente_nome||null,
       JSON.stringify(itens||[]), subtotal||total, desconto||0, total, metodo_pagamento||null, observacoes||null]
    );
    res.status(201).json({ success: true, venda: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/vendas/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { status, metodo_pagamento, observacoes } = req.body;
    const r = await pool.query(
      `UPDATE agenda_vendas SET status=$1,metodo_pagamento=$2,observacoes=$3,updated_at=NOW()
       WHERE id=$4 AND establishment_id=$5 RETURNING *`,
      [status, metodo_pagamento||null, observacoes||null, req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, venda: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// AVALIAÇÕES
// ═══════════════════════════════════════════════════════
router.get('/avaliacoes', async (req, res) => {
  try {
    const eid = estabId(req);
    const { aprovado } = req.query;
    const p: any[] = [eid];
    let q = `SELECT a.*, p.nome AS profissional_nome FROM agenda_avaliacoes a
             LEFT JOIN agenda_profissionais p ON p.id=a.profissional_id
             WHERE a.establishment_id=$1`;
    if (aprovado !== undefined) { q += ` AND a.aprovado=$${p.length+1}`; p.push(aprovado === 'true'); }
    q += ` ORDER BY a.created_at DESC`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/avaliacoes', async (req, res) => {
  try {
    const eid = estabId(req);
    const { agendamento_id, profissional_id, user_id, cliente_nome, nota, comentario } = req.body;
    if (!nota) return res.status(400).json({ error: 'nota é obrigatório' });
    const r = await pool.query(
      `INSERT INTO agenda_avaliacoes (establishment_id,agendamento_id,profissional_id,user_id,cliente_nome,nota,comentario)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [eid, agendamento_id||null, profissional_id||null, user_id||null, cliente_nome||null, nota, comentario||null]
    );
    res.status(201).json({ success: true, avaliacao: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Aprovar/reprovar avaliação
router.patch('/avaliacoes/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { aprovado } = req.body;
    await pool.query(`UPDATE agenda_avaliacoes SET aprovado=$1 WHERE id=$2 AND establishment_id=$3`, [aprovado, req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// FROTA (nicho Rastreamento)
// ═══════════════════════════════════════════════════════
router.get('/frota', async (req, res) => {
  try {
    const eid = estabId(req);
    const { status } = req.query;
    const p: any[] = [eid];
    let q = `SELECT * FROM agenda_frota WHERE establishment_id=$1`;
    if (status) { q += ` AND status=$${p.length+1}`; p.push(status); }
    q += ` ORDER BY cliente_nome, placa`;
    res.json((await pool.query(q, p)).rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/frota', async (req, res) => {
  try {
    const eid = estabId(req);
    const { cliente_nome, cliente_telefone, placa, modelo, ano, cor, imei_rastreador, data_instalacao, plano_id, status, observacoes } = req.body;
    const r = await pool.query(
      `INSERT INTO agenda_frota (establishment_id,cliente_nome,cliente_telefone,placa,modelo,ano,cor,imei_rastreador,data_instalacao,plano_id,status,observacoes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [eid, cliente_nome||null, cliente_telefone||null, placa||null, modelo||null, ano||null, cor||null,
       imei_rastreador||null, data_instalacao||null, plano_id||null, status||'ativo', observacoes||null]
    );
    res.status(201).json({ success: true, veiculo: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/frota/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    const { cliente_nome, cliente_telefone, placa, modelo, ano, cor, imei_rastreador, data_instalacao, plano_id, status, observacoes } = req.body;
    const r = await pool.query(
      `UPDATE agenda_frota SET cliente_nome=$1,cliente_telefone=$2,placa=$3,modelo=$4,ano=$5,cor=$6,
       imei_rastreador=$7,data_instalacao=$8,plano_id=$9,status=$10,observacoes=$11,updated_at=NOW()
       WHERE id=$12 AND establishment_id=$13 RETURNING *`,
      [cliente_nome||null, cliente_telefone||null, placa||null, modelo||null, ano||null, cor||null,
       imei_rastreador||null, data_instalacao||null, plano_id||null, status||'ativo', observacoes||null,
       req.params.id, eid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true, veiculo: r.rows[0] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/frota/:id', async (req, res) => {
  try {
    const eid = estabId(req);
    await pool.query(`UPDATE agenda_frota SET status='inativo',updated_at=NOW() WHERE id=$1 AND establishment_id=$2`, [req.params.id, eid]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;