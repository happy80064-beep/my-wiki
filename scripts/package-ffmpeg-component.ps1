$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$version = "0.1.7"
$outputRoot = Join-Path $repoRoot "release\components"
$workRoot = Join-Path $repoRoot ".release-tools\ffmpeg-component-windows"
$packageJson = Join-Path $workRoot "package.json"

New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
if (!(Test-Path $packageJson)) {
  '{"private":true,"dependencies":{"ffmpeg-static":"5.3.0"}}' | Set-Content -Path $packageJson -Encoding UTF8
}

Push-Location $workRoot
try {
  npm install --silent | Out-Null
} finally {
  Pop-Location
}

$ffmpeg = Join-Path $workRoot "node_modules\ffmpeg-static\ffmpeg.exe"
if (!(Test-Path $ffmpeg)) {
  throw "ffmpeg-static did not provide a Windows ffmpeg.exe: $ffmpeg"
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$assetName = "MyWiki_ffmpeg_${version}_windows_x64.zip"
$assetPath = Join-Path $outputRoot $assetName
Remove-Item -LiteralPath $assetPath -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath $ffmpeg -DestinationPath $assetPath -CompressionLevel Optimal

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $assetPath).Hash.ToLowerInvariant()
"$hash  $assetName" | Set-Content -Path "$assetPath.sha256" -Encoding ASCII

Write-Host "Packaged ffmpeg component: $assetPath"
Write-Host "$hash  $assetName"
