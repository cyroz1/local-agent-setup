<#
.SYNOPSIS
  PC vision server: serves UI-TARS 1.5 7B on port 8081 for the UI-TARS
  Desktop app running on the Mac (computer use, controlled from the Air,
  computed here).

  16GB reality check: stop the coding server first (start-server-pc.ps1).
  Both models at once will crawl. Run one at a time.

  In UI-TARS Desktop on the Mac, set the custom VLM endpoint to:
    Base URL : http://<this-pc>:8081/v1
    API key  : the contents of api-key.txt
    Model    : ui-tars-1.5-7b
#>

$ErrorActionPreference = 'Stop'

$InstallRoot = "$env:LOCALAPPDATA\local-agent"
$ServerExe   = Join-Path $InstallRoot 'llama.cpp\llama-server.exe'
$KeyFile     = Join-Path $InstallRoot 'api-key.txt'
$ModelRepo   = 'Mungert/UI-TARS-1.5-7B-GGUF:Q4_K_M'
$ModelAlias  = 'ui-tars-1.5-7b'
$Port        = 8081

if (-not (Test-Path $ServerExe)) { Write-Host 'llama-server not found. Run setup-pc-server.ps1 first.' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $KeyFile))   { Write-Host 'api-key.txt not found. Run setup-pc-server.ps1 first.' -ForegroundColor Red; exit 1 }
$ApiKey = (Get-Content $KeyFile -Raw).Trim()

try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 2
    if ($h.status -eq 'ok') {
        Write-Host 'WARNING: the coding server is running on port 8080.' -ForegroundColor Yellow
        Write-Host 'On a 16GB card, stop it first or the vision model will crawl.'
        Write-Host ''
    }
} catch { }

try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 2
    if ($h.status -eq 'ok') { Write-Host 'Vision server already running on port 8081.' -ForegroundColor Green; exit 0 }
} catch { }

Write-Host 'Starting PC vision server (first run downloads ~5GB)...' -ForegroundColor Cyan
Write-Host 'Leave this window open. Ctrl+C stops the server.'
Write-Host ''

& $ServerExe `
    -hf $ModelRepo `
    --alias $ModelAlias `
    --host 0.0.0.0 --port $Port `
    -c 32768 --jinja `
    -ngl 99 `
    -fa on `
    --api-key $ApiKey
