<#
.SYNOPSIS
  Local agentic coding stack for a 16GB AMD card (RX 7900 GRE class):
  llama.cpp (Vulkan) + Devstral Small 2 24B (dense) + OpenCode + browser-use
  MCP servers + optional UI-TARS computer use.

.DESCRIPTION
  Non-interactive and idempotent. Safe to re-run: every step checks state first,
  optional steps are individually guarded so one failure does not kill the run,
  and the whole run is logged to a file.

  What it does:
    1. Installs Git and Node.js LTS via winget (skips whatever is already present).
    2. Downloads the latest llama.cpp Windows Vulkan build from GitHub and puts
       it in $InstallRoot\llama.cpp (added to your user PATH).
    3. Prefetches the coding model (first run of the server downloads ~14GB from
       Hugging Face) and smoke-tests the server on http://127.0.0.1:8080.
    4. Installs OpenCode (npm) and writes a global opencode.json that points it
       at the local server and registers the Playwright + Chrome DevTools MCP
       servers (browser use). An existing config is backed up, never clobbered.
    5. Optional (-SkipComputerUse to skip): downloads the UI-TARS Desktop
       installer and explains the computer-use pieces. The installer exe is
       downloaded only, not auto-run, and the UI-TARS model is served on demand
       by start-computer-use.ps1.

  The model is Devstral Small 2 (24B, dense, built by Mistral specifically
  for agentic coding). At Q4_K_M it is ~14GB, so it loads entirely into the
  7900 GRE's 16GB of VRAM with room left for context. No CPU offloading,
  no MoE tricks.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-local-agent.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-local-agent.ps1 -SkipComputerUse
#>

[CmdletBinding()]
param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\local-agent",
    # Any llama.cpp -hf repo:quant works here.
    [string]$ModelRepo   = "unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:Q4_K_M",
    [string]$ModelAlias  = "devstral-small-2",
    [int]$Port           = 8080,
    [switch]$SkipComputerUse
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # speeds up Invoke-WebRequest a lot

$LogDir  = Join-Path $InstallRoot 'logs'
New-Item -ItemType Directory -Force -Path $InstallRoot, $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("setup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $LogFile -Append | Out-Null

function Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Note([string]$msg) { Write-Host "  $msg" }
function Warn([string]$msg) { Write-Host "  WARNING: $msg" -ForegroundColor Yellow }

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Test-Cmd([string]$name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

try {

Step 'System check'
$os = Get-CimInstance Win32_OperatingSystem
Note "OS: $($os.Caption) build $($os.BuildNumber)"
$gpus = Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
Note "GPU(s): $($gpus -join ', ')"
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($InstallRoot).Substring(0,1))
$freeGb = [math]::Round($drive.Free / 1GB, 1)
Note "Free space on install drive: $freeGb GB"
if ($freeGb -lt 30) { Warn "Under 30GB free. The coder model alone is ~14GB, UI-TARS adds ~5GB. Free space or pass -InstallRoot on a bigger drive." }

# ---------------------------------------------------------------- winget apps
Step 'Git and Node.js (winget)'
if (-not (Test-Cmd 'winget')) { throw 'winget not found. Install "App Installer" from the Microsoft Store, then re-run.' }

foreach ($pkg in @(@{ Id = 'Git.Git'; Cmd = 'git' }, @{ Id = 'OpenJS.NodeJS.LTS'; Cmd = 'node' })) {
    if (Test-Cmd $pkg.Cmd) { Note "$($pkg.Cmd) already installed, skipping."; continue }
    Note "Installing $($pkg.Id)..."
    winget install --id $pkg.Id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
    if (-not (Test-Cmd $pkg.Cmd)) { throw "$($pkg.Id) installed but $($pkg.Cmd) is still not on PATH. Open a new terminal and re-run this script." }
}
Note "git  : $(git --version)"
Note "node : $(node --version)"
Note "npm  : $(npm --version)"

# ---------------------------------------------------------------- llama.cpp
Step 'llama.cpp (Vulkan build)'
$LlamaDir    = Join-Path $InstallRoot 'llama.cpp'
$ServerExe   = Join-Path $LlamaDir 'llama-server.exe'
$DownloadsDir = Join-Path $InstallRoot 'downloads'
New-Item -ItemType Directory -Force -Path $LlamaDir, $DownloadsDir | Out-Null

if (Test-Path $ServerExe) {
    Note "llama-server already present, skipping download. Delete $LlamaDir to force a fresh copy."
} else {
    Note 'Asking GitHub for the latest llama.cpp release...'
    $headers = @{ 'User-Agent' = 'local-agent-setup' }
    # /releases/latest is unreliable for llama.cpp: the builds ship as
    # prereleases and the latest pointer can land on a tag-only release whose
    # only asset is nightly-tag.txt (that broke this step on 2026-11-09).
    # Scan recent releases and take the first one that actually carries the
    # Windows Vulkan x64 zip.
    $releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10' -Headers $headers
    $asset = $null
    $pickedTag = $null
    foreach ($rel in $releases) {
        $candidate = $rel.assets | Where-Object { $_.name -match 'win' -and $_.name -match 'vulkan' -and $_.name -match 'x64' -and $_.name -like '*.zip' } | Select-Object -First 1
        if ($candidate) { $asset = $candidate; $pickedTag = $rel.tag_name; break }
    }
    if (-not $asset) {
        Write-Host 'Could not find a Windows Vulkan x64 zip in the 10 most recent llama.cpp releases.' -ForegroundColor Red
        throw 'Asset detection failed. Nothing was changed for this step.'
    }
    Note "llama.cpp release $pickedTag"
    $zipPath = Join-Path $DownloadsDir $asset.name
    Note "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers $headers
    Expand-Archive -Path $zipPath -DestinationPath $LlamaDir -Force
    # Some zips nest a folder; flatten if llama-server.exe ended up one level down.
    if (-not (Test-Path $ServerExe)) {
        $nested = Get-ChildItem -Path $LlamaDir -Recurse -Filter 'llama-server.exe' | Select-Object -First 1
        if ($nested) {
            Copy-Item -Path (Join-Path $nested.DirectoryName '*') -Destination $LlamaDir -Recurse -Force
        }
    }
    if (-not (Test-Path $ServerExe)) { throw "llama-server.exe not found after extracting $($asset.name)." }
}
$ErrorActionPreference = 'Continue'
$versionLine = (& $ServerExe --version 2>&1 | Select-Object -First 1)
$ErrorActionPreference = 'Stop'
Note "llama.cpp: $versionLine"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$LlamaDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$LlamaDir", 'User')
    Note "Added $LlamaDir to your user PATH (new terminals will see it)."
}
Refresh-Path

# ------------------------------------------------- model prefetch + smoke test
Step 'Model prefetch and server smoke test'
$serverArgs = @(
    '-hf', $ModelRepo,
    '--alias', $ModelAlias,
    '--host', '127.0.0.1', '--port', "$Port",
    '-c', '65536', '--jinja',
    '-ngl', '99',
    '-fa', 'on',
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'
)
$serverLog = Join-Path $LogDir 'llama-server-first-run.log'
Note "Starting llama-server to download the model (this is the big one, ~14GB)..."
Note "Live download progress: $serverLog"
$proc = Start-Process -FilePath $ServerExe -ArgumentList $serverArgs -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"
try {
    $deadline = (Get-Date).AddMinutes(90)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { throw "llama-server exited early (code $($proc.ExitCode)). See $serverLog.err" }
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($h.status -eq 'ok') { $healthy = $true; break }
        } catch { Start-Sleep -Seconds 5 }
    }
    if (-not $healthy) { throw "Server did not become healthy within 90 minutes. See $serverLog and $serverLog.err" }
    Note 'Server is up. Running one real completion as a smoke test...'
    $body = @{
        model = $ModelAlias
        messages = @(@{ role = 'user'; content = 'Reply with exactly: local agent ok' })
        max_tokens = 32
    } | ConvertTo-Json -Depth 5
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 180
    Note "Model replied: $($resp.choices[0].message.content)"
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Note 'Smoke-test server stopped. Use start-coding.ps1 for real sessions.'
}

# ---------------------------------------------------------------- OpenCode
Step 'OpenCode'
# Installed from the standalone GitHub release zip, not npm: npm 12 blocks
# opencode-ai's postinstall (which fetches the platform binary) and leaves a
# broken opencode.exe behind, and the --allow-scripts flag did not save it
# either (both hit on 2026-11-09). The release zip is the real binary, no
# install scripts involved.
$OpencodeDir = Join-Path $InstallRoot 'opencode'
$OpencodeExe = Join-Path $OpencodeDir 'opencode.exe'
$opencodeOk = $false
$probe = $null
if (Test-Cmd 'opencode') {
    # A broken shim (the npm leftover) fails with a terminating error that
    # ErrorActionPreference=Continue does NOT contain; only try/catch does.
    # That unguarded probe is what stopped the run on 2026-11-09.
    try {
        $ErrorActionPreference = 'Continue'
        $probe = opencode --version 2>$null
    } catch { $probe = $null }
    $ErrorActionPreference = 'Stop'
    if ($probe) { $opencodeOk = $true }
}
if ($opencodeOk) {
    Note "opencode already installed ($probe), skipping."
} else {
    # A broken npm copy would shadow the real binary on PATH. Remove it.
    if (Test-Cmd 'npm') {
        Note 'Removing any broken npm copy of opencode-ai so it cannot shadow the real binary...'
        $ErrorActionPreference = 'Continue'
        npm uninstall -g opencode-ai 2>$null | Out-Null
        $ErrorActionPreference = 'Stop'
        Refresh-Path
    }
    New-Item -ItemType Directory -Force -Path $OpencodeDir | Out-Null
    if (-not (Test-Path $OpencodeExe)) {
        $headers = @{ 'User-Agent' = 'local-agent-setup' }
        $ocRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/anomalyco/opencode/releases/latest' -Headers $headers
        $ocAsset = $ocRelease.assets | Where-Object { $_.name -eq 'opencode-windows-x64.zip' } | Select-Object -First 1
        if (-not $ocAsset) { throw 'opencode-windows-x64.zip not found on the latest OpenCode release.' }
        $ocZip = Join-Path $DownloadsDir $ocAsset.name
        Note "Downloading $($ocAsset.name) ($([math]::Round($ocAsset.size / 1MB)) MB)..."
        Invoke-WebRequest -Uri $ocAsset.browser_download_url -OutFile $ocZip -Headers $headers
        Expand-Archive -Path $ocZip -DestinationPath $OpencodeDir -Force
        if (-not (Test-Path $OpencodeExe)) {
            $nestedExe = Get-ChildItem -Path $OpencodeDir -Recurse -Filter 'opencode.exe' | Select-Object -First 1
            if ($nestedExe) { Copy-Item -Path (Join-Path $nestedExe.DirectoryName '*') -Destination $OpencodeDir -Recurse -Force }
        }
        if (-not (Test-Path $OpencodeExe)) { throw 'opencode.exe not found after extracting the release zip.' }
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$OpencodeDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$OpencodeDir", 'User')
        Note "Added $OpencodeDir to your user PATH (new terminals will see it)."
    }
    Refresh-Path
}
if (-not (Test-Cmd 'opencode')) { throw 'OpenCode installed but not on PATH. Open a new terminal and re-run.' }
try {
    $ErrorActionPreference = 'Continue'
    $finalProbe = opencode --version 2>$null
} catch { $finalProbe = $null }
$ErrorActionPreference = 'Stop'
if (-not $finalProbe) { throw 'OpenCode is installed but still does not run. Open a new terminal and re-run this setup.' }
Note "opencode: $finalProbe"

# ------------------------------------------------------- opencode.json config
Step 'OpenCode config (provider + browser-use MCP servers)'
$ConfigDir  = Join-Path $HOME '.config\opencode'
$ConfigPath = Join-Path $ConfigDir 'opencode.json'
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
if (Test-Path $ConfigPath) {
    $backup = "$ConfigPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $ConfigPath $backup
    Note "Existing opencode.json backed up to $backup"
}
$config = @'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "model": "llama.cpp/devstral-small-2",
  "small_model": "llama.cpp/devstral-small-2",
  "enabled_providers": ["llama.cpp"],
  "provider": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama.cpp (local)",
      "options": { "baseURL": "http://127.0.0.1:8080/v1" },
      "models": {
        "devstral-small-2": {
          "name": "Devstral Small 2 24B (local)",
          "limit": { "context": 65536, "output": 8192 }
        }
      }
    }
  },
  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp@latest"],
      "enabled": true
    },
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"],
      "enabled": true
    }
  }
}
'@
Set-Content -Path $ConfigPath -Value $config -Encoding UTF8
# Re-write without a BOM: some JSON parsers choke on one, and PS 5.1 adds it.
[IO.File]::WriteAllText($ConfigPath, $config, (New-Object Text.UTF8Encoding $false))
Note "Wrote $ConfigPath"

Step 'Warming up the MCP servers (first npx download happens now, not mid-session)'
foreach ($pkgName in '@playwright/mcp@latest', 'chrome-devtools-mcp@latest') {
    try {
        npx -y $pkgName --version 2>&1 | Out-Null
        Note "$pkgName ready."
    } catch {
        Warn "$pkgName warm-up failed ($($_.Exception.Message)). It will retry on first use inside OpenCode."
    }
}
try {
    Note 'Making sure a Chromium build exists for the Playwright MCP...'
    npx -y playwright@latest install chromium 2>&1 | Out-Host
} catch {
    Warn "Playwright Chromium install failed ($($_.Exception.Message)). The MCP can also drive your installed Chrome; check its docs if browser use errors."
}

# ------------------------------------------------------------- UI-TARS (opt.)
if (-not $SkipComputerUse) {
    Step 'Computer use: UI-TARS Desktop (optional, guarded)'
    try {
        $headers = @{ 'User-Agent' = 'local-agent-setup' }
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/bytedance/UI-TARS-desktop/releases/latest' -Headers $headers
        $exe = $rel.assets | Where-Object { $_.name -match '(?i)win' -and $_.name -like '*.exe' } | Select-Object -First 1
        if (-not $exe) { $exe = $rel.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1 }
        if ($exe) {
            $dest = Join-Path $DownloadsDir $exe.name
            if (-not (Test-Path $dest)) {
                Note "Downloading $($exe.name)..."
                Invoke-WebRequest -Uri $exe.browser_download_url -OutFile $dest -Headers $headers
            }
            Note "UI-TARS Desktop installer saved to $dest"
            Note 'It is NOT auto-installed. Run it once yourself, then use start-computer-use.ps1,'
            Note 'which serves the UI-TARS vision model locally and prints the settings to paste in.'
        } else {
            Warn 'No Windows .exe asset found on the latest UI-TARS Desktop release.'
            Note 'Grab it manually: https://github.com/bytedance/UI-TARS-desktop/releases'
        }
    } catch {
        Warn "UI-TARS download step failed ($($_.Exception.Message)). Skipping; everything else still stands."
        Note 'Manual route: https://github.com/bytedance/UI-TARS-desktop/releases'
    }
} else {
    Step 'Computer use skipped (-SkipComputerUse)'
}

# ---------------------------------------------------------------- sanity check
Step 'Sanity check'
$ErrorActionPreference = 'Continue'
$sanityLlama = (& $ServerExe --version 2>&1 | Select-Object -First 1)
try { $sanityOc = (opencode --version 2>$null) } catch { $sanityOc = 'did not run' }
$ErrorActionPreference = 'Stop'
Note "llama-server : $sanityLlama"
Note "opencode     : $sanityOc"
Note "config       : $ConfigPath (exists: $(Test-Path $ConfigPath))"
Note "model cache  : $HOME\.cache\llama.cpp"
Write-Host "`nDone. Next steps:" -ForegroundColor Green
Write-Host '  1. Run .\start-coding.ps1 from any project folder, then run: opencode'
Write-Host '  2. Browser use is already wired into OpenCode through the Playwright and Chrome DevTools MCP servers.'
Write-Host '  3. Computer use: install UI-TARS Desktop from the downloads folder, then run .\start-computer-use.ps1'
Write-Host "Full log: $LogFile"

} catch {
    Write-Host "`nSETUP STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Log: $LogFile"
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
