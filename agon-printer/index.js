/**
 * AG-ON Printer — Sistema de Impressão Automática
 * Roda como ícone na bandeja do sistema (System Tray) — sem janela de terminal.
 */

'use strict';

const { io }       = require('socket.io-client');
const { execSync } = require('child_process');
const SysTray      = require('systray2').default;
// node-notifier removido — notificações via PowerShell (sem binários externos)
const path         = require('path');
const fs           = require('fs');
const os           = require('os');

// ─────────────────────────────────────────────────────────────
// Caminho do config.json — sempre ao lado do executável
// ─────────────────────────────────────────────────────────────
const EXE_DIR     = process.execPath.toLowerCase().includes('agon-print')
  ? path.dirname(process.execPath)   // rodando como .exe
  : __dirname;                       // rodando com node direto
const CONFIG_PATH = path.join(EXE_DIR, 'config.json');
const LOG_PATH    = path.join(EXE_DIR, 'agon-print.log');

// ─────────────────────────────────────────────────────────────
// Logging em arquivo (sem console — janela oculta)
// ─────────────────────────────────────────────────────────────
const MAX_LOG_BYTES = 512 * 1024; // 512 KB

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}\r\n`;
  try {
    // Trunca log se muito grande
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) {
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      fs.writeFileSync(LOG_PATH, content.slice(-MAX_LOG_BYTES / 2), 'utf8');
    }
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch {}
  // Mostra no console também (útil em modo de desenvolvimento)
  try { process.stdout.write(line); } catch {}
}

// ─────────────────────────────────────────────────────────────
// Ícone ICO 16×16 azul AG-ON embutido (sem arquivo externo)
// ─────────────────────────────────────────────────────────────
const ICON_BASE64 = 'AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADrYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/62Ml/+tjJf/rYyX/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

/**
 * Exibe mensagem de erro e aguarda o usuário clicar OK antes de encerrar.
 * Garante que o motivo do encerramento seja sempre visível.
 */
function fatalError(msg) {
  log('[FATAL] ' + msg);
  psMessage(`ERRO FATAL\n\n${msg}\n\nO programa será encerrado.`, 'AG-ON Print — Erro');
  process.exit(1);
}

/**
 * Verifica se o diretório do exe tem permissão de escrita.
 * Retorna o erro descritivo ou null se ok.
 */
function checkWritePermission() {
  const testFile = path.join(EXE_DIR, '.write_test');
  try {
    fs.writeFileSync(testFile, '1', 'utf8');
    fs.unlinkSync(testFile);
    return null;
  } catch (e) {
    return e.message;
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;

  let raw = '';
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8').trim(); } catch { return null; }

  // Arquivo vazio ou só espaços → ignora e abre wizard
  if (!raw) return null;

  let cfg;
  try { cfg = JSON.parse(raw); } catch {
    // JSON corrompido → loga e ignora para não travar
    log('[config] config.json corrompido — será reconfigurado');
    return null;
  }

  // Valores padrão/placeholder → ainda não configurado
  if (!cfg.store_token || cfg.store_token === 'COLE_AQUI_O_TOKEN_DA_LOJA') return null;
  if (!cfg.server_url  || cfg.server_url  === 'https://seu-dominio.com')   return null;

  return cfg;
}

function saveConfig(cfg) {
  const writeErr = checkWritePermission();
  if (writeErr) {
    fatalError(
      `Sem permissão para salvar o arquivo de configuração.\n\n` +
      `Caminho: ${CONFIG_PATH}\n` +
      `Motivo : ${writeErr}\n\n` +
      `Solução: Mova o agon-print.exe para uma pasta onde você tenha permissão de escrita\n` +
      `(ex: C:\\AG-ON Print\\ ou sua Área de Trabalho).`
    );
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    log('[config] config.json salvo em: ' + CONFIG_PATH);
  } catch (e) {
    fatalError(
      `Falha ao salvar o config.json.\n\n` +
      `Caminho: ${CONFIG_PATH}\n` +
      `Erro   : ${e.message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Setup via diálogos PowerShell — usando arquivo .ps1 temporário
// para evitar problemas de escape de caracteres no Windows
// ─────────────────────────────────────────────────────────────

// Sentinel: retornado quando o usuário clica em Cancelar no InputBox
const PS_CANCELLED = '__PS_CANCELLED__';

/** Executa um script PowerShell gravado em arquivo temp. Mais confiável que inline. */
function runPsScript(scriptContent, timeoutMs = 120000) {
  const tmpFile = path.join(os.tmpdir(), `agon_ps_${Date.now()}.ps1`);
  try {
    // UTF-8 BOM (\uFEFF) é obrigatório para o PowerShell no Windows ler
    // corretamente arquivos com caracteres especiais (ã, ç, →, etc.)
    fs.writeFileSync(tmpFile, '\uFEFF' + scriptContent, 'utf8');
    const out = execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${tmpFile}"`,
      { encoding: 'utf8', timeout: timeoutMs }
    );
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: e.stdout || '', error: e.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Mostra um InputBox do Windows via PowerShell.
 * Retorna a string digitada pelo usuário, ou PS_CANCELLED se ele cancelou.
 *
 * Detecção de Cancelar: o script PS grava um arquivo sentinela em %TEMP%
 * antes de exibir o InputBox. Se o usuário cancelar, o arquivo fica com
 * o valor "CANCELLED"; se confirmar, recebe o valor digitado.
 */
function psInput(prompt, title, defaultVal = '') {
  const resultFile = path.join(os.tmpdir(), `agon_input_${Date.now()}.txt`);
  // Monta script PS sem interpolação complexa — usa here-string do PS (@'...'@)
  // para evitar qualquer problema de escape com aspas no conteúdo do prompt.
  const safePrompt  = prompt.replace(/'/g, "''");
  const safeTitle   = title.replace(/'/g, "''");
  const safeDefault = defaultVal.replace(/'/g, "''");
  const safeResult  = resultFile.replace(/\\/g, '\\\\');

  const script = `
Add-Type -AssemblyName Microsoft.VisualBasic
$result = [Microsoft.VisualBasic.Interaction]::InputBox('${safePrompt}', '${safeTitle}', '${safeDefault}')
if ($null -eq $result) {
    [System.IO.File]::WriteAllText('${safeResult}', 'CANCELLED')
} else {
    [System.IO.File]::WriteAllText('${safeResult}', $result)
}
`;

  try {
    runPsScript(script, 120000);
    if (!fs.existsSync(resultFile)) return PS_CANCELLED;
    const val = fs.readFileSync(resultFile, 'utf8');
    if (val === 'CANCELLED') return PS_CANCELLED;
    return val;
  } catch {
    return PS_CANCELLED;
  } finally {
    try { if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile); } catch {}
  }
}

function psMessage(msg, title = 'AG-ON Print') {
  const safeMsg   = msg.replace(/'/g, "''");
  const safeTitle = title.replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.Interaction]::MsgBox('${safeMsg}', 0, '${safeTitle}') | Out-Null
`;
  runPsScript(script, 60000);
}

function listWindowsPrinters() {
  try {
    return execSync('wmic printer get name /format:list', { encoding: 'utf8' })
      .split('\n').filter(l => l.trim().startsWith('Name='))
      .map(l => l.replace('Name=', '').trim()).filter(Boolean);
  } catch { return []; }
}

async function runSetupWizard() {
  // Verifica permissão de escrita ANTES de começar o wizard
  const writeErr = checkWritePermission();
  if (writeErr) {
    fatalError(
      `Sem permissão de escrita na pasta do programa.\n\n` +
      `Pasta  : ${EXE_DIR}\n` +
      `Motivo : ${writeErr}\n\n` +
      `Solução: Mova o agon-print.exe para uma pasta onde\n` +
      `você tenha permissão de escrita, como:\n` +
      `  C:\\AG-ON Print\\\n` +
      `  Área de Trabalho\\AG-ON Print\\`
    );
  }

  psMessage(
    'Bem-vindo ao AG-ON Print!\n\nVamos configurar seu programa de impressão automática.\nClique OK para começar.',
    'AG-ON Print — Configuração'
  );

  // Helper: campo obrigatório com retry automático
  function requireInput(prompt, title, defaultVal, validateFn, errMsg) {
    while (true) {
      const val = psInput(prompt, title, defaultVal);
      if (val === PS_CANCELLED) {
        psMessage('Configuração cancelada pelo usuário.\nO programa será encerrado.', 'AG-ON Print');
        process.exit(0);
      }
      if (!validateFn || validateFn(val)) return val;
      psMessage(`${errMsg}\n\nTente novamente.`, 'AG-ON Print — Campo inválido');
    }
  }

  // 1. URL do servidor
  const serverUrl = requireInput(
    'Digite a URL do servidor AG-ON:\n(Ex: https://meusite.com)',
    'AG-ON Print — Passo 1 de 6: Servidor',
    '',
    v => v && v.startsWith('http'),
    'A URL deve começar com http:// ou https://'
  );

  // 2. Token da loja
  const storeToken = requireInput(
    'Cole o Token da Loja:\n\n(Obtenha no Painel da Loja → Configurações de Impressão → copiar token)',
    'AG-ON Print — Passo 2 de 6: Token',
    '',
    v => v && v.length >= 10,
    'Token muito curto ou vazio. Cole o token completo fornecido pelo painel.'
  );

  // 3. Nome da loja
  const storeNameRaw = psInput(
    'Nome da loja (aparece no cabeçalho do cupom):',
    'AG-ON Print — Passo 3 de 6: Nome da Loja',
    'Minha Loja'
  );
  const storeName = (storeNameRaw === PS_CANCELLED || !storeNameRaw) ? 'Minha Loja' : storeNameRaw;

  // 4. Impressora
  const printers = listWindowsPrinters();
  let selectedPrinter = '';
  if (printers.length) {
    const list = printers.map((p, i) => `${i + 1}. ${p}`).join('\n');
    const choice = psInput(
      `Impressoras disponíveis:\n\n${list}\n\nDigite o número da impressora.\n(deixe em branco para modo log apenas):`,
      'AG-ON Print — Passo 4 de 6: Impressora',
      '1'
    );
    if (choice !== PS_CANCELLED) {
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < printers.length) selectedPrinter = printers[idx];
    }
  } else {
    psMessage('Nenhuma impressora detectada.\nO programa funcionará em modo de log apenas.\n\nVocê pode reconfigurar depois pelo menu da bandeja.', 'AG-ON Print');
  }

  // 5. Tamanho de fonte
  const fontRaw = psInput(
    'Tamanho da fonte (padrão Word):\n\n  10-12 → normal\n  13-16 → altura dupla\n  17-22 → grande (2×2)\n  23-28 → extra grande\n\nDigite um número de 10 a 28:',
    'AG-ON Print — Passo 5 de 6: Fonte',
    '12'
  );
  const fontSize = Math.max(10, Math.min(28, parseInt((fontRaw === PS_CANCELLED ? '12' : fontRaw) || '12', 10) || 12));

  // 6. Inicialização automática com o Windows
  const autoRaw = psInput(
    'Deseja que o AG-ON Print inicie automaticamente com o Windows?\n\nDigite S para sim ou N para não:',
    'AG-ON Print — Passo 6 de 6: Inicialização',
    'S'
  );
  const wantsAutostart = autoRaw !== PS_CANCELLED && (autoRaw || 'S').trim().toUpperCase() !== 'N';

  const cfg = {
    server_url:   serverUrl.replace(/\/$/, ''),
    store_token:  storeToken,
    store_name:   storeName || 'Loja',
    printer_name: selectedPrinter,
    font_size:    fontSize,
    copies:       1,
    autostart:    wantsAutostart,
  };
  saveConfig(cfg);

  // Cria launcher VBS (para próximas execuções sem terminal)
  createVbsLauncher();

  // Aplica preferência de autostart
  if (wantsAutostart) {
    createStartupShortcut();
  } else {
    removeStartupShortcut();
  }

  const autostartMsg = wantsAutostart
    ? '\nInicialização automática: ATIVADA ✓'
    : '\nInicialização automática: desativada';

  psMessage(
    `Configuração salva com sucesso!\n\nImpressora: ${selectedPrinter || '(modo log)'}\nFonte: ${fontSize}pt${autostartMsg}\n\nO AG-ON Print será iniciado agora.\nUse o ícone na bandeja do sistema (próximo ao relógio) para gerenciá-lo.\n\nDica: na próxima vez, use o atalho "Iniciar AG-ON Print.vbs" para abrir sem janela de terminal.`,
    'AG-ON Print — Pronto!'
  );

  return cfg;
}

// ─────────────────────────────────────────────────────────────
// Cria launcher VBS ao lado do .exe (abre sem janela de terminal)
// ─────────────────────────────────────────────────────────────
function createVbsLauncher() {
  const vbsPath = path.join(EXE_DIR, 'Iniciar AG-ON Print.vbs');
  if (fs.existsSync(vbsPath)) return; // já existe
  const exePath = process.execPath;
  const vbs = [
    `' AG-ON Print Launcher — abre sem janela de terminal`,
    `Set oShell = CreateObject("Wscript.Shell")`,
    `oShell.Run Chr(34) & "${exePath}" & Chr(34), 0, False`,
  ].join('\r\n');
  try { fs.writeFileSync(vbsPath, vbs, 'utf8'); } catch {}
}

// ─────────────────────────────────────────────────────────────
// Cria/remove atalho de inicialização automática com o Windows
// ─────────────────────────────────────────────────────────────
const STARTUP_FOLDER = path.join(
  process.env.APPDATA || '',
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const STARTUP_SHORTCUT = path.join(STARTUP_FOLDER, 'AG-ON Print.lnk');

function createStartupShortcut() {
  // Usa o VBS (sem janela) como alvo do atalho, pois abre o exe oculto
  const vbsPath = path.join(EXE_DIR, 'Iniciar AG-ON Print.vbs');
  const target  = fs.existsSync(vbsPath) ? vbsPath : process.execPath;
  const ps = `
$wsh = New-Object -ComObject WScript.Shell
$s   = $wsh.CreateShortcut('${STARTUP_SHORTCUT.replace(/\\/g, '\\\\')}')
$s.TargetPath       = '${target.replace(/\\/g, '\\\\')}'
$s.WorkingDirectory = '${EXE_DIR.replace(/\\/g, '\\\\')}'
$s.Description      = 'AG-ON Print — Impressão Automática'
$s.Save()
`.trim();
  try {
    execSync(`powershell -NoProfile -WindowStyle Hidden -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'ignore', timeout: 15000 });
    log('[startup] atalho de inicialização criado em: ' + STARTUP_SHORTCUT);
    return true;
  } catch (e) {
    log('[startup] erro ao criar atalho: ' + e.message);
    return false;
  }
}

function removeStartupShortcut() {
  try {
    if (fs.existsSync(STARTUP_SHORTCUT)) {
      fs.unlinkSync(STARTUP_SHORTCUT);
      log('[startup] atalho de inicialização removido');
    }
  } catch (e) {
    log('[startup] erro ao remover atalho: ' + e.message);
  }
}

function hasStartupShortcut() {
  return fs.existsSync(STARTUP_SHORTCUT);
}

// ─────────────────────────────────────────────────────────────
// Mapeamento de fonte Word → ESC/POS
// ─────────────────────────────────────────────────────────────
function getFontConfig(size) {
  size = Math.max(8, Math.min(32, size || 12));
  if (size <= 12) return { height: 0, width: 0, cols: 48 };
  if (size <= 16) return { height: 1, width: 0, cols: 48 };
  if (size <= 22) return { height: 1, width: 1, cols: 24 };
  return { height: 2, width: 1, cols: 24 };
}

// ─────────────────────────────────────────────────────────────
// Formatação de cupom
// ─────────────────────────────────────────────────────────────
const fmtMoney = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
const fmtDate  = iso => new Date(iso).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

const DTYPE_LABEL = { delivery:'ENTREGA', pickup:'RETIRADA NA LOJA', scheduled_pickup:'RETIRADA AGENDADA', balcao:'BALCAO', mesa:'MESA' };
const PAY_LABEL   = { pix:'PIX', dinheiro:'Dinheiro', cartao_credito:'Cartao Credito', cartao_debito:'Cartao Debito', na_entrega:'Na Entrega', manual_pix:'PIX Manual' };

function buildCupomText(order, storeName, fontSize) {
  const { cols } = getFontConfig(fontSize);
  const center = t => ' '.repeat(Math.max(0, Math.floor((cols - t.length) / 2))) + t;
  const sep    = (c = '-') => c.repeat(cols);
  const two    = (l, r) => l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r;
  const items  = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
  const lines  = [];

  lines.push(sep('='), center(storeName.toUpperCase()));
  lines.push(center(`PEDIDO #${order.order_number || order.daily_code || '???'}`));
  lines.push(center(fmtDate(order.created_at || new Date())), sep('='));

  const dtype = DTYPE_LABEL[order.delivery_type] || (order.delivery_type||'').toUpperCase();
  lines.push(center(`[ ${dtype} ]`), '');
  lines.push(`Cliente : ${order.customer_name || '---'}`);
  if (order.customer_phone) lines.push(`Telefone: ${order.customer_phone}`);
  if (order.table_number)   lines.push(`Mesa    : ${order.table_number}`);
  if (order.delivery_type === 'delivery' && order.customer_address)
    lines.push(`Endereco: ${order.customer_address}`);
  if (order.notes) { lines.push(sep()); lines.push(`Obs: ${order.notes}`); }

  lines.push(sep(), center('ITENS'), sep());
  for (const it of items) {
    const qty   = it.quantity || 1;
    const opts  = (it.selected_options || it.options || []);
    const oNames = opts.map(op => typeof op === 'string' ? op : op.name).filter(Boolean);
    const aNames = (it.addons || []).map(a => a.name).filter(Boolean);
    const price  = (+(it.price||0) + opts.reduce((s,op)=>s + +(op.additional_price||0),0)) * qty;
    lines.push(two(`${qty}x ${it.name||'?'}`, fmtMoney(price)));
    if (it.added_by_store) lines.push('   * Adicionado pelo lojista');
    if (oNames.length)     lines.push(`   + ${oNames.join(', ')}`);
    if (aNames.length)     lines.push(`   + ${aNames.join(', ')}`);
    if (it.note)           lines.push(`   # ${it.note}`);
  }

  lines.push(sep());
  if (+order.delivery_tax > 0) lines.push(two('Entrega', fmtMoney(order.delivery_tax)));
  if (+order.discount > 0)     lines.push(two('Desconto', '- '+fmtMoney(order.discount)));
  lines.push(two('** TOTAL **', fmtMoney(order.total)));
  lines.push(two('Pagamento', PAY_LABEL[order.payment_method] || order.payment_method || '---'));
  if (order.payment_method === 'dinheiro' && order.change_for) {
    const troco = Math.max(0, +order.change_for - +order.total);
    lines.push(two('Troco para', fmtMoney(order.change_for)));
    lines.push(two('Troco devolver', fmtMoney(troco)));
  }

  lines.push(sep('='), center('Obrigado pela preferencia!'), sep('='), '', '');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Impressão ESC/POS
// ─────────────────────────────────────────────────────────────
async function printEscPos(order, storeName, printerName, copies, fontSize) {
  const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');
  const bodyFont  = getFontConfig(fontSize);
  const titleFont = getFontConfig(fontSize + 4);
  const items     = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
  const { cols }  = bodyFont;
  const two       = (l, r) => l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r;

  for (let via = 0; via < copies; via++) {
    const printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: `printer:${printerName}`,
      characterSet: CharacterSet.PC860_PORTUGUESE,
      removeSpecialCharacters: false,
      options: { timeout: 5000 },
    });

    printer.alignCenter();
    printer.setTextSize(titleFont.height, titleFont.width);
    printer.println(storeName.toUpperCase());
    printer.setTextSize(bodyFont.height, bodyFont.width);
    printer.println(`PEDIDO #${order.order_number || order.daily_code || '???'}`);
    printer.println(fmtDate(order.created_at || new Date()));
    printer.drawLine();

    const dtype = DTYPE_LABEL[order.delivery_type] || (order.delivery_type||'').toUpperCase();
    printer.bold(true); printer.println(`[ ${dtype} ]`); printer.bold(false);
    printer.newLine(); printer.alignLeft();
    printer.println(`Cliente : ${order.customer_name || '---'}`);
    if (order.customer_phone) printer.println(`Telefone: ${order.customer_phone}`);
    if (order.table_number)   printer.println(`Mesa    : ${order.table_number}`);
    if (order.delivery_type === 'delivery' && order.customer_address)
      printer.println(`Endereco: ${order.customer_address}`);
    if (order.notes) { printer.drawLine(); printer.println(`Obs: ${order.notes}`); }

    printer.drawLine(); printer.alignCenter();
    printer.bold(true); printer.println('ITENS'); printer.bold(false);
    printer.drawLine(); printer.alignLeft();

    for (const it of items) {
      const qty   = it.quantity || 1;
      const opts  = (it.selected_options || it.options || []);
      const oNames = opts.map(op => typeof op==='string'?op:op.name).filter(Boolean);
      const aNames = (it.addons||[]).map(a=>a.name).filter(Boolean);
      const price  = (+(it.price||0) + opts.reduce((s,op)=>s + +(op.additional_price||0),0)) * qty;
      printer.tableCustom([{ text:`${qty}x ${it.name||'?'}`,align:'LEFT',width:.7},{text:fmtMoney(price),align:'RIGHT',width:.3}]);
      if (it.added_by_store) printer.println('  * Adicionado pelo lojista');
      if (oNames.length)     printer.println(`  + ${oNames.join(', ')}`);
      if (aNames.length)     printer.println(`  + ${aNames.join(', ')}`);
      if (it.note)           printer.println(`  # ${it.note}`);
    }

    printer.drawLine();
    if (+order.delivery_tax > 0) printer.println(two('Entrega', fmtMoney(order.delivery_tax)));
    if (+order.discount > 0)     printer.println(two('Desconto', '- '+fmtMoney(order.discount)));
    printer.bold(true);
    printer.setTextSize(Math.min(titleFont.height,1), titleFont.width);
    printer.println(two('TOTAL', fmtMoney(order.total)));
    printer.setTextSize(bodyFont.height, bodyFont.width); printer.bold(false);
    printer.println(two('Pagamento', PAY_LABEL[order.payment_method]||order.payment_method||'---'));
    if (order.payment_method==='dinheiro'&&order.change_for) {
      const troco = Math.max(0, +order.change_for - +order.total);
      printer.println(two('Troco para', fmtMoney(order.change_for)));
      printer.bold(true); printer.println(two('Troco devolver', fmtMoney(troco))); printer.bold(false);
    }
    printer.drawLine(); printer.alignCenter();
    printer.println('Obrigado pela preferencia!'); printer.drawLine();
    printer.newLine(); printer.cut();
    await printer.execute();
  }
}

function printTextFallback(text, printerName, copies) {
  const tmp = path.join(os.tmpdir(), `agon_${Date.now()}.txt`);
  fs.writeFileSync(tmp, text.replace(/\n/g, '\r\n'), 'utf8');
  const cmd = printerName ? `print /D:"${printerName}" "${tmp}"` : `print "${tmp}"`;
  for (let i = 0; i < copies; i++) {
    try { execSync(cmd, { stdio:'ignore' }); } catch { try { execSync(`notepad /p "${tmp}"`, {stdio:'ignore'}); } catch {} }
  }
  setTimeout(() => { try { fs.unlinkSync(tmp); } catch {} }, 5000);
}

// ─────────────────────────────────────────────────────────────
// Notificação balão do Windows
// ─────────────────────────────────────────────────────────────
function showNotification(title, message) {
  // Notificação balão via PowerShell usando arquivo .ps1 temporário
  const safeTitle = (title   || '').replace(/'/g, "''");
  const safeMsg   = (message || '').replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(4000, '${safeTitle}', '${safeMsg}', [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Milliseconds 4500
$n.Dispose()
`;
  const tmpFile = path.join(os.tmpdir(), `agon_notif_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmpFile, script, 'utf8');
    require('child_process').spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', tmpFile],
      { detached: true, stdio: 'ignore' }
    ).unref();
    // Remove o arquivo após 8s (tempo suficiente para o PS ler e executar)
    setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 8000);
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// System Tray
// ─────────────────────────────────────────────────────────────
let tray = null;
let connectionStatus = 'Desconectado';
let lastOrderLabel   = '—';

const MENU_STATUS = 0;
const MENU_LAST   = 1;
const MENU_SEP1   = 2;
const MENU_LOG    = 3;
const MENU_CONFIG = 4;
const MENU_SEP2     = 5;
const MENU_AUTOSTART = 6;
const MENU_SEP3     = 7;
const MENU_EXIT     = 8;

function buildMenuItems() {
  const autostartLabel = hasStartupShortcut()
    ? '✓ Iniciar com o Windows (ativado)'
    : '  Iniciar com o Windows (desativado)';
  return [
    { title: `Status: ${connectionStatus}`,      tooltip: '', checked: false, enabled: false },
    { title: `Último pedido: ${lastOrderLabel}`, tooltip: '', checked: false, enabled: false },
    SysTray.separator,
    { title: 'Ver Log',                          tooltip: 'Abre o arquivo de log', checked: false, enabled: true },
    { title: 'Reconfigurar',                     tooltip: 'Apaga config e reinicia', checked: false, enabled: true },
    SysTray.separator,
    { title: autostartLabel,                     tooltip: 'Ativar/desativar inicialização automática', checked: false, enabled: true },
    SysTray.separator,
    { title: 'Sair',                             tooltip: 'Encerra o AG-ON Print', checked: false, enabled: true },
  ];
}

function createTray(cfg) {
  tray = new SysTray({
    menu: {
      icon:    ICON_BASE64,
      title:   '',
      tooltip: `AG-ON Print — ${cfg.store_name}`,
      items:   buildMenuItems(),
    },
    debug:   false,
    copyDir: true, // extrai o helper para %TEMP% — necessário para pkg
  });

  tray.onClick(action => {
    switch (action.seq_id) {
      case MENU_LOG:
        try { execSync(`notepad "${LOG_PATH}"`, { stdio:'ignore' }); } catch {}
        break;

      case MENU_CONFIG:
        try {
          if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
          psMessage('Configuração apagada. O programa será reiniciado.', 'AG-ON Print');
          tray.kill();
          // Reinicia o próprio processo
          const { spawn } = require('child_process');
          spawn(process.execPath, [], { detached:true, stdio:'ignore' }).unref();
          process.exit(0);
        } catch {}
        break;

      case MENU_AUTOSTART: {
        const isActive = hasStartupShortcut();
        if (isActive) {
          removeStartupShortcut();
          // Atualiza config
          try {
            const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            c.autostart = false;
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
          } catch {}
          psMessage('Inicialização automática desativada.\nO AG-ON Print não será mais iniciado com o Windows.', 'AG-ON Print');
        } else {
          createStartupShortcut();
          // Atualiza config
          try {
            const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            c.autostart = true;
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
          } catch {}
          psMessage('Inicialização automática ativada!\nO AG-ON Print será iniciado automaticamente com o Windows.', 'AG-ON Print');
        }
        // Atualiza o item do menu na bandeja
        try {
          const newLabel = hasStartupShortcut()
            ? '✓ Iniciar com o Windows (ativado)'
            : '  Iniciar com o Windows (desativado)';
          tray.sendAction({ type: 'update-item', seq_id: MENU_AUTOSTART, item: { title: newLabel, tooltip: 'Ativar/desativar inicialização automática', checked: false, enabled: true } });
        } catch {}
        break;
      }

      case MENU_EXIT:
        log('Encerrando por solicitação do usuário.');
        tray.kill();
        process.exit(0);
    }
  });

  log(`Bandeja iniciada — loja "${cfg.store_name}"`);
}

function updateTrayStatus(status) {
  connectionStatus = status;
  if (!tray) return;
  try {
    tray.sendAction({ type: 'update-item', seq_id: MENU_STATUS, item: { title: `Status: ${status}`, tooltip: '', checked: false, enabled: false } });
  } catch {}
}

function updateTrayLastOrder(label) {
  lastOrderLabel = label;
  if (!tray) return;
  try {
    tray.sendAction({ type: 'update-item', seq_id: MENU_LAST, item: { title: `Último: ${label}`, tooltip: '', checked: false, enabled: false } });
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// Socket.io — escuta de pedidos
// ─────────────────────────────────────────────────────────────
function startListening(cfg) {
  const { server_url, store_token, store_name, printer_name, copies = 1, font_size = 12 } = cfg;

  log(`Iniciando — loja: ${store_name} | servidor: ${server_url} | impressora: ${printer_name||'(log)'}`);

  const socket = io(server_url, {
    query:               { store_token },
    transports:          ['websocket', 'polling'],
    reconnection:        true,
    reconnectionDelay:   3000,
    reconnectionDelayMax: 30000,
  });

  socket.on('connect', () => {
    log(`Conectado ao servidor (${socket.id})`);
    updateTrayStatus('🟢 Conectado');
  });

  socket.on('new_order', async (order) => {
    const label = `#${order.order_number || order.daily_code || (order.id||'').slice(-6)}`;
    log(`Novo pedido: ${label} — ${order.customer_name||''}`);
    updateTrayLastOrder(`${label} — ${order.customer_name||''}`);

    // Notificação balão
    showNotification(
      'AG-ON: Novo Pedido!',
      `${label} — ${order.customer_name||'Cliente'} · ${fmtMoney(order.total)}`
    );

    // Impressão
    if (printer_name) {
      try {
        await printEscPos(order, store_name, printer_name, copies, font_size);
        log(`Impresso via ESC/POS: ${printer_name}`);
      } catch (err) {
        log(`ESC/POS falhou (${err.message}) — usando modo texto`);
        printTextFallback(buildCupomText(order, store_name, font_size), printer_name, copies);
        log(`Impresso via texto: ${printer_name}`);
      }
    } else {
      log(`[CUPOM]\n${buildCupomText(order, store_name, font_size)}`);
    }
  });

  socket.on('connect_error', err => {
    const msg = err.message || '';
    log(`Erro de conexão: ${msg}`);
    updateTrayStatus('🔴 Desconectado');
    if (msg.includes('Token inválido') || msg.includes('Unauthorized') || msg.includes('loja inativa')) {
      psMessage('Token inválido ou loja inativa.\nApague o config.json e reinicie o programa.', 'AG-ON Print — Erro');
      tray?.kill(); process.exit(1);
    }
  });

  socket.on('disconnect', reason => {
    log(`Desconectado: ${reason}`);
    updateTrayStatus('🟡 Reconectando...');
  });
}

// ─────────────────────────────────────────────────────────────
// Captura global de erros não tratados — nunca fecha sem aviso
// ─────────────────────────────────────────────────────────────
process.on('uncaughtException', err => {
  const msg = `Erro inesperado: ${err.message}\n\n${err.stack || ''}`;
  log('[uncaughtException] ' + msg);
  try {
    psMessage(`O AG-ON Print encontrou um erro inesperado e será encerrado.\n\n${err.message}\n\nConsulte o arquivo agon-print.log para detalhes.`, 'AG-ON Print — Erro Inesperado');
  } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log('[unhandledRejection] ' + msg);
  try {
    psMessage(`Erro interno no AG-ON Print.\n\n${msg}\n\nConsulte o arquivo agon-print.log para detalhes.`, 'AG-ON Print — Erro');
  } catch {}
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
(async () => {
  log(`Iniciando AG-ON Print — EXE_DIR: ${EXE_DIR}`);
  log(`CONFIG_PATH: ${CONFIG_PATH}`);

  let cfg = loadConfig();

  if (!cfg) {
    log('Nenhuma configuração válida encontrada — iniciando wizard');
    cfg = await runSetupWizard();
  }

  // Garante que o launcher VBS exista (para futuros usos sem terminal)
  createVbsLauncher();

  // Inicia a bandeja do sistema ANTES de conectar o socket
  createTray(cfg);

  // Pequena pausa para a bandeja inicializar
  await new Promise(r => setTimeout(r, 800));

  startListening(cfg);
})();
