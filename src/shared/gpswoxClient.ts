/**
 * Cliente GPSWOX — AguiaON
 *
 * Primeira fatia da vertical de rastreamento veicular: cada empresa
 * (establishment) traz a própria conta GPSWOX (decisão: federado, não
 * compartilhado).
 *
 * Fix de produção 48 — referência principal agora é a documentação OFICIAL
 * da API (https://gpswox.stoplight.io/docs/tracking-software/...), que o
 * Carlos encontrou e compartilhou. Ela corrige DUAS regressões introduzidas
 * no Fix 46 (que tinha se baseado no handoff do projeto irmão ag-on-track,
 * uma fonte não-oficial que descreveu mal esses dois pontos):
 *   1. `GET /api/get_devices` é **GET** (com filtros por query string), não
 *      POST. O Fix 46 mudou pra POST com corpo vazio — isso não quebrava a
 *      chamada (GPSWOX ignora o método?), mas não era a causa raiz de nada;
 *      a causa raiz real do "devices_recebidos=1" (Fix 47) era a resposta
 *      vir como lista de GRUPOS com `.items`, não lista de dispositivos.
 *   2. Criar dispositivo é `POST /api/add_device`, não `edit_device` com
 *      `action=create`. E `user_id` é OPCIONAL (array de inteiros) no
 *      corpo — não um campo obrigatório — então toda a lógica de "descobrir
 *      o gpswoxUserId de algum dispositivo existente antes de criar" era
 *      resolvendo um problema que não existe.
 * `send_gprs_command` (comandos) e a estrutura de grupos/items de
 * `get_devices` já estavam corretos e continuam iguais.
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
// Fix de produção 46 — o Carlos trouxe o handoff de um projeto irmão
// (ag-on-track) que documenta a API dessa MESMA conta GPSWOX
// (painel.aguiarastreamento.com) já validada em produção. Duas diferenças
// confirmadas em relação ao que a gente tinha: (1) todas as chamadas
// documentadas incluem `lang=en` na query, junto com `user_api_hash`; (2)
// `get_devices`/`get_history` são POST, não GET (o `request()` aqui
// defaultava pra GET quando nenhum `method` era passado, que é exatamente o
// caso de `listDevices()` antes deste fix — bem provável causa raiz de
// `devices_recebidos=1` do Fix 45).
async function request(estId: string, path: string, options: { method?: string; query?: Record<string, any>; body?: any } = {}): Promise<any> {
  const cfg = await getGpswoxConfig(estId);
  if (!isGpswoxConfigured(cfg)) {
    throw new Error('GPSWOX não configurado para esta empresa. Configure em Integrações → GPSWOX.');
  }

  const url = new URL(`${cfg.url}/api/${path}`);
  url.searchParams.set('user_api_hash', cfg.api_hash);
  url.searchParams.set('lang', 'en');
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

// Fix de produção 47 — o log de produção finalmente mostrou a resposta real
// de get_devices (POST já estava certo desde o Fix 46): não é uma lista de
// dispositivos nem o envelope de paginação que eu tinha suposto no Fix 44 —
// é uma lista de GRUPOS: `[{ id: 0, title: "Ungrouped", items: [
// ...dispositivos de verdade... ] }]`. A extração de antes via que a
// resposta já era um array e devolvia ela mesma sem entrar nos grupos — ou
// seja, cada "dispositivo" processado era na verdade um GRUPO inteiro (essa
// conta só tem 1 grupo, "Ungrouped", com os 5 dispositivos reais dentro do
// `items` dele — por isso `devices_recebidos` sempre dava 1). Agora achata
// os `items` de cada grupo antes de processar.
function extractGpswoxDeviceList(data: any): any[] {
  if (Array.isArray(data) && data.length && data.every((g: any) => g && typeof g === 'object' && Array.isArray(g.items))) {
    return data.flatMap((g: any) => g.items);
  }
  return extractGpswoxArray(data, ['items', 'devices', 'data']);
}

export async function listDevices(estId: string): Promise<any[]> {
  // Fix de produção 48 — confirmado pela documentação oficial: get_devices é
  // GET, não POST (o Fix 46 tinha mudado pra POST com base no handoff não-
  // oficial do ag-on-track). `request()` sem `method` explícito já usa GET.
  const data = await request(estId, 'get_devices');
  console.log(`[gpswoxClient.listDevices] resposta crua do GPSWOX: ${JSON.stringify(data).slice(0, 6000)}`);
  const devices = extractGpswoxDeviceList(data);
  // Log extra (Fix 47) — mostra as chaves de nível superior do primeiro
  // dispositivo (e de device_data, se existir), pra confirmar rapidinho
  // onde o imei/user_id realmente estão nessa resposta sem precisar ler o
  // JSON gigante acima.
  if (devices[0]) {
    console.log(`[gpswoxClient.listDevices] devices_extraidos=${devices.length} chaves_do_primeiro=${Object.keys(devices[0]).join(',')} chaves_device_data=${devices[0].device_data ? Object.keys(devices[0].device_data).join(',') : '(sem device_data)'}`);
  }
  return devices;
}

// Fix de produção 46 (confirmado pelo Fix 48 contra a documentação oficial
// — endpoint "List Edit Device Data" mostra o objeto completo do
// dispositivo com `imei`, `sim_number`, `user_id`, `plate_number` como
// campos diretos): dentro de `get_devices`, cada item vem com esses mesmos
// campos ANINHADOS em `device_data`. Ex: `{ id, name, lat, lng, device_data:
// { imei, sim_number, plate_number, user_id, ... } }`. Ler `device.imei`
// direto sempre batia em `undefined` — por isso "0 corresponde por IMEI"
// mesmo com os IMEIs certos cadastrados dos dois lados. Mantém fallback pro
// campo direto, caso alguma versão da API devolva plano mesmo.
export function extractDeviceImei(device: any): string | null {
  const raw = device?.device_data?.imei ?? device?.imei ?? device?.uniqueId ?? device?.unique_id ?? null;
  return raw ? String(raw).trim() : null;
}

export function extractDeviceSimNumber(device: any): string | null {
  const raw = device?.device_data?.sim_number ?? device?.sim_number ?? device?.sim ?? device?.phone ?? device?.sim_phone ?? device?.msisdn ?? device?.tracker_phone ?? null;
  return raw ? String(raw).replace(/\D/g, '') || null : null;
}

/** ID numérico do usuário/cliente GPSWOX dono do dispositivo (device_data.user_id) — necessário pra criar dispositivo novo via edit_device. */
export function extractDeviceGpswoxUserId(device: any): string | null {
  const raw = device?.device_data?.user_id ?? null;
  return raw != null ? String(raw) : null;
}

// Fix de produção 48 — corrigido contra a documentação oficial ("Create a
// Add Device", POST /api/add_device): o endpoint certo pra criar
// dispositivo é `add_device` (o Fix 46 tinha trocado pra `edit_device` com
// `action: 'create'`, baseado no handoff não-oficial do ag-on-track — não
// bate com a API real). Só `name` e `imei` são obrigatórios; `user_id` é
// OPCIONAL (array de inteiros) — por isso agora é opcional aqui também, e
// a rota que chama essa função não precisa mais descobrir um
// `gpswoxUserId` antes de criar. `plate_number` também é aceito direto
// pelo endpoint, então é enviado quando disponível.
export async function createDevice(estId: string, params: { name: string; imei: string; userId?: string; plateNumber?: string }): Promise<{ id: string | null; raw: any }> {
  const body: Record<string, any> = { name: params.name, imei: params.imei };
  if (params.userId) body.user_id = [Number(params.userId)];
  if (params.plateNumber) body.plate_number = params.plateNumber;
  const raw = await request(estId, 'add_device', { method: 'POST', body });
  const id = raw?.id ?? raw?.item?.id ?? raw?.data?.id ?? null;
  return { id: id != null ? String(id) : null, raw };
}

// Fix de produção 51 — o Carlos percebeu que vincular/desvincular um cliente
// de um veículo que JÁ tem dispositivo no GPSWOX só atualizava o cadastro
// local; o dono do dispositivo lá continuava o de antes (ou nenhum). Esta
// função edita só o(s) campo(s) passado(s) — confirmado contra a doc oficial
// (POST /api/edit_device): "no update no field is strictly required", então
// dá pra mandar só `user_id` sem mexer em mais nada do dispositivo.
// `userId: null` limpa o dono (array vazio) — usado no desvincular.
export async function editDevice(estId: string, deviceId: string, params: { userId?: string | null; name?: string; plateNumber?: string }): Promise<{ raw: any }> {
  const body: Record<string, any> = {};
  if (params.userId !== undefined) body.user_id = params.userId ? [Number(params.userId)] : [];
  if (params.name) body.name = params.name;
  if (params.plateNumber) body.plate_number = params.plateNumber;
  const raw = await request(estId, 'edit_device', { method: 'POST', query: { device_id: deviceId }, body });
  return { raw };
}

// Fix de produção 50 — cria o "client" (usuário final) no GPSWOX
// automaticamente quando um cliente é cadastrado na AguiaON, do mesmo jeito
// que já acontece com o Asaas (best-effort, não bloqueia o cadastro local se
// falhar). Confirmado contra a documentação oficial (POST /api/admin/client):
// só `email` é aceito como identificador — não existe campo de nome nesse
// endpoint. `password_generate: true` deixa o GPSWOX gerar a senha sozinho
// (a AguiaON não expõe login GPSWOX pro cliente final ainda, então não tem
// senha nossa pra reaproveitar). `account_created: false` e
// `email_verification: false` evitam mandar e-mail de boas-vindas do GPSWOX
// pro cliente (ele não sabe que essa conta existe) e evitam travar a criação
// esperando confirmação. `group_id: 2` = "User" (grupo de usuário final, não
// administrador — ver tabela de group_id na doc oficial: 1-Admin, 2-User,
// 3-Manager, 4-Demo, 5-Operator, 6-Supervisor).
export async function createClient(estId: string, params: { email: string; phoneNumber?: string }): Promise<{ id: string | null; raw: any }> {
  const body: Record<string, any> = {
    email: params.email,
    active: true,
    group_id: 2,
    password_generate: true,
    account_created: false,
    email_verification: false,
  };
  if (params.phoneNumber) body.phone_number = params.phoneNumber;
  const raw = await request(estId, 'admin/client', { method: 'POST', body });
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
// Fix de produção 48 — `get_geofences` confirmado contra a documentação
// oficial: GET, resposta no formato `{ items: { geofences: [...] } }`
// (um nível a mais do que os outros endpoints de lista — não é
// `items: [...]` direto). `add_geofence`/`destroy_geofence` ainda não têm
// página própria confirmada nos docs oficiais, mas seguem o mesmo padrão de
// nomenclatura `get_X`/`add_X`/`destroy_X` visto em Device (`get_devices`,
// `add_device`, e "Get a Destroy Device" que é GET) — mantidos como estão.

export interface CommandResult {
  success: boolean;
  raw: any;
}

/** Envia um comando genérico ao dispositivo (mesmo endpoint usado por bloquear/desbloquear). */
// Fix de produção 46 — endpoint corrigido pra `send_gprs_command`, conforme
// o handoff do ag-on-track (era `send_command`, um palpite do Águia Auto
// que não bate com o que está documentado pra essa conta).
export async function sendCommand(estId: string, deviceId: string, type: string): Promise<CommandResult> {
  const raw = await request(estId, 'send_gprs_command', { method: 'POST', body: { device_id: deviceId, type } });
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
// Fix de produção 48 — revertido pra GET com query string. O Fix 46 tinha
// mudado pra POST com base no handoff não-oficial do ag-on-track; a
// documentação oficial confirma que todo endpoint com prefixo `get_`
// checado até agora (get_devices, get_geofences, edit_device_data) é GET
// com parâmetros na query string, então esse é o padrão mais confiável até
// confirmar `get_history` especificamente.
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
  // Formato oficial confirmado: { items: { geofences: [...] } } — um nível
  // aninhado a mais que o extractGpswoxArray genérico cobre, então checa
  // esse caminho específico antes de cair no fallback genérico.
  const nested = data?.items?.geofences;
  const list = Array.isArray(nested) ? nested : extractGpswoxArray(data, ['items', 'data']);
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
