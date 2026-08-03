'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain,
  nativeImage, Notification, shell, dialog,
} = require('electron');
const { io }        = require('socket.io-client');
const { execSync }  = require('child_process');
const path          = require('path');
const fs            = require('fs');
const os            = require('os');

// ─── Paths (userData é sempre gravável no Windows) ────────────
const USER_DATA   = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const LOG_PATH    = path.join(USER_DATA, 'agon-print.log');

// ─── Estado global ────────────────────────────────────────────
let mainWindow       = null;
let tray             = null;
let socket           = null;
let recentOrders     = [];   // até 5 pedidos
let connectionStatus = 'disconnected';

// ─── Logging ──────────────────────────────────────────────────
const MAX_LOG = 512 * 1024;
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}\r\n`;
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG) {
      const c = fs.readFileSync(LOG_PATH, 'utf8');
      fs.writeFileSync(LOG_PATH, c.slice(-MAX_LOG / 2), 'utf8');
    }
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch {}
  console.log(msg);
}

// ─── Config ───────────────────────────────────────────────────
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').trim();
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg.store_token || !cfg.server_url) return null;
    return cfg;
  } catch { return null; }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  log('[config] salvo: ' + CONFIG_PATH);
}

// ─── Impressoras ──────────────────────────────────────────────
function listPrinters() {
  try {
    return execSync('wmic printer get name /format:list', { encoding: 'utf8' })
      .split('\n').filter(l => l.trim().startsWith('Name='))
      .map(l => l.replace('Name=', '').trim()).filter(Boolean);
  } catch { return []; }
}

// ─── Fonte Word → ESC/POS ─────────────────────────────────────
function getFontConfig(size) {
  size = Math.max(8, Math.min(32, size || 12));
  if (size <= 12) return { height: 0, width: 0, cols: 48 };
  if (size <= 16) return { height: 1, width: 0, cols: 48 };
  if (size <= 22) return { height: 1, width: 1, cols: 24 };
  return { height: 2, width: 1, cols: 24 };
}

// ─── Formatação de cupom — mesmas regras do painel do lojista ─
const fmtMoney = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

/**
 * Retorna "seg 9 | 13/04/2026, 06:10" — formato idêntico ao painel do lojista.
 * O dailyCode já vem do banco no formato "seg 9", basta adicionar " | data".
 */
function buildHeaderDate(dailyCode) {
  const dt = new Date().toLocaleString('pt-BR', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit',
  });
  return `${dailyCode} | ${dt}`;
}

const PAY_LABEL = {
  pix:'PIX', dinheiro:'Dinheiro', cartao_credito:'Cartao Credito',
  cartao_debito:'Cartao Debito', na_entrega:'Na Entrega', manual_pix:'PIX Manual',
};

/** Retorna label e detalhe do tipo de entrega — mesma prioridade do loja.html */
function getDeliveryInfo(order) {
  // Mesa tem prioridade sobre delivery_type (igual ao loja.html)
  if (order.table_number || order.delivery_type === 'mesa') {
    const num = order.table_number || '';
    return { label: num ? `Mesa ${num}` : 'Mesa', detail: num ? `Mesa ${num}` : '' };
  }
  if (order.delivery_type === 'scheduled_pickup') {
    const dt = order.scheduled_pickup_time
      ? new Date(order.scheduled_pickup_time).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
      : 'Horario agendado';
    return { label: 'Retirada Agendada', detail: dt };
  }
  if (order.delivery_type === 'pickup') {
    return { label: 'Retirada na Loja', detail: '' };
  }
  if (order.delivery_type === 'balcao') {
    return { label: 'Balcao', detail: '' };
  }
  // delivery — mostra endereco
  return { label: 'Entrega', detail: order.customer_address || '' };
}

/** Calcula preco do item exatamente como o loja.html:
 *  - Para PDV: it.price ja e o preco combinado (base + addons) — nao somar additional_price
 *  - Para vitrine: it.price e o base, addons vem em selected_options.additional_price
 *  A logica identica ao loja.html usa apenas selected_options.additional_price (opts),
 *  nao soma it.addons separadamente (evita dupla contagem no PDV).
 */
function calcItemPrice(it) {
  const qty      = +(it.quantity || 1);
  const optsRaw  = (it.selected_options || it.options || []);
  const addTotal = optsRaw.reduce((s, op) => s + +(op.additional_price || 0), 0);
  return (+(it.price || 0) + addTotal) * qty;
}

function buildCupomText(order, storeName, fontSize) {
  const { cols } = getFontConfig(fontSize);
  const center = t => ' '.repeat(Math.max(0, Math.floor((cols - t.length) / 2))) + t;
  const sep    = (c = '-') => c.repeat(cols);
  const two    = (l, r) => l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r;
  const items  = typeof order.items === 'string'
    ? JSON.parse(order.items) : (order.items || []);
  const lines  = [];
  // daily_code vem do banco já no formato "seg 9" — mesmo campo usado no navegador
  const codigo = order.daily_code
    || order.display_number
    || (order.order_number ? `#${order.order_number}` : (order.id || '').slice(-6).toUpperCase() || '???');

  // Cabeçalho — "seg 9 | 13/04/2026, 06:10"
  lines.push(sep('='));
  lines.push(center(storeName.toUpperCase()));
  lines.push(center(buildHeaderDate(codigo)));
  lines.push(sep('='));

  // Tipo de entrega + localização
  const dInfo = getDeliveryInfo(order);
  lines.push(center(`[ ${dInfo.label.toUpperCase()} ]`));
  if (dInfo.detail) lines.push(center(dInfo.detail));
  lines.push('');

  // Cliente
  lines.push(`Cliente : ${order.customer_name || '---'}`);
  if (order.customer_phone) lines.push(`Telefone: ${order.customer_phone}`);

  // Observacao do pedido
  if (order.notes) { lines.push(sep()); lines.push(`Obs: ${order.notes}`); }

  // Itens
  lines.push(sep(), center('ITENS'), sep());
  for (const it of items) {
    const qty      = +(it.quantity || 1);
    const optsRaw  = (it.selected_options || it.options || []);
    const oNames   = optsRaw.map(op => typeof op === 'string' ? op : op.name).filter(Boolean);
    const aNames   = (it.addons || []).map(a => a.name).filter(Boolean);
    const price    = calcItemPrice(it);
    const variant  = it.variant ? ` (${it.variant})` : '';

    lines.push(two(`${qty}x ${it.name || '?'}${variant}`, fmtMoney(price)));
    if (it.added_by_store)  lines.push('   * Adicionado pelo lojista');
    if (oNames.length)      lines.push(`   + ${oNames.join(', ')}`);
    if (aNames.length)      lines.push(`   + ${aNames.join(', ')}`);
    if (it.note)            lines.push(`   # ${it.note}`);
  }

  // Totais
  lines.push(sep());
  if (+order.delivery_tax > 0) lines.push(two('Entrega',  fmtMoney(order.delivery_tax)));
  if (+order.discount > 0)     lines.push(two('Desconto', '-' + fmtMoney(order.discount)));
  lines.push(two('TOTAL', fmtMoney(order.total)));
  lines.push(two('Pagamento', PAY_LABEL[order.payment_method] || order.payment_method || '---'));
  if (order.payment_method === 'dinheiro' && order.change_for) {
    const troco = Math.max(0, +order.change_for - +order.total);
    lines.push(two('Troco para',      fmtMoney(order.change_for)));
    lines.push(two('Troco a devolver', fmtMoney(troco)));
  } else if (order.payment_method === 'dinheiro') {
    lines.push(center('Sem troco necessario'));
  }

  lines.push(sep('='), center('AG-ON * Obrigado pela preferencia!'), sep('='), '', '');
  return lines.join('\n');
}

// ─── Impressão ESC/POS ────────────────────────────────────────
async function printEscPos(order, storeName, printerName, copies, fontSize) {
  const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');
  const bodyFont  = getFontConfig(fontSize);
  const titleFont = getFontConfig(fontSize + 4);
  const items     = typeof order.items === 'string'
    ? JSON.parse(order.items) : (order.items || []);
  const { cols }  = bodyFont;
  const two       = (l, r) => l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r;
  // daily_code vem do banco já no formato "seg 9" — mesmo campo usado no navegador
  const codigo    = order.daily_code
    || order.display_number
    || (order.order_number ? `#${order.order_number}` : (order.id || '').slice(-6).toUpperCase() || '???');

  for (let via = 0; via < copies; via++) {
    const printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: `printer:${printerName}`,
      characterSet: CharacterSet.PC860_PORTUGUESE,
      removeSpecialCharacters: false,
      options: { timeout: 5000 },
    });

    // ── Cabeçalho — "seg 9 | 13/04/2026, 06:10" ──
    printer.alignCenter();
    printer.setTextSize(titleFont.height, titleFont.width);
    printer.println(storeName.toUpperCase());
    printer.setTextSize(bodyFont.height, bodyFont.width);
    printer.println(buildHeaderDate(codigo));
    printer.drawLine();

    // ── Tipo de entrega ──
    const dInfo = getDeliveryInfo(order);
    printer.bold(true); printer.println(`[ ${dInfo.label.toUpperCase()} ]`); printer.bold(false);
    if (dInfo.detail) printer.println(dInfo.detail);
    printer.newLine(); printer.alignLeft();

    // ── Cliente ──
    printer.println(`Cliente : ${order.customer_name || '---'}`);
    if (order.customer_phone) printer.println(`Telefone: ${order.customer_phone}`);
    if (order.notes) { printer.drawLine(); printer.println(`Obs: ${order.notes}`); }

    // ── Itens ──
    printer.drawLine(); printer.alignCenter();
    printer.bold(true); printer.println('ITENS'); printer.bold(false);
    printer.drawLine(); printer.alignLeft();

    for (const it of items) {
      const qty      = +(it.quantity || 1);
      const optsRaw  = (it.selected_options || it.options || []);
      const oNames   = optsRaw.map(op => typeof op === 'string' ? op : op.name).filter(Boolean);
      const aNames   = (it.addons || []).map(a => a.name).filter(Boolean);
      const price    = calcItemPrice(it);
      const variant  = it.variant ? ` (${it.variant})` : '';

      printer.tableCustom([
        { text: `${qty}x ${it.name || '?'}${variant}`, align: 'LEFT',  width: 0.7 },
        { text: fmtMoney(price),                        align: 'RIGHT', width: 0.3 },
      ]);
      if (it.added_by_store)  printer.println('  * Adicionado pelo lojista');
      if (oNames.length)      printer.println(`  + ${oNames.join(', ')}`);
      if (aNames.length)      printer.println(`  + ${aNames.join(', ')}`);
      if (it.note)            printer.println(`  # ${it.note}`);
    }

    // ── Totais ──
    printer.drawLine();
    if (+order.delivery_tax > 0) printer.println(two('Entrega',   fmtMoney(order.delivery_tax)));
    if (+order.discount > 0)     printer.println(two('Desconto',  '-' + fmtMoney(order.discount)));
    printer.bold(true);
    printer.setTextSize(Math.min(titleFont.height, 1), titleFont.width);
    printer.println(two('TOTAL', fmtMoney(order.total)));
    printer.setTextSize(bodyFont.height, bodyFont.width); printer.bold(false);
    printer.println(two('Pagamento', PAY_LABEL[order.payment_method] || order.payment_method || '---'));

    if (order.payment_method === 'dinheiro' && order.change_for) {
      const troco = Math.max(0, +order.change_for - +order.total);
      printer.println(two('Troco para',       fmtMoney(order.change_for)));
      printer.bold(true);
      printer.println(two('Troco a devolver', fmtMoney(troco)));
      printer.bold(false);
    } else if (order.payment_method === 'dinheiro') {
      printer.alignCenter(); printer.println('Sem troco necessario'); printer.alignLeft();
    }

    printer.drawLine(); printer.alignCenter();
    printer.println('AG-ON * Obrigado pela preferencia!');
    printer.drawLine(); printer.newLine(); printer.cut();
    await printer.execute();
  }
}

function printTextFallback(text, printerName, copies) {
  const tmp = path.join(os.tmpdir(), `agon_${Date.now()}.txt`);
  fs.writeFileSync(tmp, text.replace(/\n/g, '\r\n'), 'utf8');
  const cmd = printerName ? `print /D:"${printerName}" "${tmp}"` : `print "${tmp}"`;
  for (let i = 0; i < copies; i++) {
    try { execSync(cmd, { stdio: 'ignore' }); }
    catch { try { execSync(`notepad /p "${tmp}"`, { stdio: 'ignore' }); } catch {} }
  }
  setTimeout(() => { try { fs.unlinkSync(tmp); } catch {} }, 5000);
}

// ─── Socket.io ────────────────────────────────────────────────
function startSocket(cfg) {
  if (socket) { try { socket.disconnect(); } catch {} socket = null; }

  const { server_url, store_token, store_name = 'Loja', printer_name, copies = 1, font_size = 12 } = cfg;
  log(`Conectando → ${server_url}`);

  socket = io(server_url, {
    query: { store_token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 30000,
  });

  socket.on('connect', () => {
    log(`Conectado (${socket.id})`);
    connectionStatus = 'connected';
    sendToRenderer('status-update', { status: 'connected', text: 'Conectado' });
    updateTrayMenu(cfg);
  });

  socket.on('new_order', async (order) => {
    const label = `#${order.order_number || order.daily_code || (order.id||'').slice(-6)}`;
    log(`Novo pedido: ${label} — ${order.customer_name || ''}`);

    recentOrders.unshift({ ...order, _label: label, _ts: Date.now() });
    if (recentOrders.length > 5) recentOrders = recentOrders.slice(0, 5);

    sendToRenderer('new-order', { order, recentOrders });

    if (Notification.isSupported()) {
      new Notification({
        title: 'AG-ON — Novo Pedido!',
        body: `${label} · ${order.customer_name || 'Cliente'} · ${fmtMoney(order.total)}`,
      }).show();
    }

    if (printer_name) {
      try {
        await printEscPos(order, store_name, printer_name, copies, font_size);
        log(`Impresso: ${printer_name}`);
      } catch (err) {
        log(`ESC/POS falhou (${err.message}) — fallback texto`);
        printTextFallback(buildCupomText(order, store_name, font_size), printer_name, copies);
      }
    } else {
      log(`[CUPOM SEM IMPRESSORA]\n${buildCupomText(order, store_name, font_size)}`);
    }
  });

  socket.on('connect_error', err => {
    log(`Erro de conexão: ${err.message}`);
    connectionStatus = 'error';
    sendToRenderer('status-update', { status: 'error', text: `Erro: ${err.message}` });
    updateTrayMenu(cfg);
  });

  socket.on('disconnect', reason => {
    log(`Desconectado: ${reason}`);
    connectionStatus = 'disconnected';
    sendToRenderer('status-update', { status: 'disconnected', text: 'Reconectando...' });
    updateTrayMenu(cfg);
  });
}

// ─── Comunicação com o renderer ───────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ─── IPC handlers ─────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('get-config', () => loadConfig());

  ipcMain.handle('save-config', async (_, cfg) => {
    try {
      saveConfig(cfg);
      startSocket(cfg);
      app.setLoginItemSettings({ openAtLogin: !!cfg.autostart });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('get-printers', () => listPrinters());

  ipcMain.handle('get-recent-orders', () => recentOrders);

  ipcMain.handle('reprint-order', async (_, order) => {
    const cfg = loadConfig();
    if (!cfg) return { ok: false, error: 'Sem configuração' };
    if (!cfg.printer_name) return { ok: false, error: 'Nenhuma impressora configurada' };
    try {
      await printEscPos(order, cfg.store_name || 'Loja', cfg.printer_name, 1, cfg.font_size || 12);
      return { ok: true };
    } catch (err) {
      printTextFallback(buildCupomText(order, cfg.store_name || 'Loja', cfg.font_size || 12), cfg.printer_name, 1);
      return { ok: true };
    }
  });

  ipcMain.handle('open-log', () => shell.openPath(LOG_PATH));

  ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle('set-autostart', (_, enable) => {
    app.setLoginItemSettings({ openAtLogin: enable });
    const cfg = loadConfig();
    if (cfg) { cfg.autostart = enable; saveConfig(cfg); }
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('get-connection-status', () => ({
    status: connectionStatus,
    text: connectionStatus === 'connected' ? 'Conectado'
        : connectionStatus === 'error'     ? 'Erro de conexão'
        : 'Desconectado',
  }));
}

// ─── Ícone da bandeja ─────────────────────────────────────────
// PNG 32x32 azul AG-ON embutido — substitua por assets/icon.png real
const ICON_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABqSURBVFhH7ZZBCsAgDASj//9z91APHoQUFmHdOQQHMpkxxhhjVVVV8/3ee4+ZmVVVtVqrqr33iIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiPifAQAAAAAAAAAAAABfAHMVoAFnoTd8AAAAAElFTkSuQmCC';

function getTrayIcon() {
  // Tenta usar arquivo de ícone real primeiro
  const iconFile = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(iconFile)) {
    return nativeImage.createFromPath(iconFile);
  }
  return nativeImage.createFromDataURL(`data:image/png;base64,${ICON_PNG_B64}`);
}

// ─── Menu da bandeja ──────────────────────────────────────────
function updateTrayMenu(cfg) {
  if (!tray) return;
  const storeName   = cfg?.store_name || 'AG-ON Print';
  const statusLabel = connectionStatus === 'connected' ? '🟢 Conectado'
                    : connectionStatus === 'error'     ? '🔴 Erro'
                    : '🟡 Reconectando...';

  const menu = Menu.buildFromTemplate([
    { label: storeName, enabled: false },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Abrir Painel',
      click: () => { mainWindow.show(); mainWindow.focus(); },
    },
    {
      label: 'Reiniciar Conexão',
      click: () => { const c = loadConfig(); if (c) startSocket(c); },
    },
    { type: 'separator' },
    {
      label: 'Ver Log',
      click: () => shell.openPath(LOG_PATH),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`AG-ON Print — ${storeName} — ${statusLabel}`);
}

function createTray(cfg) {
  tray = new Tray(getTrayIcon());
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  updateTrayMenu(cfg);
}

// ─── Janela principal ─────────────────────────────────────────
function createWindow() {
  const iconFile = path.join(__dirname, 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 420,
    height: 580,
    minWidth: 420,
    minHeight: 580,
    resizable: false,
    title: 'AG-ON Print',
    icon: fs.existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0f172a',
    show: false, // mostra depois do ready-to-show para evitar flash branco
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    const cfg = loadConfig();
    // Se não há config → mostra janela para configuração inicial
    if (!cfg) mainWindow.show();
  });

  // Minimiza para bandeja ao fechar a janela
  mainWindow.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Abre links externos no navegador padrão
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Ciclo de vida do app ─────────────────────────────────────
app.whenReady().then(() => {
  log(`AG-ON Print v${app.getVersion()} iniciando — userData: ${USER_DATA}`);

  createWindow();
  setupIPC();

  const cfg = loadConfig();
  createTray(cfg);

  if (cfg) {
    log(`Config encontrada — loja: ${cfg.store_name}`);
    startSocket(cfg);
  } else {
    log('Sem config — aguardando configuração via interface');
  }
});

// Mantém o processo vivo mesmo sem janelas visíveis (bandeja)
app.on('window-all-closed', () => { /* não faz nada */ });
app.on('before-quit', () => { app.isQuitting = true; });
