<#
.SYNOPSIS
  Serves the UI-TARS 1.5 7B vision model locally so UI-TARS Desktop can do
  computer use with zero cloud calls.

  IMPORTANT, 16GB card reality check: stop the coding server first
  (start-coding.ps1). The coder and the vision model do not run well at the
  same time on 16GB of VRAM. Run one or the other.

  After this server is up:
    1. Open UI-TARS Desktop.
    2. In its settings, choose a custom / local VLM endpoint and enter:
         Base URL : http://127.0.0.1:8081/v1
         API key  : local   (anything non-empty works, the server ignores it)
         Model    : ui-tars-1.5-7b
    3. Give it a task in plain words. It sees screenshots and drives the
       mouse and keyboard. Watch the first runs: local computer use is a
       tier below the frontier cloud agents, fine for simple GUI tasks,
       not something to leave unattended with anything destructive open.
#>

$ErrorActionPreference = 'Stop'

$InstallRoot = "$env:LOCALAPPDATA\local-agent"
$ServerExe   = Join-Path $InstallRoot 'llama.cpp\llama-server.exe'
$ModelRepo   = 'Mungert/UI-TARS-1.5-7B-GGUF:Q4_K_M'
$ModelAlias  = 'ui-tars-1.5-7b'
$Port        = 8081

if (-not (Test-Path $ServerExe)) {
    Write-Host 'llama-server not found. Run setup-local-agent.ps1 first.' -ForegroundColor Red
    exit 1
}

# Warn if the coding server is holding the GPU.
try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2
    if ($h.status -eq 'ok') {
        Write-Host 'WARNING: the coding server is running on port 8080.' -ForegroundColor Yellow
        Write-Host 'On a 16GB card, stop it first (close its window) or UI-TARS will crawl.'
        Write-Host ''
    }
} catch { }

try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    if ($h.status -eq 'ok') {
        Write-Host 'UI-TARS model server is already running on port 8081.' -ForegroundColor Green
        exit 0
    }
} catch { }

Write-Host 'Starting UI-TARS vision model (first run downloads ~5GB)...' -ForegroundColor Cyan
Write-Host 'Leave this window open. Press Ctrl+C to stop.'
Write-Host ''

& $ServerExe `
    -hf $ModelRepo `
    --alias $ModelAlias `
    --host 127.0.0.1 --port $Port `
    -c 32768 --jinja `
    -ngl 99 `
    -fa on
