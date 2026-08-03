import { Pool } from 'pg';

// Número de workers do cluster (mínimo 1 para evitar divisão por zero)
const numWorkers = Math.max(1, parseInt(process.env.CLUSTER_WORKERS || '1', 10));

// Distribui as conexões entre os workers para não sobrecarregar o Postgres
// Máximo total: 50 conexões ÷ workers (mínimo 5 por worker)
const maxConnections = Math.max(5, Math.floor(50 / numWorkers));

// ── Detecção de SSL ──────────────────────────────────────────
// A heurística antiga (SSL sempre que o host não é "localhost") quebra em
// redes internas Docker/EasyPanel — o Postgres ali não fala SSL, mas o host
// da connection string não é literalmente "localhost" (é algo como
// "aguiaon_postgres"), então a lib tentava negociar SSL e a conexão falhava.
// Agora dá pra ser explícito com ?sslmode=disable (ou =require) na
// DATABASE_URL; sem isso, mantém o comportamento antigo como fallback.
const dbUrl = process.env.DATABASE_URL || '';
const sslModeMatch = dbUrl.match(/[?&]sslmode=([a-z]+)/i);
const explicitSslMode = sslModeMatch ? sslModeMatch[1].toLowerCase() : null;

const sslOption: false | { rejectUnauthorized: boolean } =
  explicitSslMode === 'disable' ? false
  : explicitSslMode ? { rejectUnauthorized: false }
  : dbUrl.includes('localhost') ? false
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOption,
  max: maxConnections,
  idleTimeoutMillis: 30000,      // fecha conexão ociosa após 30s
  connectionTimeoutMillis: 3000, // erro se não conseguir conexão em 3s
});

pool.query('SELECT NOW()', (err) => {
  if (err) console.error('❌ ERRO DE CONEXÃO COM O BANCO:', err.message);
  else console.log('✅ BANCO CONECTADO COM SUCESSO');
});

export default pool;