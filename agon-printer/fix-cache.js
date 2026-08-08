/**
 * fix-cache.js — executa antes do electron-builder build
 *
 * Problema: electron-builder baixa o winCodeSign-2.6.0.7z e tenta extrair
 * dois symlinks de macOS (libcrypto.dylib / libssl.dylib) que o Windows não
 * consegue criar sem o Modo Desenvolvedor ativado.
 * O 7zip retorna exit-code 2 (erro parcial) e o builder entra em loop de retry.
 *
 * Solução: extraímos o cache manualmente (ignorando exit-code 2) e criamos
 * arquivos placeholder onde os symlinks falharam. O electron-builder encontra
 * o cache já populado e pula o download nas próximas execuções.
 */

'use strict';

const https    = require('https');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { spawnSync } = require('child_process');

const VERSION   = 'winCodeSign-2.6.0';
const CACHE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'electron-builder', 'Cache', 'winCodeSign', VERSION
);
const SIGNTOOL  = path.join(CACHE_DIR, 'windows-10', 'x64', 'signtool.exe');
const DOWNLOAD_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`;

// Symlinks macOS que o 7zip não consegue criar no Windows sem Developer Mode
const SYMLINK_PLACEHOLDERS = [
  'darwin/10.12/lib/libcrypto.dylib',
  'darwin/10.12/lib/libssl.dylib',
];

async function main() {
  if (fs.existsSync(SIGNTOOL)) {
    console.log('[fix-cache] winCodeSign OK — cache já existe, pulando.');
    return;
  }

  console.log('[fix-cache] Cache winCodeSign não encontrado — preparando...');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // ── Download ──────────────────────────────────────────────
  const tmpZip = path.join(os.tmpdir(), `${VERSION}-${Date.now()}.7z`);
  console.log(`[fix-cache] Baixando ${VERSION}.7z...`);
  await download(DOWNLOAD_URL, tmpZip);
  console.log('[fix-cache] Download concluído.');

  // ── Extração (ignora exit-code 2 = erros de symlinks) ────
  // 7za.exe fica em node_modules/7zip-bin após instalar electron-builder
  const sevenZip = findSevenZip();
  if (!sevenZip) {
    console.warn('[fix-cache] 7za.exe não encontrado — instale electron-builder primeiro.');
    cleanup(tmpZip);
    return;
  }

  console.log('[fix-cache] Extraindo (erros de symlinks serão ignorados)...');
  const result = spawnSync(sevenZip, ['x', tmpZip, `-o${CACHE_DIR}`, '-y'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  // exit code 2 = "arquivos com erros" — os outros arquivos foram extraídos
  if (result.status !== 0 && result.status !== 2) {
    console.error('[fix-cache] Extração falhou (exit ' + result.status + ')');
    console.error(result.stderr || result.stdout || '');
    cleanup(tmpZip);
    return;
  }

  // ── Placeholders para os symlinks que falharam ───────────
  for (const rel of SYMLINK_PLACEHOLDERS) {
    const full = path.join(CACHE_DIR, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(full)) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.alloc(0));
      console.log('[fix-cache] Placeholder criado: ' + rel);
    }
  }

  cleanup(tmpZip);

  // Verifica qualquer signtool.exe no cache
  const hasSign = fs.existsSync(SIGNTOOL)
    || fs.existsSync(path.join(CACHE_DIR, 'windows-6', 'x64', 'signtool.exe'));
  if (hasSign || fs.existsSync(path.join(CACHE_DIR, 'rcedit-x64.exe'))) {
    console.log('[fix-cache] ✓ Cache corrigido com sucesso!');
  } else {
    console.warn('[fix-cache] signtool.exe não encontrado — o build pode falhar.');
  }
}

function findSevenZip() {
  // electron-builder instala o 7zip-bin como dependência indireta
  const candidates = [
    path.join(__dirname, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(__dirname, 'node_modules', 'electron-builder', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function cleanup(file) {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = (u) => https.get(u, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        // Reabre o stream e segue o redirect
        const newFile = fs.createWriteStream(dest);
        https.get(res.headers.location, r2 => {
          r2.pipe(newFile);
          newFile.on('finish', () => { newFile.close(); resolve(); });
        }).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { cleanup(dest); reject(err); });
    req(url);
  });
}

main().catch(e => {
  console.error('[fix-cache] Erro:', e.message);
  // Não aborta o build — deixa o electron-builder tentar e mostrar o erro real
});
