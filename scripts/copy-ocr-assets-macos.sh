#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
dist_root="$repo_root/dist"
tessdata_root="$dist_root/tessdata"
worker_root="$dist_root/tesseract"
core_root="$dist_root/tesseract-core"

if [[ ! -d "$dist_root" ]]; then
  echo "Missing dist directory. Run the Vite build before copying OCR assets." >&2
  exit 1
fi

mkdir -p "$tessdata_root" "$worker_root" "$core_root"

for language in chi_sim eng; do
  source="$repo_root/$language.traineddata"
  if [[ ! -f "$source" ]]; then
    curl -L --fail "https://github.com/tesseract-ocr/tessdata_fast/raw/main/$language.traineddata" -o "$source"
  fi
  cp -f "$source" "$tessdata_root/$language.traineddata"
done

worker_source="$repo_root/node_modules/tesseract.js/dist/worker.min.js"
if [[ ! -f "$worker_source" ]]; then
  echo "Missing Tesseract worker: $worker_source" >&2
  exit 1
fi
cp -f "$worker_source" "$worker_root/worker.min.js"

core_package_root="$(find "$repo_root/node_modules/.pnpm" -path '*/node_modules/tesseract.js-core' -type d | head -n 1)"
if [[ -z "$core_package_root" || ! -d "$core_package_root" ]]; then
  echo "Missing tesseract.js-core package." >&2
  exit 1
fi

find "$core_package_root" -maxdepth 1 \( -name 'tesseract-core*.js' -o -name 'tesseract-core*.wasm' \) -exec cp -f {} "$core_root/" \;

echo "Copied OCR assets into $dist_root"
