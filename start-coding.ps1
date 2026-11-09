<#
.SYNOPSIS
  Starts the local coding model server (llama.cpp) tuned for a 16GB AMD card.
  Leave this window open while you work; close it to stop the server.
  Then, in your project folder, run:  opencode

  Tuning notes:
    The model is dense 7B at Q5_K_M (~6.6GB), so -ngl 99 puts every layer
    on the GPU with room to spare. Nothing is offloaded.
    -c 65536      context size, KV cache at q8_0, one slot. Cache size is
                  what decides whether everything stays in VRAM; at this
                  model size there is room to spare even at 64K.
    Speculative   n-gram speculation: the server reuses patterns from the
    decoding      context itself to draft tokens and the 7B verifies them
                  in batches (biggest single speed win on code, ~1.5-2x).
                  A draft-model variant exists but the K2 0.9B GGUF's
                  tokenizer metadata fails llama.cpp's vocab check
                  against the 7B, so ngram is the working route. The
                  flags are probed against this build's --help first,
                  so an llama.cpp update can never break startup.
    -ub 1024      bigger prompt micro-batch: faster prompt processing,
                  which is the AMD weak side.
    --no-mmproj   skips the vision projector (about 1GB); pointless for code.
    --no-reasoning-preserve
                  the model's old thinking is not re-fed in later turns,
                  so long agent sessions stop paying for it in context.
#>

$ErrorActionPreference = 'Stop'

$InstallRoot = "$env:LOCALAPPDATA\local-agent"
$ServerExe   = Join-Path $InstallRoot 'llama.cpp\llama-server.exe'
$ModelRepo   = 'IFM/K2-Horizon-7B-GGUF:Q5_K_M'
$ModelAlias  = 'k2-horizon-7b'
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

# Optional speed flags, probed against this build's --help so a llama.cpp
# update can never kill startup with an unknown argument. Native-command
# stderr under ErrorActionPreference=Stop becomes a fake fatal error in
# PS 5.1, so the probe runs under Continue inside try/catch (again).
$extraArgs = @()
try {
    $ErrorActionPreference = 'Continue'
    $helpText = (& $ServerExe --help 2>&1 | Out-String)
} catch { $helpText = '' }
$ErrorActionPreference = 'Stop'
# ngram first, draft model only as fallback: the K2 0.9B GGUF's tokenizer
# metadata does not match the 7B's (bos/vocab check), and llama.cpp
# refuses draft speculation for the pair (verified on this machine,
# 2026-11-09). Ngram speculation needs no second model at all.
if ($helpText -match 'ngram-mod') {
    $extraArgs += @('--spec-type', 'ngram-mod')
    Write-Host 'Speculative decoding: on (ngram, no draft model)'
} elseif ($helpText -match 'hf-repo-draft') {
    $extraArgs += @('--spec-type', 'draft-simple',
                    '--hf-repo-draft', 'IFM/K2-Horizon-0.9B-GGUF:Q4_K_M',
                    '--spec-draft-n-max', '6', '--spec-draft-ngl', '99')
    Write-Host 'Speculative decoding: on (K2 0.9B draft model, first run downloads ~0.7GB)'
}
if ($helpText -match 'no-reasoning-preserve') {
    $extraArgs += '--no-reasoning-preserve'
}
# Force K2's JSON tool-call format server-side. Its native XML format
# intermittently leaks through llama.cpp's parser as raw <|ifm|> text,
# which ends the agent's turn mid-task with no tool executed (seen live
# 2026-11-09). JSON is the format llama.cpp parses reliably. The value
# goes through the env var, NOT the --chat-template-kwargs argument:
# PowerShell 5.1 strips double quotes from native arguments, mangling
# the JSON into {tool_call_format:json}, which llama.cpp rejects at
# startup (also seen live 2026-11-09). Builds too old to know the env
# var simply ignore it.
$env:LLAMA_ARG_CHAT_TEMPLATE_KWARGS = '{"tool_call_format":"json"}'
Write-Host 'Tool call format: json (avoids raw XML tool-call leaks)'

& $ServerExe `
    -hf $ModelRepo `
    --alias $ModelAlias `
    --host 127.0.0.1 --port $Port `
    -c 65536 --jinja `
    -ngl 99 `
    -fa on `
    -ub 1024 `
    --cache-type-k q8_0 --cache-type-v q8_0 --no-mmproj --parallel 1 `
    --repeat-penalty 1.08 `
    @extraArgs
