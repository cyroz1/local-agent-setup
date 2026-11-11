<#
.SYNOPSIS
  Installs the local Interview Copilot desktop app and offline speech/OCR assets.

.DESCRIPTION
  Keeps all runtime services on this PC. The first setup downloads app packages,
  the English Whisper base model, and local OCR worker files.
#>

$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $PSScriptRoot 'interview-agent'
$Python = Get-Command python -ErrorAction SilentlyContinue
$Npm = Get-Command npm -ErrorAction SilentlyContinue

if (-not $Python) { throw 'Python 3.12 was not found. Run setup-local-agent.ps1 first.' }
if (-not $Npm) { throw 'Node.js and npm were not found. Run setup-local-agent.ps1 first.' }

$pythonVersion = & python --version 2>&1
if ("$pythonVersion" -notmatch 'Python 3\.1[12]') {
    throw "Python 3.11 or 3.12 is required for the offline transcription package. Found: $pythonVersion"
}

Write-Host 'Creating the private Python environment...' -ForegroundColor Cyan
$VenvPython = Join-Path $AppDir '.venv\Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
    & python -m venv (Join-Path $AppDir '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Could not update pip in the app environment.' }
& $VenvPython -m pip install -r (Join-Path $AppDir 'python\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install the local transcription package.' }

Write-Host 'Installing the desktop app packages...' -ForegroundColor Cyan
Push-Location $AppDir
try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm could not install the app packages.' }
    & node .\node_modules\electron\install.js
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the Electron desktop runtime.' }
} finally { Pop-Location }

$PublicDir = Join-Path $AppDir 'public'
$TesseractDir = Join-Path $PublicDir 'tesseract'
$TesseractCoreSource = Join-Path $AppDir 'node_modules\tesseract.js-core'
New-Item -ItemType Directory -Force -Path (Join-Path $TesseractDir 'core'), (Join-Path $TesseractDir 'lang') | Out-Null

$WorkerSource = Join-Path $AppDir 'node_modules\tesseract.js\dist\worker.min.js'
if (-not (Test-Path $WorkerSource)) { throw "Tesseract worker not found at $WorkerSource" }
Copy-Item -LiteralPath $WorkerSource -Destination (Join-Path $TesseractDir 'worker.min.js') -Force
Copy-Item -Path (Join-Path $TesseractCoreSource '*') -Destination (Join-Path $TesseractDir 'core') -Recurse -Force

$PdfWorkerSource = Join-Path $AppDir 'node_modules\pdfjs-dist\legacy\build\pdf.worker.mjs'
if (Test-Path $PdfWorkerSource) {
    Copy-Item -LiteralPath $PdfWorkerSource -Destination (Join-Path $PublicDir 'pdf.worker.mjs') -Force
}

$OcrLanguage = Join-Path $TesseractDir 'lang\eng.traineddata.gz'
if (-not (Test-Path $OcrLanguage)) {
    Write-Host 'Downloading English screen-reading data...' -ForegroundColor Cyan
    Invoke-WebRequest -Uri 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz' -OutFile $OcrLanguage
}

$ModelDir = Join-Path $env:LOCALAPPDATA 'local-agent\interview-agent\models'
New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
$env:WHISPER_MODEL_DIR = $ModelDir
Write-Host 'Preparing the offline English speech model (first download is about 150 MB)...' -ForegroundColor Cyan
& $VenvPython -c "import os; from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8', download_root=os.environ['WHISPER_MODEL_DIR']); print('Offline transcription model ready.')"
if ($LASTEXITCODE -ne 0) { throw 'Could not download or prepare the offline speech model.' }

Write-Host ''
Write-Host 'Interview Copilot is ready.' -ForegroundColor Green
Write-Host '1. Start the local coding model with .\start-coding.ps1 and leave that window open.'
Write-Host '2. Run .\start-interview-agent.ps1 to open the desktop app.'
