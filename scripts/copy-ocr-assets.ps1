$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $repoRoot "dist"
$tessDataRoot = Join-Path $distRoot "tessdata"
$workerRoot = Join-Path $distRoot "tesseract"
$coreRoot = Join-Path $distRoot "tesseract-core"
$tesseractPackageRoot = Join-Path $repoRoot "node_modules\tesseract.js"
$tesseractCoreRoot = Join-Path $repoRoot "node_modules\.pnpm\tesseract.js-core@7.0.0\node_modules\tesseract.js-core"

if (!(Test-Path $distRoot)) {
  throw "Missing dist directory. Run the Vite build before copying OCR assets."
}

New-Item -ItemType Directory -Force -Path $tessDataRoot, $workerRoot, $coreRoot | Out-Null

foreach ($language in @("chi_sim", "eng")) {
  $source = Join-Path $repoRoot "$language.traineddata"
  if (!(Test-Path $source)) {
    Invoke-WebRequest `
      -Uri "https://github.com/tesseract-ocr/tessdata_fast/raw/main/$language.traineddata" `
      -OutFile $source
  }
  Copy-Item -Force $source (Join-Path $tessDataRoot "$language.traineddata")
}

$workerSource = Join-Path $tesseractPackageRoot "dist\worker.min.js"
if (!(Test-Path $workerSource)) {
  throw "Missing Tesseract worker: $workerSource"
}
Copy-Item -Force $workerSource (Join-Path $workerRoot "worker.min.js")

if (!(Test-Path $tesseractCoreRoot)) {
  throw "Missing tesseract.js-core package: $tesseractCoreRoot"
}
Copy-Item -Force (Join-Path $tesseractCoreRoot "tesseract-core*.js") $coreRoot
Copy-Item -Force (Join-Path $tesseractCoreRoot "tesseract-core*.wasm") $coreRoot

Write-Host "Copied OCR assets into $distRoot"
