import { Pool } from 'pg';

// Número de workers do cluster (mínimo 1 para evitar divisão por zero)
const numWorkers = Math.max(1, parseInt(process.env.CLUSTER_WORKERS || '1', 10));

// Distribui as conexões entre os workers para não sobrecarregar o Postgres
// Máximo total: 50 conexões ÷ workers (mínimo 5 por worker)
const maxConnections = Math.max(5, Math.floor(50 / numWorkers));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: maxConnections,
  idleTimeoutMillis: 30000,      // fecha conexão ociosa após 30s
  connectionTimeoutMillis: 3000, // erro se não conseguir conexão em 3s
});

pool.query('SELECT NOW()', (err) => {
  if (err) console.error('❌ ERRO DE CONEXÃO COM O BANCO:', err.message);
  else console.log('✅ BANCO CONECTADO COM SUCESSO');
});

export default pool;