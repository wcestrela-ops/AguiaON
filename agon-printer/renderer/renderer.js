'use strict';

// ─── Tab navigation ───────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ─── Status ───────────────────────────────────────────────────
const dotEl   = document.getElementById('status-dot');
const labelEl = document.getElementById('status-label');
const storeEl = document.getElementById('status-store');

function setStatus({ status, text }) {
  dotEl.className   = 'status-dot ' + (status || '');
  labelEl.textContent = text || 'Desconectado';
}

window.agonAPI.onStatusUpdate(setStatus);

// ─── Orders list ──────────────────────────────────────────────
const ordersList = document.getElementById('orders-list');

function fmtMoney(v) { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ','); }
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderOrders(orders) {
  if (!orders || !orders.length) {
    ordersList.innerHTML = '<div class="empty-state">Nenhum pedido recebido ainda.</div>';
    return;
  }
  ordersList.innerHTML = orders.map((o, i) => `
    <div class="order-card${i === 0 ? ' new-flash' : ''}" data-idx="${i}">
      <div class="order-info">
        <div class="order-num">${o._label || '#' + (o.order_number || '?')}</div>
        <div class="order-name">${o.customer_name || 'Cliente'}</div>
        <div class="order-meta">${fmtMoney(o.total)} · ${fmtTime(o._ts || o.created_at)}</div>
      </div>
      <button class="btn-reprint" data-idx="${i}">🖨 Reimprimir</button>
    </div>
  `).join('');

  // Remove flash class after animation
  setTimeout(() => {
    const first = ordersList.querySelector('.new-flash');
    if (first) first.classList.remove('new-flash');
  }, 700);
}

ordersList.addEventListener('click', async e => {
  const btn = e.target.closest('.btn-reprint');
  if (!btn) return;
  const idx   = +btn.dataset.idx;
  const order = cachedOrders[idx];
  if (!order) return;
  btn.textContent = '⏳';
  btn.disabled = true;
  const res = await window.agonAPI.reprintOrder(order);
  btn.textContent = res.ok ? '✅' : '❌';
  setTimeout(() => { btn.textContent = '🖨 Reimprimir'; btn.disabled = false; }, 2000);
});

let cachedOrders = [];
window.agonAPI.onNewOrder(({ recentOrders }) => {
  cachedOrders = recentOrders;
  renderOrders(recentOrders);
});

// ─── Settings form ────────────────────────────────────────────
const fUrl      = document.getElementById('f-url');
const fToken    = document.getElementById('f-token');
const fName     = document.getElementById('f-name');
const fPrinter  = document.getElementById('f-printer');
const fFont     = document.getElementById('f-font');
const fCopies   = document.getElementById('f-copies');
const fAuto     = document.getElementById('f-autostart');
const saveStatus = document.getElementById('save-status');

async function loadPrinters(selected) {
  const printers = await window.agonAPI.getPrinters();
  fPrinter.innerHTML = '<option value="">(modo log — sem imprimir)</option>';
  printers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    if (p === selected) opt.selected = true;
    fPrinter.appendChild(opt);
  });
}

document.getElementById('btn-reload-printers').addEventListener('click', () => {
  loadPrinters(fPrinter.value);
});

document.getElementById('btn-show-token').addEventListener('click', () => {
  fToken.type = fToken.type === 'password' ? 'text' : 'password';
});

document.getElementById('btn-log').addEventListener('click', () => {
  window.agonAPI.openLog();
});

// Carrega config existente nos campos
async function loadFormValues() {
  const cfg = await window.agonAPI.getConfig();

  if (cfg) {
    fUrl.value   = cfg.server_url   || '';
    fToken.value = cfg.store_token  || '';
    fToken.type  = 'password';
    fName.value  = cfg.store_name   || '';
    fFont.value  = String(cfg.font_size  || 12);
    fCopies.value = String(cfg.copies    || 1);
    await loadPrinters(cfg.printer_name || '');

    // Status da conexão
    const s = await window.agonAPI.getConnectionStatus();
    setStatus(s);
    storeEl.textContent = cfg.store_name || '';

    // Pedidos recentes
    const orders = await window.agonAPI.getRecentOrders();
    cachedOrders = orders;
    renderOrders(orders);
  } else {
    // Sem config → vai para aba de configurações
    await loadPrinters('');
    document.querySelector('[data-tab="settings"]').click();
  }

  // Autostart
  const autoOn = await window.agonAPI.getAutostart();
  fAuto.checked = autoOn;
}

document.getElementById('config-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn-save');
  btn.textContent = 'Salvando...';
  btn.disabled = true;
  saveStatus.textContent = '';
  saveStatus.className = 'save-status';

  const cfg = {
    server_url:   fUrl.value.replace(/\/$/, ''),
    store_token:  fToken.value.trim(),
    store_name:   fName.value.trim() || 'Minha Loja',
    printer_name: fPrinter.value,
    font_size:    parseInt(fFont.value, 10)   || 12,
    copies:       parseInt(fCopies.value, 10) || 1,
    autostart:    fAuto.checked,
  };

  const res = await window.agonAPI.saveConfig(cfg);

  if (res.ok) {
    saveStatus.textContent = '✓ Configuração salva! Conectando...';
    saveStatus.className   = 'save-status ok';
    storeEl.textContent    = cfg.store_name;
    // Volta para aba de status
    setTimeout(() => {
      document.querySelector('[data-tab="status"]').click();
    }, 1000);
  } else {
    saveStatus.textContent = '✗ Erro: ' + (res.error || 'Falha ao salvar');
    saveStatus.className   = 'save-status err';
  }

  btn.textContent = 'Salvar e Conectar';
  btn.disabled = false;
});

// ─── Init ─────────────────────────────────────────────────────
loadFormValues();
