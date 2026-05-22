#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="0.1.7"
output_root="$repo_root/release/components"
work_root="$repo_root/.release-tools/ffmpeg-component-macos"

mkdir -p "$work_root"
if [[ ! -f "$work_root/package.json" ]]; then
  printf '{"private":true,"dependencies":{"ffmpeg-static":"5.3.0"}}\n' > "$work_root/package.json"
fi

(cd "$work_root" && npm install --silent)

ffmpeg="$work_root/node_modules/ffmpeg-static/ffmpeg"
if [[ ! -x "$ffmpeg" ]]; then
  echo "ffmpeg-static did not provide a macOS ffmpeg binary: $ffmpeg" >&2
  exit 1
fi

mkdir -p "$output_root"
arch_label="${RUNNER_ARCH:-$(uname -m)}"
case "$arch_label" in
  ARM64|arm64|aarch64) arch_label="ARM64" ;;
  X64|x64|x86_64) arch_label="x64" ;;
esac
asset_name="MyWiki_ffmpeg_${version}_macos_${arch_label}.zip"
asset_path="$output_root/$asset_name"
rm -f "$asset_path" "$asset_path.sha256"

ditto -c -k --keepParent "$ffmpeg" "$asset_path"
hash="$(shasum -a 256 "$asset_path" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$asset_name" > "$asset_path.sha256"

echo "Packaged ffmpeg component: $asset_path"
echo "$hash  $asset_name"
