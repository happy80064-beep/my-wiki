$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppDataRoot = Join-Path $env:LOCALAPPDATA 'com.mywiki.app'
$IndexedDbPath = Join-Path $AppDataRoot 'EBWebView\Default\IndexedDB'
$BackupRoot = Join-Path $ProjectRoot 'backups\desktop-indexeddb'

function Write-Status {
  param(
    [string]$Message,
    [string]$Color = 'Cyan'
  )
  Write-Host $Message -ForegroundColor $Color
}

function Stop-DesktopShell {
  Get-Process -Name app -ErrorAction SilentlyContinue |
    Where-Object {
      try {
        $_.Path -like "$ProjectRoot*"
      } catch {
        $false
      }
    } |
    Stop-Process -Force
}

if (-not (Test-Path -LiteralPath $AppDataRoot)) {
  Write-Status "Desktop app data not found: $AppDataRoot" 'Yellow'
  exit 0
}

$resolvedAppDataRoot = (Resolve-Path -LiteralPath $AppDataRoot).Path
if (Test-Path -LiteralPath $IndexedDbPath) {
  $resolvedIndexedDbPath = (Resolve-Path -LiteralPath $IndexedDbPath).Path
  if (-not $resolvedIndexedDbPath.StartsWith($resolvedAppDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete outside desktop app data: $resolvedIndexedDbPath"
  }
}

Write-Status 'Stopping MyWiki desktop shell if it is running...'
Stop-DesktopShell
Start-Sleep -Seconds 2

if (-not (Test-Path -LiteralPath $IndexedDbPath)) {
  Write-Status "Desktop IndexedDB is already empty: $IndexedDbPath" 'Green'
  exit 0
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupRoot "IndexedDB-$Stamp"

Write-Status "Backing up desktop IndexedDB to: $BackupPath"
Copy-Item -LiteralPath $IndexedDbPath -Destination $BackupPath -Recurse -Force

Write-Status "Removing desktop IndexedDB: $IndexedDbPath"
Remove-Item -LiteralPath $IndexedDbPath -Recurse -Force

if (Test-Path -LiteralPath $IndexedDbPath) {
  throw 'Desktop IndexedDB directory still exists after deletion.'
}

Write-Status 'Desktop IndexedDB has been cleared. Browser IndexedDB was not touched.' 'Green'
