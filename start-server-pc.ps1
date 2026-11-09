<#
.SYNOPSIS
  PC compute server: serves the coding model to the Mac over the LAN.
  Leave this window open while you work from the Air; Ctrl+C stops it.
  The Mac runs OpenCode and points at http://<this-pc>:8080/v1 with the
  API key from api-key.txt.

  The model is dense 7B at Q4_K_M (~5.6GB), fully on the GPU (-ngl 99),
  nothing offloaded to the CPU.
#>

$ErrorActionPreference = 'Stop'

$InstallRoot = "$env:LOCALAPPDATA\local-agent"
$ServerExe   = Join-Path $InstallRoot 'llama.cpp\llama-server.exe'
$KeyFile     = Join-Path $InstallRoot 'api-key.txt'
$ModelRepo   = 'IFM/K2-Horizon-7B-GGUF:Q4_K_M'
$ModelAlias  = 'k2-horizon-7b'
$Port        = 8080

if (-not (Test-Path $ServerExe)) { Write-Host 'llama-server not found. Run setup-pc-server.ps1 first.' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $KeyFile))   { Write-Host 'api-key.txt not found. Run setup-pc-server.ps1 first.' -ForegroundColor Red; exit 1 }
$ApiKey = (Get-Content $KeyFile -Raw).Trim()

try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 2
    if ($h.status -eq 'ok') { Write-Host 'Coding server already running on port 8080.' -ForegroundColor Green; exit 0 }
} catch { }

$lanIps = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress
Write-Host 'Starting PC coding server. Reachable from the Mac at:' -ForegroundColor Cyan
foreach ($ip in $lanIps) { Write-Host "  http://${ip}:$Port/v1" }
Write-Host 'Leave this window open. Ctrl+C stops the server.'
Write-Host ''

& $ServerExe `
    -hf $ModelRepo `
    --alias $ModelAlias `
    --host 0.0.0.0 --port $Port `
    -c 65536 --jinja `
    -ngl 99 `
    -fa on `
    --cache-type-k q8_0 --cache-type-v q8_0 --no-mmproj --parallel 1 `
    --api-key $ApiKey
