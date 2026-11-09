<#
.SYNOPSIS
  Starts the local coding model server (llama.cpp) tuned for a 16GB AMD card.
  Leave this window open while you work; close it to stop the server.
  Then, in your project folder, run:  opencode

  Tuning notes:
    The model is dense 14B at Q4_K_M (~9GB), so -ngl 99 puts every layer
    on the GPU and there is still room for the 64K context below. Nothing
    is offloaded to the CPU.
    -c 65536      context size, KV cache at q4_0 (~2.8GB at 64K), one slot.
                  Cache size is what decides whether everything stays in
                  VRAM: with the old 24B model a big cache pushed layers
                  into system RAM and killed speed. At 14B there is room
                  to spare, so the full 64K is back.
    --no-mmproj   skips the vision projector (about 1GB); pointless for code.
    --spec-type   add "--spec-type ngram-mod" if your llama.cpp build supports
                  it; it speeds up agentic and code-completion style output.
#>

$ErrorActionPreference = 'Stop'

$InstallRoot = "$env:LOCALAPPDATA\local-agent"
$ServerExe   = Join-Path $InstallRoot 'llama.cpp\llama-server.exe'
$ModelRepo   = 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF:Q4_K_M'
$ModelAlias  = 'qwen2.5-coder-14b'
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
    -c 65536 --jinja `
    -ngl 99 `
    -fa on `
    --cache-type-k q4_0 --cache-type-v q4_0 --no-mmproj --parallel 1
