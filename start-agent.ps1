<#
.SYNOPSIS
  Starts both local model servers side by side, each in its own window:
  the K2 coding model on port 8080 (what OpenCode talks to) and the
  UI-TARS vision model on port 8081 (backs OpenCode's computer-use tools
  and UI-TARS Desktop).

  VRAM: K2 (~6.6GB) + its 0.9B draft model (~0.7GB) + UI-TARS (~5GB) +
  caches fit inside 16GB. Expect each model to run a bit slower while
  the other is busy; that is the price of having both live at once.
  Close either window to free the card.

  After both windows finish loading, in your project folder:  opencode
  The computer-use tools only work while the 8081 window stays open.
#>

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'start-coding.ps1')
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'start-computer-use.ps1')
Write-Host 'Both servers are starting in their own windows.' -ForegroundColor Green
Write-Host 'Wait for each to finish loading, then run opencode in your project folder.'
