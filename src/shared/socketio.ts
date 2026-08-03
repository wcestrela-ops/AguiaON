import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/cluster-adapter';
import type { Server as HttpServer } from 'http';
import pool from './db';

let _io: Server | null = null;

/**
 * Inicializa o Socket.io atachado ao HTTP server.
 * Deve ser chamado UMA vez em server.ts, antes de app.listen().
 *
 * ── Problema de cluster ──────────────────────────────────────
 * Em modo cluster (produção), cada worker Node tem seu próprio
 * processo e sua própria instância de _io em memória.
 * Se o socket do app de impressão conectar no worker A e o pedido
 * for criado no worker B, o emit do worker B nunca alcança o socket.
 *
 * Solução: @socket.io/cluster-adapter usa IPC nativo do Node
 * para replicar eventos entre workers SEM precisar de Redis.
 * ─────────────────────────────────────────────────────────────
 */
export function initIO(httpServer: HttpServer): Server {
  _io = new Server(httpServer, {
    cors:          { origin: '*', methods: ['GET', 'POST'] },
    transports:    ['websocket'],
    pingTimeout:   60000,
    pingInterval:  25000,
    upgradeTimeout: 10000,
  });

  // ── Cluster adapter (IPC entre workers) ──────────────────────
  // Só funciona quando este processo foi criado via cluster.fork() — nesse
  // caso existe um canal IPC (process.send) com o primário. Rodando
  // standalone (dev local via ts-node-dev, ou produção sem NODE_ENV=production
  // — logo sem clustering) process.send não existe e o adapter derruba o
  // processo ao tentar publicar. Achado durante o smoke test da Fase 6:
  // isso quebrava qualquer subida fora do modo cluster, incluindo dev local
  // e um possível deploy single-instance.
  if (typeof process.send === 'function') {
    _io.adapter(createAdapter());
    console.log(`[socket.io] cluster adapter ativo (worker ${process.pid})`);
  } else {
    console.log(`[socket.io] rodando standalone (sem cluster) — adapter de IPC desativado`);
  }

  // ── Middleware de autenticação ────────────────────────────────
  // O cliente envia: io(URL, { query: { store_token: '...' } })
  _io.use(async (socket: Socket, next) => {
    const token = socket.handshake.query.store_token as string | undefined;
    if (!token) {
      console.warn(`[socket.io] conexão recusada — store_token ausente (${socket.id})`);
      return next(new Error('store_token obrigatório'));
    }

    try {
      const r = await pool.query(
        `SELECT id FROM establishments WHERE store_token = $1 AND is_active = true LIMIT 1`,
        [token]
      );

      if (!r.rows.length) {
        console.warn(`[socket.io] token inválido ou loja inativa: ${token.slice(0, 8)}…`);
        return next(new Error('Token inválido ou loja inativa'));
      }

      const establishmentId: string = r.rows[0].id;
      (socket as any).establishmentId = establishmentId;

      console.log(`[socket.io] auth OK — loja ${establishmentId} (worker ${process.pid})`);
      next();
    } catch (err: any) {
      console.error(`[socket.io] erro de autenticação: ${err.message}`);
      next(new Error('Erro interno de autenticação'));
    }
  });

  // ── Gerenciamento de salas ────────────────────────────────────
  _io.on('connection', (socket: Socket) => {
    const estId: string = (socket as any).establishmentId;
    const room = `store:${estId}`;

    socket.join(room);
    console.log(`[socket.io] conectado — sala ${room} | socket ${socket.id} | worker ${process.pid}`);

    socket.on('disconnect', (reason) => {
      console.log(`[socket.io] desconectado — sala ${room} | socket ${socket.id} | motivo: ${reason}`);
    });
  });

  console.log(`[socket.io] servidor inicializado (worker ${process.pid})`);
  return _io;
}

/**
 * Emite um evento para todos os clientes de uma loja.
 * Com o cluster adapter, o evento é replicado para todos os workers via IPC.
 *
 * O campo daily_code já vem do banco no formato "seg 9" e é incluído
 * automaticamente no objeto do pedido — o agon-printer o usa diretamente.
 */
export function emitToStore(establishmentId: string, event: string, data: unknown): void {
  if (!_io) {
    console.warn(`[socket.io] emitToStore chamado antes de initIO — evento '${event}' descartado`);
    return;
  }
  const room = `store:${establishmentId}`;
  console.log(`[socket.io] emitindo '${event}' → ${room} (worker ${process.pid})`);
  _io.to(room).emit(event, data);
}
