<#
.SYNOPSIS
  PC compute server: serves the coding model to the Mac over the LAN.
  Leave this window open while you work from the Air; Ctrl+C stops it.
  The Mac runs OpenCode and points at http://<this-pc>:8080/v1 with the
  API key from api-key.txt.

  The model is dense 7B at Q5_K_M (~6.6GB), fully on the GPU (-ngl 99),
  nothing offloaded to the CPU.
#>

$ErrorActionPreference = 'Stop'

$InstallRoot = "$env:LOCALAPPDATA\local-agent"
$ServerExe   = Join-Path $InstallRoot 'llama.cpp\llama-server.exe'
$KeyFile     = Join-Path $InstallRoot 'api-key.txt'
$ModelRepo   = 'IFM/K2-Horizon-7B-GGUF:Q5_K_M'
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

# Optional speed flags, probed against this build's --help (same approach
# as start-coding.ps1): speculative decoding + no-reasoning-preserve.
$extraArgs = @()
try {
    $ErrorActionPreference = 'Continue'
    $helpText = (& $ServerExe --help 2>&1 | Out-String)
} catch { $helpText = '' }
$ErrorActionPreference = 'Stop'
# ngram first, draft model only as fallback: the K2 0.9B GGUF's tokenizer
# metadata does not match the 7B's (bos/vocab check), and llama.cpp
# refuses draft speculation for the pair (verified 2026-11-09). Ngram
# speculation needs no second model at all.
if ($helpText -match 'ngram-mod') {
    $extraArgs += @('--spec-type', 'ngram-mod')
    Write-Host 'Speculative decoding: on (ngram, no draft model)'
} elseif ($helpText -match 'hf-repo-draft') {
    $extraArgs += @('--spec-type', 'draft-simple',
                    '--hf-repo-draft', 'IFM/K2-Horizon-0.9B-GGUF:Q4_K_M',
                    '--spec-draft-n-max', '6', '--spec-draft-ngl', '99')
    Write-Host 'Speculative decoding: on (K2 0.9B draft model)'
}
if ($helpText -match 'no-reasoning-preserve') {
    $extraArgs += '--no-reasoning-preserve'
}

& $ServerExe `
    -hf $ModelRepo `
    --alias $ModelAlias `
    --host 0.0.0.0 --port $Port `
    -c 65536 --jinja `
    -ngl 99 `
    -fa on `
    -ub 1024 `
    --cache-type-k q8_0 --cache-type-v q8_0 --no-mmproj --parallel 1 `
    --repeat-penalty 1.08 `
    --api-key $ApiKey `
    @extraArgs
