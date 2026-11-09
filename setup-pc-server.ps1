<#
.SYNOPSIS
  Split setup, PC side: this machine is the compute box only.
  Installs llama.cpp (Vulkan), prefetches the coding model, generates an API
  key, and opens the Windows Firewall (Private profile) so the M4 Air can
  reach the model servers on ports 8080 (coding) and 8081 (vision).

  The frontend (OpenCode, MCP browser tools, UI-TARS Desktop) lives on the
  Mac. Run setup-mac-frontend.sh over there with the address and key this
  script prints at the end.

.DESCRIPTION
  Non-interactive and idempotent. The firewall step needs an elevated
  (Administrator) PowerShell; if it is denied, the script prints the exact
  command to run elevated and keeps going.

  Security shape: llama-server has no real account system, so the servers
  are protected by one shared API key (saved in $InstallRoot\api-key.txt)
  plus a firewall rule scoped to the Private network profile. Do not port
  forward these ports on your router. If you want access away from home,
  put both machines on Tailscale and use the PC's Tailscale address instead
  of the LAN address; the key still applies.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-pc-server.ps1
#>

[CmdletBinding()]
param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\local-agent",
    [string]$ModelRepo   = "IFM/K2-Horizon-7B-GGUF:Q5_K_M",
    [string]$ModelAlias  = "k2-horizon-7b"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$LogDir  = Join-Path $InstallRoot 'logs'
New-Item -ItemType Directory -Force -Path $InstallRoot, $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("setup-pc-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $LogFile -Append | Out-Null

function Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Note([string]$msg) { Write-Host "  $msg" }
function Warn([string]$msg) { Write-Host "  WARNING: $msg" -ForegroundColor Yellow }

try {

Step 'System check'
$gpus = Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name
Note "GPU(s): $($gpus -join ', ')"
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($InstallRoot).Substring(0,1))
$freeGb = [math]::Round($drive.Free / 1GB, 1)
Note "Free space on install drive: $freeGb GB"
if ($freeGb -lt 30) { Warn 'Under 30GB free. The coder model is ~6GB and the vision model ~5GB.' }

# ---------------------------------------------------------------- llama.cpp
Step 'llama.cpp (Vulkan build)'
$LlamaDir     = Join-Path $InstallRoot 'llama.cpp'
$ServerExe    = Join-Path $LlamaDir 'llama-server.exe'
$DownloadsDir = Join-Path $InstallRoot 'downloads'
New-Item -ItemType Directory -Force -Path $LlamaDir, $DownloadsDir | Out-Null

if (Test-Path $ServerExe) {
    Note 'llama-server already present, skipping download.'
} else {
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
        throw 'Asset detection failed.'
    }
    Note "llama.cpp release $pickedTag"
    $zipPath = Join-Path $DownloadsDir $asset.name
    Note "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers $headers
    Expand-Archive -Path $zipPath -DestinationPath $LlamaDir -Force
    if (-not (Test-Path $ServerExe)) {
        $nested = Get-ChildItem -Path $LlamaDir -Recurse -Filter 'llama-server.exe' | Select-Object -First 1
        if ($nested) { Copy-Item -Path (Join-Path $nested.DirectoryName '*') -Destination $LlamaDir -Recurse -Force }
    }
    if (-not (Test-Path $ServerExe)) { throw "llama-server.exe not found after extracting $($asset.name)." }
}
$ErrorActionPreference = 'Continue'
$versionLine = (& $ServerExe --version 2>&1 | Select-Object -First 1)
$ErrorActionPreference = 'Stop'
Note "llama.cpp: $versionLine"

# ------------------------------------------------------------------ API key
Step 'API key (shared secret between this PC and the Mac)'
$KeyFile = Join-Path $InstallRoot 'api-key.txt'
if (Test-Path $KeyFile) {
    $ApiKey = (Get-Content $KeyFile -Raw).Trim()
    Note 'Reusing the existing key in api-key.txt.'
} else {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $ApiKey = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    [IO.File]::WriteAllText($KeyFile, $ApiKey, (New-Object Text.UTF8Encoding $false))
    Note "Generated a new key and saved it to $KeyFile"
}
$authHeaders = @{ Authorization = "Bearer $ApiKey" }

# ------------------------------------------------- model prefetch + smoke test
Step 'Model prefetch and smoke test (binds LAN, key required)'
$serverArgs = @(
    '-hf', $ModelRepo,
    '--alias', $ModelAlias,
    '--host', '0.0.0.0', '--port', '8080',
    '-c', '65536', '--jinja',
    '-ngl', '99',
    '-fa', 'on',
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--no-mmproj', '--parallel', '1', '-ub', '1024',
    '--api-key', $ApiKey
)
$serverLog = Join-Path $LogDir 'pc-server-first-run.log'
Note 'Starting llama-server to download the model (~6GB, first run only)...'
$proc = Start-Process -FilePath $ServerExe -ArgumentList $serverArgs -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"
try {
    $deadline = (Get-Date).AddMinutes(90)
    $healthy = $false
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { throw "llama-server exited early (code $($proc.ExitCode)). See $serverLog.err" }
        try {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -Headers $authHeaders -TimeoutSec 3
            if ($h.status -eq 'ok') { $healthy = $true; break }
        } catch { Start-Sleep -Seconds 5 }
    }
    if (-not $healthy) { throw "Server did not become healthy within 90 minutes. See $serverLog" }
    $body = @{
        model = $ModelAlias
        messages = @(@{ role = 'user'; content = 'Reply with exactly: pc server ok' })
        max_tokens = 32
    } | ConvertTo-Json -Depth 5
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/chat/completions' -Method Post -ContentType 'application/json' -Body $body -Headers $authHeaders -TimeoutSec 180
    Note "Model replied: $($resp.choices[0].message.content)"
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Note 'Smoke-test server stopped.'
}

# ----------------------------------------------------------------- firewall
Step 'Windows Firewall (Private profile + Tailscale range, ports 8080 and 8081)'
try {
    foreach ($port in 8080, 8081) {
        $ruleName = "Local Agent llama-server $port"
        if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $port -Program $ServerExe -Profile Private | Out-Null
            Note "Rule added for port $port."
        } else {
            Note "Rule for port $port already exists."
        }
    }
    # Tailscale traffic arrives on its own adapter, which Windows often
    # classifies as Public, so the Private rules above can miss it. Admit
    # the same ports from the Tailscale CGNAT range (100.64.0.0/10) on
    # any profile: only tailnet members can source those addresses, and
    # the servers still require the API key on top.
    foreach ($port in 8080, 8081) {
        $tsName = "Local Agent llama-server $port (Tailscale)"
        if (-not (Get-NetFirewallRule -DisplayName $tsName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName $tsName -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $port -Program $ServerExe -Profile Any `
                -RemoteAddress '100.64.0.0/10' | Out-Null
            Note "Tailscale rule added for port $port."
        } else {
            Note "Tailscale rule for port $port already exists."
        }
    }
} catch {
    Warn 'Firewall rule could not be added (needs an Administrator PowerShell).'
    Note 'Run these once, elevated, then the Mac can connect:'
    Note "  New-NetFirewallRule -DisplayName 'Local Agent llama-server' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080,8081 -Program '$ServerExe' -Profile Private"
    Note "  New-NetFirewallRule -DisplayName 'Local Agent llama-server TS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080,8081 -Program '$ServerExe' -Profile Any -RemoteAddress '100.64.0.0/10'"
}

# --------------------------------------------------------------- final report
Step 'Done: what the Mac needs'
$lanIps = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host 'PC server setup is done.' -ForegroundColor Green
Write-Host 'Start the servers any time with:'
Write-Host '  .\start-server-pc.ps1     (coding model, port 8080)'
Write-Host '  .\start-vision-pc.ps1     (UI-TARS vision model, port 8081)'
Write-Host ''
Write-Host 'This PC can be reached at:'
foreach ($ip in $lanIps) { Write-Host "  http://${ip}:8080" }
$ts = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '100.*' } | Select-Object -ExpandProperty IPAddress -First 1
if ($ts) { Write-Host "  Tailscale address: http://${ts}:8080 (works away from home too)" }
Write-Host ''
Write-Host 'On the Mac, run the frontend setup with this PC''s address and this key:'
Write-Host "  ./setup-mac-frontend.sh <pc-address> $ApiKey"
Write-Host ''
Write-Host "Full log: $LogFile"

} catch {
    Write-Host "`nSETUP STOPPED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Log: $LogFile"
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
