@echo off
REM ─────────────────────────────────────────────────────────────
REM  AG-ON — Atalho do Chrome com impressão silenciosa
REM  Coloque este arquivo na Área de Trabalho do computador caixa.
REM  Ele abre o painel já configurado para imprimir SEM diálogo.
REM ─────────────────────────────────────────────────────────────

set URL=https://seudominio.com/loja

REM Caminho padrão do Chrome — ajuste se necessário
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

start "" %CHROME% --kiosk-printing --app=%URL%
