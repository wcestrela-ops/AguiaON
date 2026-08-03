/**
 * Cliente GPSWOX — AguiaON
 *
 * Primeira fatia da vertical de rastreamento veicular: cada empresa
 * (establishment) traz a própria conta GPSWOX (decisão: federado, não
 * compartilhado). Portado como referência a partir do gateway da Águia
 * (services/gpswox-gateway/src/clients/gpswox-api.js) — a lógica de chamada
 * à API oficial do GPSWOX é reaproveitada; o resto (multi-provider Traccar,
 * comandos, cercas, histórico, compartilhamento) fica para uma fatia futura.
 */

import pool from './db';
import { encrypt, decrypt } from './cryptoUtil';

export interface GpswoxConfig {
  url: string;
  api_hash: string;
}

export interface DeviceLocation {
  success: boolean;
  device_id: string;
  veiculo: string | null;
  latitude: number | null;
  longitude: number | null;
  endereco: string;
  velocidade: string;
  ignicao: any;
  maps_link: string | null;
  fonte: string;
  capturado_em: string;
}

// ─── Migração idempotente (mesmo padrão do smsSender.ts) ────────
let _migrated = false;
export async function ensureTables(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gpswox_configs (
      establishment_id  UUID PRIMARY KEY REFERENCES establishments(id) ON DELETE CASCADE,
      url               TEXT,
      api_hash          TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      establishment_id  UUID NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
      user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
      plate             TEXT,
      brand             TEXT,
      model             TEXT,
      color             TEXT,
      gpswox_device_id  TEXT,
      status            TEXT NOT NULL DEFAULT 'pending_installation'
                          CHECK (status IN ('pending_installation','active','inactive')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vehicles_establishment ON vehicles(establishment_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id)`);
}

// ─── Config por establishment (cache curto, mesmo padrão do waSender.ts) ──
const configCache: Record<string, { data: GpswoxConfig; ts: number }> = {};

export async function getGpswoxConfig(estId: string): Promise<GpswoxConfig> {
  await ensureTables();
  const cached = configCache[estId];
  if (cached && Date.now() - cached.ts < 30_000) return cached.data;

  const { rows } = await pool.query(`SELECT url, api_hash FROM gpswox_configs WHERE establishment_id = $1`, [estId]);
  const row = rows[0] || {};
  const data: GpswoxConfig = {
    url: (row.url || '').replace(/\/$/, ''),
    api_hash: row.api_hash ? decrypt(row.api_hash) : '',
  };
  configCache[estId] = { data, ts: Date.now() };
  return data;
}

export function invalidateGpswoxConfigCache(estId: string): void {
  delete configCache[estId];
}

export async function saveGpswoxConfig(estId: string, url: string, apiHash: string): Promise<void> {
  await ensureTables();
  await pool.query(
    `INSERT INTO gpswox_configs (establishment_id, url, api_hash, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (establishment_id) DO UPDATE SET url=$2, api_hash=$3, updated_at=NOW()`,
    [estId, url, apiHash ? encrypt(apiHash) : '']
  );
  invalidateGpswoxConfigCache(estId);
}

export function isGpswoxConfigured(cfg: GpswoxConfig): boolean {
  return Boolean(cfg.url && cfg.api_hash);
}

// ─── Chamada à API oficial do GPSWOX ────────────────────────────
async function request(estId: string, path: string, options: { method?: string; query?: Record<string, any>; body?: any } = {}): Promise<any> {
  const cfg = await getGpswoxConfig(estId);
  if (!isGpswoxConfigured(cfg)) {
    throw new Error('GPSWOX não configurado para esta empresa. Configure em Integrações → GPSWOX.');
  }

  const url = new URL(`${cfg.url}/api/${path}`);
  url.searchParams.set('user_api_hash', cfg.api_hash);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data: any = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Erro GPSWOX (${response.status})`);
  }
  if (data && data.status != null && Number(data.status) !== 1) {
    throw new Error(data?.message || data?.error || 'GPSWOX retornou status de erro.');
  }
  return data;
}

export async function listDevices(estId: string): Promise<any[]> {
  const data = await request(estId, 'get_devices');
  const items = data?.items || data?.devices || data || [];
  return Array.isArray(items) ? items : Object.values(items);
}

export async function getDeviceLocation(estId: string, deviceId: string): Promise<DeviceLocation> {
  const devices = await listDevices(estId);
  const device = devices.find((d: any) => String(d.id) === String(deviceId));
  if (!device) throw new Error(`Dispositivo ${deviceId} não encontrado no GPSWOX.`);

  const lat = parseFloat(device.lat ?? device.latitude);
  const lng = parseFloat(device.lng ?? device.longitude);

  return {
    success: true,
    device_id: device.id,
    veiculo: device.name || device.title || null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    endereco: device.address || device.last_address || 'Endereço não disponível',
    velocidade: device.speed ? `${device.speed} km/h` : '0 km/h',
    ignicao: device.engine_status ?? device.ignition ?? null,
    maps_link: Number.isFinite(lat) && Number.isFinite(lng) ? `https://maps.google.com/?q=${lat},${lng}` : null,
    fonte: 'api_oficial',
    capturado_em: new Date().toISOString(),
  };
}
