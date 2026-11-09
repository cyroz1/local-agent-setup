#!/usr/bin/env pwsh
<#
  Phone remote control for the local agent (all-in-one PC).

  Starts OpenCode in headless serve mode on port 4096 with password
  auth, so a phone (or any browser) on your Tailscale network can drive
  the same sessions: send prompts, approve tool calls, watch output.
  The phone is a pure viewport; everything still runs on this PC.

  Safety rules baked in:
    * A password is generated once and stored in
      %LOCALAPPDATA%\local-agent\opencode-password.txt (same pattern
      as the split setup's api-key.txt). This server can run shell
      commands, so it is never started without one.
    * Reach it over Tailscale (or your home LAN). Never port-forward
      port 4096 and never put it on Tailscale Funnel: basic auth is
      the only gate, and inside the tailnet the traffic is already
      encrypted by WireGuard.

  Firewall: inbound 4096 is a new program/port for Windows, so this
  script tries to add rules with the same scoping as the model
  server's (Private profile, plus the Tailscale range) and prints
  the elevated commands if it cannot.

  Usage: .\start-remote.ps1   (leave the window open, Ctrl+C stops)
#>

$ErrorActionPreference = 'Stop'
try { chcp 65001 > $null } catch { }
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

$InstallRoot = Join-Path $env:LOCALAPPDATA 'local-agent'
$Port = 4096

Write-Host 'OpenCode phone remote' -ForegroundColor Cyan
Write-Host ''

# ------------------------------------------------------------- opencode
$OpencodeExe = $null
$cmd = Get-Command opencode -ErrorAction SilentlyContinue
if ($cmd) { $OpencodeExe = $cmd.Source }
if (-not $OpencodeExe) {
    $known = Join-Path $InstallRoot 'opencode\opencode.exe'
    if (Test-Path $known) { $OpencodeExe = $known }
}
if (-not $OpencodeExe) { throw 'opencode not found. Run setup-local-agent.ps1 first.' }
Write-Host "opencode: $OpencodeExe"

# -------------------------------------------------------------- password
$PwFile = Join-Path $InstallRoot 'opencode-password.txt'
if (Test-Path $PwFile) {
    $Password = (Get-Content $PwFile -Raw).Trim()
    Write-Host 'Reusing the server password in opencode-password.txt.'
} else {
    $bytes = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Password = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    if (-not (Test-Path $InstallRoot)) { New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null }
    [IO.File]::WriteAllText($PwFile, $Password, (New-Object Text.UTF8Encoding $false))
    Write-Host 'Generated a server password and saved it to opencode-password.txt.'
}
# Two env names on purpose: older OpenCode reads OPENCODE_SERVER_PASSWORD,
# the current docs say OPENCODE_PASSWORD. Same value, both set.
$env:OPENCODE_SERVER_PASSWORD = $Password
$env:OPENCODE_PASSWORD = $Password

# ---------------------------------------------------------- model check
$modelUp = $false
try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2
    if ($h.status -eq 'ok') { $modelUp = $true }
} catch { }
if ($modelUp) {
    Write-Host 'Model server is up on port 8080.'
} else {
    Write-Host 'WARNING: the model server is not answering on port 8080.' -ForegroundColor Yellow
    Write-Host 'Start start-coding.ps1 as well, or the agent has no local brain.'
}

# -------------------------------------------------------------- firewall
try {
    $ruleSpecs = @(
        @{ Name = 'Local Agent OpenCode remote'; Profile = 'Private'; Remote = $null },
        @{ Name = 'Local Agent OpenCode remote (Tailscale)'; Profile = 'Any'; Remote = '100.64.0.0/10' }
    )
    foreach ($r in $ruleSpecs) {
        if (-not (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue)) {
            $params = @{ DisplayName = $r.Name; Direction = 'Inbound'; Action = 'Allow';
                         Protocol = 'TCP'; LocalPort = $Port; Program = $OpencodeExe; Profile = $r.Profile }
            if ($r.Remote) { $params['RemoteAddress'] = $r.Remote }
            New-NetFirewallRule @params | Out-Null
            Write-Host "Firewall rule added: $($r.Name)"
        }
    }
} catch {
    Write-Host 'Could not add a firewall rule for port 4096 (needs an Administrator PowerShell).' -ForegroundColor Yellow
    Write-Host 'If the phone cannot connect, run these once, elevated:'
    Write-Host "  New-NetFirewallRule -DisplayName 'Local Agent OpenCode remote' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4096 -Program '$OpencodeExe' -Profile Private"
    Write-Host "  New-NetFirewallRule -DisplayName 'Local Agent OpenCode remote TS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4096 -Program '$OpencodeExe' -Profile Any -RemoteAddress '100.64.0.0/10'"
}

# ----------------------------------------------------------------- urls
Write-Host ''
Write-Host 'Open one of these on your phone (Tailscale app on):' -ForegroundColor Green
$tsIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -like '100.*' } | Select-Object -ExpandProperty IPAddress -First 1
if ($tsIp) { Write-Host "  Tailscale: http://${tsIp}:$Port  (works anywhere)" }
$lanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' } |
    Select-Object -ExpandProperty IPAddress -First 1
if ($lanIp) { Write-Host "  Home LAN : http://${lanIp}:$Port" }
Write-Host '  Username: opencode'
Write-Host "  Password: $Password   (also in opencode-password.txt)"
Write-Host ''
Write-Host 'Leave this window open. Press Ctrl+C to stop the remote server.'
Write-Host ''

& $OpencodeExe serve --hostname 0.0.0.0 --port $Port
