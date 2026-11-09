<#
.SYNOPSIS
  Serves the UI-TARS 1.5 7B vision model locally on port 8081. Two
  consumers use this endpoint:

    * OpenCode's computer-use MCP bridge (the main way): the bridge
      screenshots the desktop, sends the image here, and gets back
      coordinates it clicks. This server just needs to be running.
    * UI-TARS Desktop, standalone: point the app at this endpoint in its
      settings (Base URL http://127.0.0.1:8081/v1, API key anything,
      Model ui-tars-1.5-7b) and give it tasks in the app itself.

  16GB card note: the 7B coder (~5.6GB) and this vision model (~5GB) fit
  at the same time, so both servers can stay up (start-agent.ps1 starts
  both). Expect some slowdown while both are busy.

  Watch the first runs either way: local computer use is a tier below the
  frontier cloud agents, fine for simple GUI tasks, not something to
  leave unattended with anything destructive open.
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

# The coding server being up at the same time is fine now (both models
# fit in 16GB); it only costs some speed while both are busy.
try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2
    if ($h.status -eq 'ok') {
        Write-Host 'Note: the coding server is also running on port 8080.' -ForegroundColor Yellow
        Write-Host 'That is fine (both models fit in 16GB); expect some slowdown while both are busy.'
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
