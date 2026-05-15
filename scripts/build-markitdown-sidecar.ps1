$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $repoRoot ".release-tools\markitdown"
$venvRoot = Join-Path $toolRoot ".venv"
$distRoot = Join-Path $repoRoot "src-tauri\binaries"
$bridge = Join-Path $repoRoot "scripts\markitdown_bridge.py"
$exe = Join-Path $distRoot "mywiki-markitdown.exe"

New-Item -ItemType Directory -Force -Path $toolRoot, $distRoot | Out-Null

if (!(Test-Path $bridge)) {
  throw "Missing MarkItDown bridge script: $bridge"
}

Remove-Item -Force -ErrorAction SilentlyContinue $exe

if (!(Test-Path $venvRoot)) {
  python -m venv $venvRoot
}

$python = Join-Path $venvRoot "Scripts\python.exe"
if (!(Test-Path $python)) {
  throw "Python virtual environment was not created correctly: $venvRoot"
}

& $python -m pip install --upgrade pip
& $python -m pip install --upgrade "markitdown[all]" pyinstaller

$buildPath = Join-Path $toolRoot "build"
$specPath = Join-Path $toolRoot "spec"

& $python -m PyInstaller `
  --clean `
  --noconfirm `
  --onefile `
  --name mywiki-markitdown `
  --collect-all magika `
  --collect-all markitdown `
  --distpath $distRoot `
  --workpath $buildPath `
  --specpath $specPath `
  $bridge

if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller failed with exit code $LASTEXITCODE."
}

if (!(Test-Path $exe)) {
  throw "MarkItDown sidecar build failed: $exe"
}

Write-Host "Built MarkItDown sidecar: $exe"
