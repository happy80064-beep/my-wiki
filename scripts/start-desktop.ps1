$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectRoot 'logs'
$LogPath = Join-Path $LogDir 'desktop-launch.log'
$VsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
$AppExe = Join-Path $ProjectRoot 'src-tauri\target\debug\app.exe'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Content -LiteralPath $LogPath -Encoding UTF8 -Value "MyWiki Froggy desktop launcher log - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

function Write-Status {
  param(
    [string]$Message,
    [string]$Color = 'Cyan'
  )
  $time = Get-Date -Format 'HH:mm:ss'
  Write-Host "[$time] $Message" -ForegroundColor $Color
  try {
    "[$time] $Message" | Add-Content -LiteralPath $LogPath -Encoding UTF8 -ErrorAction Stop
  } catch {
    # The launcher should keep working even if an older process still holds the log file.
  }
}

function Stop-WithMessage {
  param([string]$Message)
  Write-Status $Message 'Red'
  exit 1
}

function Test-DesktopShellRunning {
  param([string]$Root)

  Get-Process -Name app -ErrorAction SilentlyContinue |
    Where-Object {
      try {
        $_.Path -like "$Root*"
      } catch {
        $false
      }
    }
}

function Minimize-LauncherWindow {
  if (-not ('MyWikiLauncher.NativeWindow' -as [type])) {
    Add-Type -TypeDefinition @'
namespace MyWikiLauncher {
  using System;
  using System.Runtime.InteropServices;

  public static class NativeWindow {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  }
}

function Test-FrontendServer {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173/' -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Start-FrontendServer {
  $FrontendRunPath = Join-Path $LogDir 'frontend-run.cmd'
  $FrontendLogPath = Join-Path $LogDir 'frontend-runtime.log'
  $FrontendErrPath = Join-Path $LogDir 'frontend-runtime.err.log'

  Set-Content -LiteralPath $FrontendRunPath -Encoding ASCII -Value @(
    '@echo off',
    "cd /d `"$ProjectRoot`"",
    'chcp 65001 > nul',
    'pnpm dev --host 127.0.0.1 --port 5173 --strictPort'
  )

  if (Test-Path -LiteralPath $FrontendLogPath) {
    Clear-Content -LiteralPath $FrontendLogPath
  }
  if (Test-Path -LiteralPath $FrontendErrPath) {
    Clear-Content -LiteralPath $FrontendErrPath
  }

  $frontendProcess = Start-Process -FilePath $env:ComSpec `
    -ArgumentList @('/d', '/s', '/c', "`"$FrontendRunPath`"") `
    -RedirectStandardOutput $FrontendLogPath `
    -RedirectStandardError $FrontendErrPath `
    -WindowStyle Hidden `
    -PassThru

  Write-Status "Frontend dev server process started. PID: $($frontendProcess.Id)"
  Write-Status "Frontend log: $FrontendLogPath"

  for ($i = 0; $i -lt 30; $i += 1) {
    if (Test-FrontendServer) {
      Write-Status 'Frontend dev server is ready on http://127.0.0.1:5173.' 'Green'
      return $frontendProcess
    }
    if ($frontendProcess.HasExited) {
      Stop-WithMessage "Frontend dev server exited early. Check $FrontendErrPath"
    }
    Start-Sleep -Seconds 1
    $frontendProcess.Refresh()
  }

  Stop-WithMessage "Frontend dev server did not become ready in time. Check $FrontendLogPath"
}
'@
  }

  $handle = [MyWikiLauncher.NativeWindow]::GetConsoleWindow()
  if ($handle -ne [IntPtr]::Zero) {
    [void][MyWikiLauncher.NativeWindow]::ShowWindow($handle, 6)
  }
}

Set-Location -LiteralPath $ProjectRoot
$Host.UI.RawUI.WindowTitle = 'MyWiki Froggy Desktop Launcher'

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' MyWiki Froggy Desktop Launcher' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host "Project: $ProjectRoot"
Write-Host "Log:     $LogPath"
Write-Host ''

Write-Status 'Checking whether the desktop shell is already running...'
$runningApp = Test-DesktopShellRunning -Root $ProjectRoot

if ($runningApp) {
  Write-Status 'MyWiki Froggy desktop shell is already running. It will not be started again.' 'Green'
  Write-Host ''
  Write-Host 'If you cannot see the frog window, check whether it is minimized or near the screen edge.' -ForegroundColor Yellow
  exit 0
}

Write-Status 'Checking pnpm...'
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Stop-WithMessage 'pnpm was not found. Please install Node.js and pnpm first: npm install -g pnpm'
}

Write-Status 'Checking project dependencies...'
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Status 'node_modules was not found. Installing dependencies now. This may take a few minutes.' 'Yellow'
  pnpm install 2>&1 | Tee-Object -FilePath $LogPath -Append
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage 'pnpm install failed. Please check the log and try again.'
  }
}

if (-not (Test-Path -LiteralPath $AppExe)) {
  Write-Status 'First launch or build cache was cleaned. Tauri/Rust will compile now. Estimated time: 3-10 minutes.' 'Yellow'
  Write-Status 'Compiling / Finished lines are normal. Please keep this window open until the frog appears.' 'Yellow'
} else {
  Write-Status 'Local desktop build cache was found. Startup should be faster.' 'Green'
}

Write-Status 'Checking frontend dev server on fixed port 5173...'
if (Test-FrontendServer) {
  Write-Status 'Reusing existing frontend dev server on port 5173. No extra 5174/5175 server will be started.' 'Green'
} else {
  Write-Status 'Starting frontend dev server on fixed port 5173...' 'Yellow'
  [void](Start-FrontendServer)
}

if (Test-Path -LiteralPath $VsDevCmd) {
  Write-Status 'Loading Visual Studio Build Tools C++ environment...'
  $launchCommand = "chcp 65001 > nul && call `"$VsDevCmd`" -arch=x64 && cd /d `"$ProjectRoot\src-tauri`" && cargo run --no-default-features --color always --"
} else {
  Write-Status 'Visual Studio Build Tools was not found. Trying anyway; install C++ Build Tools if Tauri fails.' 'Yellow'
  $launchCommand = "chcp 65001 > nul && cd /d `"$ProjectRoot\src-tauri`" && cargo run --no-default-features --color always --"
}

Write-Host ''
Write-Status 'Starting MyWiki Froggy desktop shell. Keep this launcher open until the frog window appears.' 'Green'
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray

$RunCmdPath = Join-Path $LogDir 'desktop-run.cmd'
$RuntimeLogPath = Join-Path $LogDir 'desktop-runtime.log'
$RuntimeErrPath = Join-Path $LogDir 'desktop-runtime.err.log'
Set-Content -LiteralPath $RunCmdPath -Encoding ASCII -Value @(
  '@echo off',
  "cd /d `"$ProjectRoot`"",
  $launchCommand
)

if (Test-Path -LiteralPath $RuntimeLogPath) {
  Clear-Content -LiteralPath $RuntimeLogPath
}
if (Test-Path -LiteralPath $RuntimeErrPath) {
  Clear-Content -LiteralPath $RuntimeErrPath
}

$desktopProcess = Start-Process -FilePath $env:ComSpec `
  -ArgumentList @('/d', '/s', '/c', "`"$RunCmdPath`"") `
  -RedirectStandardOutput $RuntimeLogPath `
  -RedirectStandardError $RuntimeErrPath `
  -WindowStyle Hidden `
  -PassThru

Write-Status "Desktop process started in background. PID: $($desktopProcess.Id)" 'Green'
Write-Status "Runtime log: $RuntimeLogPath"
Write-Status "Error log:   $RuntimeErrPath"

$startedAt = Get-Date
$minimized = $false
while (-not $desktopProcess.HasExited) {
  if (Test-DesktopShellRunning -Root $ProjectRoot) {
    Write-Status 'Froggy capture window is running. Minimizing this launcher window.' 'Green'
    Start-Sleep -Milliseconds 700
    Minimize-LauncherWindow
    $minimized = $true
    break
  }

  $elapsed = [Math]::Round(((Get-Date) - $startedAt).TotalMinutes, 1)
  if ((Test-Path -LiteralPath $AppExe) -or $elapsed -lt 1) {
    Write-Status "Still starting... elapsed $elapsed min. Please keep this window open." 'Yellow'
  } else {
    Write-Status "First compile is still running... elapsed $elapsed min. This can take 3-10 minutes." 'Yellow'
  }
  Start-Sleep -Seconds 15
  $desktopProcess.Refresh()
}

if (-not $desktopProcess.HasExited) {
  $desktopProcess.WaitForExit()
}
$exitCode = $desktopProcess.ExitCode

Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
if ($exitCode -eq 0) {
  Write-Status 'MyWiki Froggy desktop shell exited normally.' 'Green'
} else {
  Write-Status "MyWiki Froggy desktop shell failed or exited with code: $exitCode" 'Red'
  Write-Host "Log: $LogPath" -ForegroundColor Yellow
  Write-Host "Runtime log: $RuntimeLogPath" -ForegroundColor Yellow
  Write-Host "Error log: $RuntimeErrPath" -ForegroundColor Yellow
  if (Test-Path -LiteralPath $RuntimeErrPath) {
    Get-Content -LiteralPath $RuntimeErrPath -Tail 30
  }
}

exit $exitCode
