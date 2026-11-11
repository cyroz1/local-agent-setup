<#
.SYNOPSIS
  Starts the offline transcription service and opens Interview Copilot.
#>

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $PSScriptRoot 'interview-agent'
$Python = Join-Path $AppDir '.venv\Scripts\python.exe'
$AsrScript = Join-Path $AppDir 'python\server.py'
$ModelDir = Join-Path $env:LOCALAPPDATA 'local-agent\interview-agent\models'
$AsrLog = Join-Path $env:LOCALAPPDATA 'local-agent\logs\interview-asr.log'
$AsrErr = Join-Path $env:LOCALAPPDATA 'local-agent\logs\interview-asr.err'
$asrProcess = $null
$startedAsr = $false

if (-not (Test-Path $Python)) {
    Write-Host 'Run .\setup-interview-agent.ps1 before opening Interview Copilot.' -ForegroundColor Red
    exit 1
}

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
    if ($health.status -eq 'ok') { Write-Host 'Offline transcription is already running.' -ForegroundColor Green }
} catch {
    $env:WHISPER_MODEL_DIR = $ModelDir
    $env:HF_HUB_OFFLINE = '1'
    $logDir = Split-Path -Parent $AsrLog
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $asrProcess = Start-Process -FilePath $Python -ArgumentList @($AsrScript) -WorkingDirectory $AppDir `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $AsrLog -RedirectStandardError $AsrErr
    $startedAsr = $true
    Write-Host 'Loading offline transcription model...' -ForegroundColor Cyan
    $deadline = (Get-Date).AddMinutes(2)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($asrProcess.HasExited) { throw "Transcription service exited. See $AsrErr" }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
            if ($health.status -eq 'ok') { $ready = $true; break }
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ready) { throw "Transcription service did not become ready. See $AsrLog and $AsrErr" }
}

$modelReady = $false
try {
    $modelHeaders = @{}
    $keyFile = Join-Path $env:LOCALAPPDATA 'local-agent\api-key.txt'
    if (Test-Path $keyFile) {
        $apiKey = (Get-Content $keyFile -Raw).Trim()
        if ($apiKey) { $modelHeaders.Authorization = "Bearer $apiKey" }
    }
    $modelHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -Headers $modelHeaders -TimeoutSec 3
    if ($modelHealth.status -eq 'ok') { $modelReady = $true }
} catch { }
if (-not $modelReady) {
    Write-Host 'The local answer model is not running. Start it with .\start-coding.ps1, then rerun this script.' -ForegroundColor Yellow
    if ($startedAsr -and $asrProcess -and -not $asrProcess.HasExited) { Stop-Process -Id $asrProcess.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}

Write-Host 'Opening Interview Copilot. Close its window to stop the app.' -ForegroundColor Cyan
Push-Location $AppDir
try {
    & npm run dev
} finally {
    Pop-Location
    if ($startedAsr -and $asrProcess -and -not $asrProcess.HasExited) {
        Stop-Process -Id $asrProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
