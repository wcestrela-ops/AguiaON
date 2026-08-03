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
import { initIO, emitToStore } from './shared/socketio';
import { setupPrimary } from '@socket.io/cluster-adapter';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import actionRoutes from './routes/actions';
import clientRoutes from './routes/client';
import lojistaRoutes from './routes/lojista';
import publicRoutes from './routes/public';
import paymentRoutes from './routes/payments';
import agendaRoutes from './routes/agenda/index';
import webhookRoutes from './routes/webhooks';
import catalogRoutes from './routes/catalog';
import deliveryRoutes from './routes/delivery';
import gymClientsRoutes from './routes/gymClients';
import chatRoutes from './routes/chat';
import adminSmsRoutes from './routes/adminSms';

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
app.use('/api/payments', paymentRoutes);
app.use('/api/auth/mercadopago', paymentRoutes); // alias compatível com URL cadastrada no MP
app.use('/agenda', agendaRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/delivery', deliveryRoutes);
app.use('/gym', gymClientsRoutes);
app.use('/chat', chatRoutes);
app.use('/admin/sms', adminSmsRoutes);

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

// Raiz → redireciona para o Marketplace
app.get('/', (_req, res) => {
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
app.get('/:slug', (req, res, next) => {
  // Ignora se for um arquivo (tem ponto no nome)
  if (req.params.slug.includes('.')) return next();
  res.sendFile(path.join(__dirname, '../public/vitrine.html')); // Nova página de Vitrine
});

const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);
initIO(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[worker ${process.pid}] rodando na porta ${PORT}`);
  // Só o worker 0 roda jobs periódicos para não duplicar no cluster
  if (!process.env.CLUSTER_WORKERS || process.env.NODE_APP_INSTANCE === '0' || process.env.pm_id === '0') {
    startOrderTimeoutJob();
    startDailyReportJob();
    startLgpdJobs();
    startGymExpiryJob();
  }
});

} // fim do bloco else (worker)
