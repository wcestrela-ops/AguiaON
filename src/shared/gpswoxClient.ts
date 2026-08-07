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

// Fix de produção 44 — a API do GPSWOX pagina as respostas de lista: o
// formato real (confirmado pelo log de produção do Fix 43) não é um array
// direto em `data.items`, e sim um envelope de paginação, algo como
// `{ items: { data: [...5 dispositivos...], total: 5, current_page: 1, ... } }`.
// A extração antiga (`data?.items || data?.devices || data`) pegava esse
// ENVELOPE inteiro; como não é array, caía em `Object.values(envelope)`, que
// devolve `[ [...5 dispositivos...], 5, 1, ... ]` — ou seja, o array de
// verdade vira um ÚNICO item dentro do resultado (junto com os números da
// paginação soltos), por isso `listDevices()` reportava "1 dispositivo" com
// 5 cadastrados de verdade no GPSWOX. Essa função agora desce um nível a
// mais nos formatos mais comuns antes de desistir e usar Object.values.
function extractGpswoxArray(data: any, keys: string[] = ['items', 'devices', 'data']): any[] {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    const v = data?.[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      if (Array.isArray(v.data)) return v.data;
      if (Array.isArray(v.items)) return v.items;
    }
  }
  // Último recurso (formato desconhecido) — mantém o comportamento antigo
  // como fallback, mas só chega aqui se nada acima bateu.
  return data && typeof data === 'object' ? Object.values(data) : [];
}

export async function listDevices(estId: string): Promise<any[]> {
  const data = await request(estId, 'get_devices');
  return extractGpswoxArray(data, ['items', 'devices', 'data']);
}

// Fix de produção 42 — cria um dispositivo do lado do GPSWOX a partir de um
// veículo cadastrado aqui (mão contrária do "puxar" feito em listDevices).
// Payload ('add_device' com name/imei/plate) portado do gateway do Águia
// Auto (services/gpswox-gateway/src/clients/gpswox-api.js +
// services/api/src/services/installer-service.js) — diferente do restante
// deste arquivo (geofences/sharing, ainda não confirmados ao vivo), essa
// chamada É a mesma usada em produção pelo sistema antigo pra criar veículo
// direto na plataforma GPSWOX, então o formato do payload já está validado.
export async function createDevice(estId: string, params: { name: string; imei: string; plate?: string | null }): Promise<{ id: string | null; raw: any }> {
  const raw = await request(estId, 'add_device', {
    method: 'POST',
    body: { name: params.name, imei: params.imei, plate: params.plate || undefined },
  });
  const id = raw?.item?.id ?? raw?.id ?? raw?.data?.id ?? null;
  return { id: id != null ? String(id) : null, raw };
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

// ─── Fase 8 — comandos, histórico, compartilhamento, cercas ────
// Portado de services/gpswox-gateway/src/clients/gpswox-api.js (Águia Auto).
// Mesmo helper request() acima — a API oficial do GPSWOX é idêntica nos dois
// projetos. Payloads de sharing/geofence seguem o formato documentado da API
// GPSWOX; como este ambiente não tem acesso a uma conta GPSWOX real pra
// testar ao vivo, vale validar a resposta exata (nomes de campo) com uma
// conta de teste antes de confiar 100% em produção.

export interface CommandResult {
  success: boolean;
  raw: any;
}

/** Envia um comando genérico ao dispositivo (mesmo endpoint usado por bloquear/desbloquear). */
export async function sendCommand(estId: string, deviceId: string, type: string): Promise<CommandResult> {
  const raw = await request(estId, 'send_command', { method: 'POST', body: { device_id: deviceId, type } });
  return { success: true, raw };
}

export async function blockDevice(estId: string, deviceId: string): Promise<CommandResult> {
  return sendCommand(estId, deviceId, 'engine_stop');
}

export async function unblockDevice(estId: string, deviceId: string): Promise<CommandResult> {
  return sendCommand(estId, deviceId, 'engine_resume');
}

export interface HistoryPoint {
  latitude: number | null;
  longitude: number | null;
  velocidade: string;
  endereco: string | null;
  capturado_em: string | null;
  maps_link: string | null;
}

/** Histórico de trajeto do dispositivo entre duas datas (formato ISO ou 'YYYY-MM-DD HH:mm:ss', conforme a API GPSWOX exigir). */
export async function getHistory(estId: string, deviceId: string, from: string, to: string): Promise<HistoryPoint[]> {
  const data = await request(estId, 'get_history', { query: { device_id: deviceId, from, to } });
  const list = extractGpswoxArray(data, ['items', 'messages', 'data']);

  return list.map((p: any) => {
    const lat = parseFloat(p.lat ?? p.latitude);
    const lng = parseFloat(p.lng ?? p.longitude);
    return {
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      velocidade: p.speed ? `${p.speed} km/h` : '0 km/h',
      endereco: p.address || null,
      capturado_em: p.dt_tracker || p.date || p.datetime || null,
      maps_link: Number.isFinite(lat) && Number.isFinite(lng) ? `https://maps.google.com/?q=${lat},${lng}` : null,
    };
  });
}

export interface SharingResult {
  link: string | null;
  raw: any;
}

/** Gera um link temporário de compartilhamento de localização (API "sharing" do GPSWOX). */
export async function createSharing(estId: string, deviceId: string, durationMinutes: number): Promise<SharingResult> {
  const raw = await request(estId, 'sharing', {
    method: 'POST',
    body: {
      devices: [Number(deviceId)],
      expiration_by: 'duration',
      expiration_duration: durationMinutes,
      delete_after_expiration: true,
    },
  });
  // O nome exato do campo de retorno varia por versão do GPSWOX — tenta os mais comuns;
  // se só vier o hash, devolve como aviso (precisa confirmar o formato do link com uma
  // conta GPSWOX real antes de expor isso pronto pro cliente final).
  const directLink = raw?.url || raw?.link || raw?.data?.url || raw?.data?.link || null;
  const hash = raw?.hash || raw?.data?.hash || raw?.items?.hash || null;
  return { link: directLink || (hash ? `hash=${hash} (confirme o formato do link com o painel GPSWOX)` : null), raw };
}

export interface Geofence {
  id: string | number;
  nome: string;
  raw: any;
}

export async function listGeofences(estId: string): Promise<Geofence[]> {
  const data = await request(estId, 'get_geofences');
  const list = extractGpswoxArray(data, ['items', 'data']);
  return list.map((g: any) => ({ id: g.id, nome: g.name || g.title || `Cerca ${g.id}`, raw: g }));
}

/** Cria uma cerca circular simples (centro + raio) — o tipo mais direto de configurar sem UI de desenho de mapa. */
export async function addGeofence(estId: string, params: { nome: string; latitude: number; longitude: number; raioMetros: number; deviceId?: string }): Promise<any> {
  return request(estId, 'add_geofence', {
    method: 'POST',
    body: {
      name: params.nome,
      type: 'circle',
      center: `${params.latitude},${params.longitude}`,
      radius: params.raioMetros,
      devices: params.deviceId ? [Number(params.deviceId)] : undefined,
    },
  });
}

export async function deleteGeofence(estId: string, geofenceId: string | number): Promise<void> {
  await request(estId, 'destroy_geofence', { query: { geofence_id: geofenceId } });
}

// ─── Failover 4G→SMS pros comandos ──────────────────────────────
// Portado de services/api/src/lib/gps-failover.js (Águia Auto). Função pura
// (sem I/O), decide se um erro do GPSWOX justifica tentar o comando de novo
// via SMS — erros "de rede/gateway" sim, erros "lógicos" (duplicado, comando
// desconhecido, já aceito) não, porque trocar de canal não resolveria.
const FAILOVER_ERROR_PATTERNS = [
  'fetch failed', 'econnrefused', 'enotfound', 'network', 'gateway',
  'offline', 'indispon', '503', '502', '504', 'requer api_hash',
  'timeout', 'aborterror', 'socket hang up', 'failed to fetch',
];
const NO_FAILOVER_ERROR_PATTERNS = ['duplic', 'unknown', 'aceito', 'accepted', 'external'];

export function isGpsFailoverEligible(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase();
  if (!message) return false;
  if (NO_FAILOVER_ERROR_PATTERNS.some(p => message.includes(p))) return false;
  return FAILOVER_ERROR_PATTERNS.some(p => message.includes(p));
}
