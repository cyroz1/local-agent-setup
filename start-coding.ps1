<#
.SYNOPSIS
  Starts the local coding model server (llama.cpp) tuned for a 16GB AMD card.
  Leave this window open while you work; close it to stop the server.
  Then, in your project folder, run:  opencode

  Tuning notes:
    The model is dense 24B at Q4_K_M (~14GB), so -ngl 99 puts every layer
    on the GPU and there is still room for the 64K context below. Nothing
    is offloaded to the CPU.
    -c 32768      context size, with the KV cache at q4_0 and one slot.
                  This matters: at 64K with a q8_0 cache the KV cache alone
                  was ~5GB, which pushed the model partly off the GPU and
                  tanked speed. 32K/q4_0 keeps everything in VRAM.
    --no-mmproj   skips the vision projector (about 1GB); pointless for code.
    --spec-type   add "--spec-type ngram-mod" if your llama.cpp build supports
                  it; it speeds up agentic and code-completion style output.
#>

$ErrorActionPreference = 'Stop'

$InstallRoot = "$env:LOCALAPPDATA\local-agent"
$ServerExe   = Join-Path $InstallRoot 'llama.cpp\llama-server.exe'
$ModelRepo   = 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:Q4_K_M'
$ModelAlias  = 'devstral-small-2'
$Port        = 8080

if (-not (Test-Path $ServerExe)) {
    Write-Host 'llama-server not found. Run setup-local-agent.ps1 first.' -ForegroundColor Red
    exit 1
}

# Already running? Then there is nothing to do.
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    if ($h.status -eq 'ok') {
        Write-Host 'Local model server is already running on port 8080. Just run: opencode' -ForegroundColor Green
        exit 0
    }
} catch { }

Write-Host 'Starting local model server (first load takes a bit)...' -ForegroundColor Cyan
Write-Host 'Leave this window open. Press Ctrl+C to stop the server when you are done.'
Write-Host ''

& $ServerExe `
    -hf $ModelRepo `
    --alias $ModelAlias `
    --host 127.0.0.1 --port $Port `
    -c 32768 --jinja `
    -ngl 99 `
    -fa on `
    --cache-type-k q4_0 --cache-type-v q4_0 --no-mmproj --parallel 1
