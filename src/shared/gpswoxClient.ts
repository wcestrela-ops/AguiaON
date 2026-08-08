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
  // Fix de produção 67
  ultima_atualizacao: string | null;
  online: boolean | null;
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
async function request(estId: string, path: string, options: { method?: string; query?: Record<string, any>; body?: any; multipart?: boolean } = {}): Promise<any> {
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

  // Fix de produção 54 — a doc oficial confirma que send_gprs_command (e
  // provavelmente send_sms_command) exige `multipart/form-data`, não JSON —
  // diferente da maioria dos outros endpoints POST daqui, que aceitam JSON
  // numa boa. Campos array (ex.: `device_id`) viram `campo[]` repetido, como
  // um form HTML de verdade manda.
  let fetchBody: any;
  const headers: Record<string, string> = {};
  if (options.multipart && options.body != null) {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.body)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) form.append(`${key}[]`, String(item));
      } else {
        form.append(key, String(value));
      }
    }
    fetchBody = form;
  } else if (options.body != null) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: fetchBody,
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

// Fix de produção 67 — Carlos pediu pra mostrar, no painel de Frota e no
// modal de localização, a última vez que o dispositivo se comunicou com o
// GPSWOX e se está online/offline. A doc oficial do get_devices não tem uma
// página confirmada com o schema exato desse campo (tentei achar de novo,
// o workspace do Stoplight que usamos nas fixes anteriores está retornando
// "Project not found" agora) — então, mesmo padrão de tentativa multi-campo
// já usado em extractDeviceImei/extractDeviceSimNumber acima: tenta os
// nomes mais prováveis (baseado em como outras plataformas de rastreamento
// costumam nomear isso) e cai pra null se nenhum bater. O log em
// listDevices() já mostra as chaves de nível superior do dispositivo — se
// isso vier errado, o próximo log de produção mostra o nome certo do campo
// pra corrigir (mesmo processo que resolveu imei/sim_number nos Fix 46-48).
export function extractDeviceLastUpdate(device: any): Date | null {
  const raw =
    device?.time ?? device?.gps_time ?? device?.server_time ?? device?.loc_valid_from ??
    device?.last_valid_gps_time ?? device?.device_data?.time ?? device?.updated_at ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Online = teve posição reportada nos últimos 15 minutos (limiar comum em plataformas de rastreamento; sem campo explícito "online" confirmado na doc). */
const ONLINE_THRESHOLD_MINUTES = 15;
export function isDeviceOnline(lastUpdate: Date | null): boolean | null {
  if (!lastUpdate) return null;
  return (Date.now() - lastUpdate.getTime()) <= ONLINE_THRESHOLD_MINUTES * 60 * 1000;
}

// Fix de produção 53 — o campo real, confirmado contra a resposta de exemplo
// da doc oficial (get_devices_latest), é `device_data.pivot.user_id` — um
// nível mais fundo do que o Fix 46 tinha assumido (`device_data.user_id`
// direto, que nunca existiu de verdade nessa resposta). Essa função nunca
// encontrava nada — sempre devolvia null — desde que foi escrita; por isso o
// "dono detectado" no envio de veículos (Fix 42/48) e a sincronização de
// clientes (Fix 52) nunca tinham dado certo de verdade. Mantém o fallback
// pro campo direto por segurança, caso alguma versão/endpoint diferente do
// GPSWOX devolva achatado.
/** ID numérico do cliente GPSWOX dono do dispositivo (o "principal" — ver listClientsForDevice() pra pegar TODOS que têm acesso). */
export function extractDeviceGpswoxUserId(device: any): string | null {
  const raw = device?.device_data?.pivot?.user_id ?? device?.device_data?.user_id ?? null;
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

export interface GpswoxClientSummary {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  raw: any;
}

// Fix de produção 52 — o Carlos quer trazer pra cá os clientes já cadastrados
// no GPSWOX (associando por e-mail/telefone com quem já existe aqui, ou
// criando novo). Confirmado contra a documentação oficial (GET
// /api/admin/clients): resposta paginada (Laravel paginator padrão — `data`,
// `last_page`, etc), sem endpoint de "listar tudo de uma vez". Usa `limit`
// alto (200) pra reduzir o número de páginas na prática, mas ainda percorre
// `last_page` de verdade em vez de assumir que cabe numa página só — contas
// GPSWOX grandes podem ter mais de 200 clientes.
export async function listClients(estId: string, params: { searchDevice?: string } = {}): Promise<GpswoxClientSummary[]> {
  const all: GpswoxClientSummary[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const query: Record<string, any> = { limit: 200, page };
    if (params.searchDevice) query.search_device = params.searchDevice;
    const data = await request(estId, 'admin/clients', { query });
    const list = Array.isArray(data?.data) ? data.data : [];
    for (const c of list) {
      if (c?.id == null) continue;
      all.push({ id: String(c.id), email: c.email || null, phoneNumber: c.phone_number || null, raw: c });
    }
    lastPage = Number(data?.last_page) || 1;
    page++;
  } while (page <= lastPage && page <= 50); // teto de segurança (50 páginas = até 10 mil clientes)
  return all;
}

// Fix de produção 53 — o Carlos confirmou o cenário: um veículo pode ter até
// 4-5 e-mails com acesso no GPSWOX (normalmente só um paga, mas vários usam).
// A listagem de dispositivos (get_devices/get_devices_latest) só devolve UM
// `pivot.user_id` por dispositivo — não dá pra saber por ela quantos clientes
// têm acesso de verdade. Mas `GET /api/admin/clients` aceita `search_device`
// (IMEI) como filtro — confirmado contra a doc oficial — e devolve TODOS os
// clientes que têm aquele dispositivo entre os seus. É isso que permite
// enxergar a lista completa, não só o "dono principal".
export async function listClientsForDevice(estId: string, imei: string): Promise<GpswoxClientSummary[]> {
  return listClients(estId, { searchDevice: imei });
}

export interface ResolvedAddress {
  endereco: string | null;
  cidade: string | null;
  estado: string | null;
  pais: string | null;
  raw: any;
}

// Fix de produção 55 — `get_devices`/`get_devices_latest` não trazem um
// endereço legível (só lat/lng), então `device.address`/`device.last_address`
// nunca existiam de verdade — por isso a "Localização do veículo" sempre
// mostrava "-" onde devia vir rua/cidade/estado/país. A doc oficial confirma
// um endpoint próprio de geocodificação reversa: `GET /api/address/reverse`
// (categoria "Address"), que devolve `location.address` já formatado, mais
// `road`/`house`/`city`/`state`/`country` separados. Best-effort: se falhar,
// o chamador cai pro "Endereço não disponível" de sempre.
export async function resolveAddress(estId: string, lat: number, lng: number): Promise<ResolvedAddress | null> {
  try {
    const data = await request(estId, 'address/reverse', { query: { lat, lng } });
    const loc = data?.location;
    if (!loc) return null;
    const endereco = loc.address || [loc.road, loc.house].filter(Boolean).join(', ') || null;
    return {
      endereco,
      cidade: loc.city || null,
      estado: loc.state || null,
      pais: loc.country || null,
      raw: loc,
    };
  } catch (e: any) {
    console.warn(`[gpswoxClient.resolveAddress] falha ao resolver endereço (lat=${lat}, lng=${lng}): ${e.message}`);
    return null;
  }
}

export async function getDeviceLocation(estId: string, deviceId: string): Promise<DeviceLocation> {
  const devices = await listDevices(estId);
  const device = devices.find((d: any) => String(d.id) === String(deviceId));
  if (!device) throw new Error(`Dispositivo ${deviceId} não encontrado no GPSWOX.`);

  const lat = parseFloat(device.lat ?? device.latitude);
  const lng = parseFloat(device.lng ?? device.longitude);

  // Fix de produção 55 — geocodificação reversa best-effort: `get_devices`
  // não traz endereço pronto, então busca via `address/reverse` sempre que
  // tiver coordenadas válidas.
  let endereco: string | null = device.address || device.last_address || null;
  if (!endereco && Number.isFinite(lat) && Number.isFinite(lng)) {
    const resolved = await resolveAddress(estId, lat, lng);
    endereco = resolved?.endereco || null;
  }

  const lastUpdate = extractDeviceLastUpdate(device);

  return {
    success: true,
    device_id: device.id,
    veiculo: device.name || device.title || null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    endereco: endereco || 'Endereço não disponível',
    velocidade: device.speed ? `${device.speed} km/h` : '0 km/h',
    ignicao: device.engine_status ?? device.ignition ?? null,
    maps_link: Number.isFinite(lat) && Number.isFinite(lng) ? `https://maps.google.com/?q=${lat},${lng}` : null,
    fonte: 'api_oficial',
    capturado_em: new Date().toISOString(),
    ultima_atualizacao: lastUpdate ? lastUpdate.toISOString() : null,
    online: isDeviceOnline(lastUpdate),
  };
}

// Fix de produção 67 — versão em lote de extractDeviceLastUpdate/isDeviceOnline
// pra alimentar a tabela de Frota inteira com 1 chamada só ao GPSWOX (em vez
// de 1 chamada de localização por veículo). Chave = device.id (string), pra
// bater com agenda_frota.gpswox_device_id.
export async function listDeviceStatuses(estId: string): Promise<Record<string, { online: boolean | null; ultima_atualizacao: string | null }>> {
  const devices = await listDevices(estId);
  const out: Record<string, { online: boolean | null; ultima_atualizacao: string | null }> = {};
  for (const device of devices) {
    const lastUpdate = extractDeviceLastUpdate(device);
    out[String(device.id)] = {
      online: isDeviceOnline(lastUpdate),
      ultima_atualizacao: lastUpdate ? lastUpdate.toISOString() : null,
    };
  }
  return out;
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
//
// Fix de produção 54 — dois bugs reais aqui, achados contra a doc oficial
// (o Carlos reportou que o comando "mostra sucesso, mas o carro não reage"):
//   1. `device_id` é `array[integer]` na doc, e a gente mandava um inteiro
//      solto. Em Laravel isso normalmente vira um `foreach` que não itera
//      nada — o comando é gravado no histórico (por isso "sucesso"), mas
//      nenhum dispositivo real recebe nada.
//   2. O corpo tem que ser `multipart/form-data` (a doc é explícita nisso
//      pra esse endpoint específico), não JSON — corrigido via
//      `request(..., { multipart: true })`.
export async function sendCommand(estId: string, deviceId: string, type: string): Promise<CommandResult> {
  const raw = await request(estId, 'send_gprs_command', {
    method: 'POST',
    multipart: true,
    body: { device_id: [Number(deviceId)], type },
  });
  return { success: true, raw };
}

export async function blockDevice(estId: string, deviceId: string): Promise<CommandResult> {
  return sendCommand(estId, deviceId, 'engine_stop');
}

export async function unblockDevice(estId: string, deviceId: string): Promise<CommandResult> {
  return sendCommand(estId, deviceId, 'engine_resume');
}

export interface DeviceCommandOption {
  id: string;
  title: string;
}

export interface DeviceCommandAttribute {
  name: string;
  htmlName: string;
  title: string;
  type: string;
  options: DeviceCommandOption[];
  default: string | number | null;
  description: string;
  validation: string;
  required: boolean;
}

export interface DeviceCommandDef {
  type: string;
  title: string;
  connection: string;
  attributes: DeviceCommandAttribute[];
  raw: any;
}

// Fix de produção 54 — a doc oficial de `send_gprs_command` só dá um
// EXEMPLO de `type` ("engineStop"); não é um enum fixo — cada modelo/
// protocolo de rastreador expõe o próprio catálogo de comandos suportados
// via `get_device_commands`. Hardcodar um `type` genérico pra todos os
// dispositivos (era `engine_stop`/`engine_resume`/`position_single` — nem
// no formato certo) é a explicação mais provável pro "mostra sucesso mas o
// carro não reage": a API aceita e grava o comando (por isso "sucesso"),
// mas o firmware do rastreador não reconhece um `type` que não é dele.
export async function getDeviceCommands(estId: string, deviceId: string, connection?: 'sms' | 'gprs'): Promise<DeviceCommandDef[]> {
  const data = await request(estId, 'get_device_commands', { query: { device_id: deviceId, connection } });
  const list = Array.isArray(data) ? data : extractGpswoxArray(data);
  return list.map((c: any) => ({
    type: c.type,
    title: c.title || c.type,
    connection: c.connection || 'gprs',
    attributes: Array.isArray(c.attributes) ? c.attributes.map((a: any) => ({
      name: a.name,
      htmlName: a.html_name,
      title: a.title,
      type: a.type,
      options: Array.isArray(a.options) ? a.options : [],
      default: a.default ?? null,
      description: a.description,
      validation: a.validation,
      required: !!a.required,
    })) : [],
    raw: c,
  }));
}

/**
 * Busca o catálogo REAL de comandos do dispositivo e tenta achar o `type`
 * certo por palavra-chave (case-insensitive, procura em `type` e `title`).
 * Best-effort: se a busca falhar ou não achar nada, cai pro `fallbackType`
 * (o palpite genérico antigo) em vez de travar o envio inteiro — melhor
 * tentar com um `type` possivelmente errado do que não tentar nada.
 */
export async function resolveCommandType(
  estId: string, deviceId: string, keywords: string[], fallbackType: string
): Promise<{ type: string; fromCatalog: boolean }> {
  try {
    const catalog = await getDeviceCommands(estId, deviceId, 'gprs');
    const match = catalog.find((c) => {
      const haystack = `${c.type} ${c.title}`.toLowerCase();
      return keywords.some((k) => haystack.includes(k.toLowerCase()));
    });
    if (match) return { type: match.type, fromCatalog: true };
  } catch (e: any) {
    console.warn(`[gpswoxClient.resolveCommandType] não foi possível buscar catálogo de comandos (device_id=${deviceId}): ${e.message}`);
  }
  return { type: fallbackType, fromCatalog: false };
}

export interface HistoryPoint {
  latitude: number | null;
  longitude: number | null;
  velocidade: string;
  endereco: string | null;
  capturado_em: string | null;
  maps_link: string | null;
}

// Fix de produção 55 — dois bugs reais aqui, achados direto na doc oficial
// (a tela de "Histórico de trajeto" quebrava com "The from date field is
// required. The to date field is required...", exatamente esses 4 nomes):
//   1. O endpoint certo é `get_history_messages`, não `get_history` (esse
//      nem existe na doc oficial — era um palpite).
//   2. Ele NÃO aceita um `from`/`to` combinado — exige 4 campos separados:
//      `from_date` (YYYY-MM-DD), `from_time` (HH:mm:ss), `to_date`, `to_time`.
// A resposta também é paginada em `messages.data[]` (campos `time`/
// `server_time`, não `dt_tracker`/`date`/`datetime` como estava aqui) — sem
// endereço pronto (não geocodifica cada ponto por padrão: custaria uma
// chamada a `address/reverse` por ponto do trajeto).
function splitDateTime(value: string): [string, string] {
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    return [date, time];
  }
  // já veio separado tipo "YYYY-MM-DD HH:mm:ss" (fallback se não for parseável como Date)
  const [date, time] = value.split(/[T ]/);
  return [date || value, time || '00:00:00'];
}

/** Histórico de trajeto do dispositivo entre duas datas (aceita ISO ou 'YYYY-MM-DD HH:mm:ss'). */
export async function getHistory(estId: string, deviceId: string, from: string, to: string): Promise<HistoryPoint[]> {
  const [fromDate, fromTime] = splitDateTime(from);
  const [toDate, toTime] = splitDateTime(to);
  const data = await request(estId, 'get_history_messages', {
    query: { device_id: deviceId, from_date: fromDate, from_time: fromTime, to_date: toDate, to_time: toTime, limit: 500 },
  });
  const list = Array.isArray(data?.messages?.data) ? data.messages.data : extractGpswoxArray(data, ['messages', 'items', 'data']);

  return list.map((p: any) => {
    const lat = parseFloat(p.lat ?? p.latitude);
    const lng = parseFloat(p.lng ?? p.longitude);
    return {
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      velocidade: p.speed != null ? `${p.speed} km/h` : '0 km/h',
      endereco: p.address || null,
      capturado_em: p.time || p.server_time || null,
      maps_link: Number.isFinite(lat) && Number.isFinite(lng) ? `https://maps.google.com/?q=${lat},${lng}` : null,
    };
  });
}

export interface SharingResult {
  link: string | null;
  raw: any;
}

// Fix de produção 55 — a doc oficial (POST /api/sharing) confirma os campos
// certos do corpo, bem diferentes do que estava aqui (por isso a tela de
// "Compartilhar localização" quebrava com "The Active field is required.
// The Name field is required. The Expiration date field is required." —
// esses 3 nomes exatos). `expiration_by`/`expiration_duration` não existem
// na API real; o certo é `active` (obrigatório), `name` (obrigatório),
// `enable_expiration_date` (boolean) + `expiration_date` (string absoluta
// "YYYY-MM-DD HH:mm:ss", calculada aqui a partir de `durationMinutes`).
/** Gera um link temporário de compartilhamento de localização (API "sharing" do GPSWOX). */
export async function createSharing(estId: string, deviceId: string, durationMinutes: number): Promise<SharingResult> {
  const expiresAt = new Date(Date.now() + durationMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expirationDate = `${expiresAt.getUTCFullYear()}-${pad(expiresAt.getUTCMonth() + 1)}-${pad(expiresAt.getUTCDate())} ${pad(expiresAt.getUTCHours())}:${pad(expiresAt.getUTCMinutes())}:${pad(expiresAt.getUTCSeconds())}`;

  const raw = await request(estId, 'sharing', {
    method: 'POST',
    body: {
      devices: [Number(deviceId)],
      active: true,
      name: `Compartilhamento ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      enable_expiration_date: true,
      expiration_date: expirationDate,
    },
  });
  // O `POST /api/sharing` da doc oficial devolve só `{ data: { hash, ... } }`
  // — sem `url`/`link` pronto. Mantém os fallbacks antigos por segurança
  // (versões diferentes do GPSWOX podem variar), mas o caminho documentado é
  // `data.hash`.
  const directLink = raw?.url || raw?.link || raw?.data?.url || raw?.data?.link || null;
  const hash = raw?.data?.hash || raw?.hash || raw?.items?.hash || null;
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
