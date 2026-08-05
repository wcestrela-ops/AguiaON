import cluster from 'cluster';
import os from 'os';
import http from 'http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { startOrderTimeoutJob } from './shared/orderTimeout';
import { startDailyReportJob } from './shared/dailyReport';
import { startLgpdJobs } from './shared/lgpdJobs';
import { startGymExpiryJob } from './shared/gymExpiryJob';
import { startBillingJob } from './shared/billingJob';
import { startTrackingBillingJob } from './shared/trackingBillingJob';
import { initIO, emitToStore } from './shared/socketio';
import { syncActiveFeatures } from './verticals/blueprints';
import { setupPrimary } from '@socket.io/cluster-adapter';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import actionRoutes from './routes/actions';
import clientRoutes from './routes/client';
import lojistaRoutes from './routes/lojista';
import publicRoutes from './routes/public';
import landingRoutes, { resolveVerticalLanding, resolveServicoUnicoRedirect } from './routes/landings';
import paymentRoutes from './routes/payments';
import agendaRoutes from './routes/agenda/index';
import webhookRoutes from './routes/webhooks';
import catalogRoutes from './routes/catalog';
import deliveryRoutes from './routes/delivery';
import gymClientsRoutes from './routes/gymClients';
import chatRoutes from './routes/chat';
import adminSmsRoutes from './routes/adminSms';
// import vehicleRoutes from './routes/vehicles'; // desativado — ver nota junto do app.use('/veiculos', ...) mais abaixo
import billingRoutes from './routes/billing';
import pool from './shared/db';
import { tenantHostContext } from './shared/tenantResolver';

dotenv.config();

// ── Cluster Mode ─────────────────────────────────────────────
// Em produção, faz fork de 1 worker por CPU disponível.
// Cada worker é um processo Node independente com seu próprio pool de DB.
// O processo primário apenas gerencia os workers (sem tráfego HTTP).
if (cluster.isPrimary && process.env.NODE_ENV === 'production') {
  const numCPUs = os.cpus().length;
  // Passa o total de workers como variável de ambiente para que o pool
  // de cada worker distribua as conexões corretamente (ver db.ts)
  process.env.CLUSTER_WORKERS = String(numCPUs);

  // Configura IPC do cluster adapter para replicar eventos Socket.io entre workers
  setupPrimary();
  console.log(`[cluster] primário iniciado — forking ${numCPUs} workers`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ CLUSTER_WORKERS: String(numCPUs) });
  }

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`[cluster] worker ${worker.process.pid} encerrou (code=${code}, signal=${signal}) — reiniciando`);
    cluster.fork({ CLUSTER_WORKERS: String(numCPUs) });
  });

  // Processo primário encerra aqui — não sobe o Express
} else {

const app = express();

// Confia em proxies (Cloudflare, Nginx, Docker, etc.) para o rate-limit funcionar corretamente
app.set('trust proxy', 1);

// ── Health checks (Fase 6) ────────────────────────────────────
// Ficam antes de qualquer outro middleware (inclusive o redirect HTTPS) para
// que orquestradores (Docker, Kubernetes, load balancer) consigam checar sem
// TLS e sem depender de nenhuma dependência externa estar de pé.
// /health/live  — o processo está de pé (não checa dependências externas)
// /health/ready — pronto pra receber tráfego (checa conexão com o banco)
app.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/health/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (err: any) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

// ── Força HTTPS em produção ──────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
      next();
    }
  });
}

app.use(helmet({
  contentSecurityPolicy: false, // HTML inline usa Tailwind CDN e scripts inline — CSP estrita quebraria o frontend
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
  credentials: true
}));
app.use(cookieParser());

// White-label (Fase 4): resolve req.tenant a partir do header Host — subdomínio
// próprio (slug.PLATFORM_BASE_DOMAIN) ou domínio customizado (establishments.custom_domain)
app.use(tenantHostContext);

// Webhook MP: aceita qualquer body antes do express.json() para evitar rejeição de body vazio
app.use('/api/payments/webhook/mercadopago', express.text({ type: '*/*' }), (req: any, _res: any, next: any) => {
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
  }
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
});

// Webhook Evolution pode enviar mídia em base64 — limite maior nessa rota
app.use('/webhooks/evolution', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '10mb' }));
// Service Worker precisa do header Service-Worker-Allowed para controlar "/"
app.get('/sw.js', (_req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, '../public/sw.js'));
});

// Favicon global dinâmico (salvo no banco pelo superadmin)
app.get('/favicon.ico', async (_req, res) => {
  try {
    const { default: pool } = await import('./shared/db');
    const r = await pool.query(`SELECT value FROM global_settings WHERE key = 'site_favicon' LIMIT 1`);
    if (r.rows.length && r.rows[0].value) {
      const raw = r.rows[0].value.replace(/^data:image\/[^;]+;base64,/, '');
      const buf = Buffer.from(raw, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(buf);
    }
  } catch {}
  // Fallback: arquivo estático se existir
  const fallback = path.join(__dirname, '../public/icons/favicon.png');
  if (require('fs').existsSync(fallback)) return res.sendFile(fallback);
  // Retorna favicon mínimo transparente para evitar 404 no browser
  const minIco = Buffer.from(
    'AAABAAEAAQEAAAEAGAAoAAAAFgAAACgAAAABAAAAAgAAAAEAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAA==', 'base64');
  res.setHeader('Content-Type', 'image/x-icon');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(minIco);
});

app.use(express.static(path.join(__dirname, '../public')));

// Rotas do Core
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/actions', actionRoutes);
app.use('/client', clientRoutes);
app.use('/lojista', lojistaRoutes);
app.use('/public', publicRoutes);
// Rotas próprias já vêm com o caminho completo embutido (/public/landing/...
// e /admin/landings/...), então monta sem prefixo — ver src/routes/landings.ts.
app.use(landingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/auth/mercadopago', paymentRoutes); // alias compatível com URL cadastrada no MP
app.use('/agenda', agendaRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/delivery', deliveryRoutes);
app.use('/gym', gymClientsRoutes);
app.use('/chat', chatRoutes);
app.use('/admin/sms', adminSmsRoutes);
// /veiculos (vehicles.ts) — desativado (Fase 15, revisão de arquitetura).
// Foi a primeira fatia da Fase 2 (tabela `vehicles` própria, com GPSWOX
// linkado direto ali). Nenhuma tela do projeto (loja.html, portal.html,
// vitrine.html) chama essas rotas hoje — foi totalmente superado por
// `agenda_frota` (src/routes/agenda/index.ts), que ganhou o mesmo link de
// GPSWOX nas migrations v21/v22 e é o que move Frota/Clientes/Cobrança na
// loja e o Rastreamento no portal. Comparado com o Águia Auto (sistema
// antigo validado em produção) — que usava uma tabela única de veículos e
// financeiro no nível do cliente, não do veículo — `agenda_frota` é quem
// segue esse padrão, não `vehicles`. Rota comentada (não removida) por
// cautela: o Carlos não tem certeza se algo externo (app, teste manual)
// ainda bate em /veiculos — se depois de um tempo ninguém sentir falta,
// dá pra apagar `src/routes/vehicles.ts` e a tabela `vehicles` de vez.
// app.use('/veiculos', vehicleRoutes);
app.use('/admin/billing', billingRoutes);

// ── Rota de teste Socket.io ───────────────────────────────────
// GET /api/test-print/:store_id — dispara evento new_order fake (requer ADMIN_SECRET_KEY)
app.get('/api/test-print/:store_id', (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  next();
}, (_req, res) => {
  const { store_id } = _req.params;
  const fakeOrder = {
    id: 'test-' + Date.now(),
    order_number: 9999,
    daily_code: 'teste 1',
    customer_name: 'Cliente Teste',
    customer_phone: '5511999999999',
    customer_address: 'Rua Teste, 123',
    delivery_type: 'delivery',
    items: [{ name: 'Produto Teste', quantity: 1, price: 29.90, added_by_store: false }],
    subtotal: 29.90,
    delivery_tax: 5.00,
    discount: 0,
    total: 34.90,
    payment_method: 'pix',
    notes: 'Pedido de teste via Socket.io',
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  emitToStore(store_id, 'new_order', fakeOrder);
  res.json({ ok: true, message: `Evento new_order emitido para store:${store_id}`, order: fakeOrder });
});

// Raiz → loja do tenant resolvido por host (white-label), landing de módulo
// resolvida por subdomínio (Fase 16, ex: rastreamento.aguiaon.com), ou
// Marketplace da plataforma.
app.get('/', async (req, res) => {
  if (req.tenant) return res.sendFile(path.join(__dirname, '../public/vitrine.html'));
  const landing = await resolveVerticalLanding(req);
  if (landing) return res.sendFile(path.join(__dirname, '../public/landing.html'));
  res.redirect(301, '/marketplace');
});

// Landing page institucional
app.get('/sobre', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Login unificado
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Política de Privacidade & Termos de Uso (pública — LGPD)
app.get('/privacidade', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/privacidade.html'));
});

// Página de cadastro de parceiro (lojista)
app.get('/parceiro', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/parceiro.html'));
});

// Portal do cliente final (requer login)
app.get('/portal', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/portal.html'));
});

// Chat WhatsApp interno do lojista
app.get('/chat', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/chat.html'));
});

// Painel do SuperAdmin
app.get('/admin-panel', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Marketplace público
app.get('/marketplace', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/marketplace.html'));
});

// Página do Carrinho / Finalização de Checkout
app.get('/checkout', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/checkout.html'));
});

// Painel do Lojista (dashboard unificado por nicho)
app.get('/loja', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/loja.html'));
});

// Página do Entregador (login por celular, ver e atualizar pedidos de entrega)
app.get('/entregador', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/entregador.html'));
});

// Página do Garçom (login por celular, PDV + mesas + pedidos)
app.get('/garcom', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/garcom.html'));
});

// Página da Mesa (público — cliente escaneia QR code)
app.get('/mesa', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/mesa.html'));
});

// Rastreamento de pedido (público)
app.get('/pedido/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/track.html'));
});
app.get('/track/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/track.html'));
});

app.get('/portal-cliente', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/portal-cliente.html'));
});

// Perfil da Loja (URL Amigável :slug)
// Esta rota deve vir DEPOIS de todas as rotas fixas para não interceptar /login, /loja, etc.
app.get('/:slug', async (req, res, next) => {
  // Ignora se for um arquivo (tem ponto no nome)
  if (req.params.slug.includes('.')) return next();
  // Landing de módulo por caminho (Fase 16, ex: aguiaon.com/rastreamento) —
  // só disputa esse espaço se não bater com nenhuma loja real (resolveVerticalLanding
  // já ignora quando req.tenant existe, e o PUT /admin/landings recusa
  // domain_value que colida com establishments.slug).
  const landing = await resolveVerticalLanding(req);
  if (landing) return res.sendFile(path.join(__dirname, '../public/landing.html'));
  // Fix de produção 26 — loja de módulo "serviço único" (ex: Águia Gestão
  // Veicular / Rastreamento): não é multi-empresa, então a vitrine fica sem
  // função. Se já existe landing publicada pra essa vertical, redireciona a
  // URL antiga da loja pra lá, deixando só uma URL pública no ar
  // (aguiaon.com/rastreamento em vez de + aguiaon.com/aguia-gestao-veicular).
  const redirectUrl = await resolveServicoUnicoRedirect(req.params.slug);
  if (redirectUrl) return res.redirect(301, redirectUrl);
  res.sendFile(path.join(__dirname, '../public/vitrine.html')); // Nova página de Vitrine
});

const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);
initIO(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[worker ${process.pid}] rodando na porta ${PORT}`);
  // Só um worker roda jobs periódicos para não duplicar no cluster. Esse app
  // clusteriza com o módulo nativo `cluster` do Node (cluster.fork() acima),
  // não com PM2 — então NÃO existem as env vars NODE_APP_INSTANCE/pm_id que a
  // condição antiga checava (essas só existem sob PM2). Isso fazia a condição
  // abaixo dar sempre falso em produção, e nenhum job periódico rodava de
  // verdade (incluindo syncActiveFeatures, cobrança diária, vencimento de
  // gym etc.) — só não tinha sintoma óbvio porque a maior parte desses jobs
  // são "silenciosos" quando não têm nada pra fazer. O jeito certo de saber
  // "sou o primeiro worker" com o módulo nativo é `cluster.worker.id === 1`
  // (undefined fora de cluster, ex. dev local — nesse caso roda direto).
  if (!cluster.worker || cluster.worker.id === 1) {
    startOrderTimeoutJob();
    startDailyReportJob();
    startLgpdJobs();
    startGymExpiryJob();
    startBillingJob();
    startTrackingBillingJob();
    // Ressincroniza active_features de toda empresa com os blueprints atuais —
    // roda uma vez a cada boot (idempotente), não é um job periódico.
    syncActiveFeatures(pool).catch(err => console.error('[server] falha ao ressincronizar active_features:', err.message));
  }
});

// ── Encerramento gracioso (Fase 6) ────────────────────────────
// Docker/Kubernetes mandam SIGTERM antes de matar o processo. Sem isso, o
// worker morre no meio de requisições em andamento e conexões de banco ficam
// penduradas. Fecha o servidor HTTP (para de aceitar conexão nova, espera as
// em andamento) e só depois fecha o pool do Postgres.
function gracefulShutdown(signal: string): void {
  console.log(`[worker ${process.pid}] recebido ${signal} — encerrando graciosamente...`);
  httpServer.close(() => {
    pool.end()
      .catch((err: any) => console.error('[shutdown] erro ao fechar pool:', err.message))
      .finally(() => process.exit(0));
  });
  // Failsafe: força saída se não encerrar em 10s (ex: conexão HTTP travada)
  setTimeout(() => {
    console.warn(`[worker ${process.pid}] encerramento forçado após timeout`);
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

} // fim do bloco else (worker)
