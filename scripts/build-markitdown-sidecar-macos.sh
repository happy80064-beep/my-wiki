#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
tool_root="$repo_root/.release-tools/markitdown-macos"
venv_root="$tool_root/.venv"
dist_root="$repo_root/src-tauri/binaries"
bridge="$repo_root/scripts/markitdown_bridge.py"
output="$dist_root/mywiki-markitdown"

mkdir -p "$tool_root" "$dist_root"

if [[ ! -f "$bridge" ]]; then
  echo "Missing MarkItDown bridge script: $bridge" >&2
  exit 1
fi

rm -f "$output"

if [[ ! -x "$venv_root/bin/python" ]]; then
  python3 -m venv "$venv_root"
fi

python="$venv_root/bin/python"
"$python" -m pip install --upgrade pip
"$python" -m pip install --upgrade 'markitdown[all]' pyinstaller

"$python" -m PyInstaller \
  --clean \
  --noconfirm \
  --onefile \
  --name mywiki-markitdown \
  --collect-all magika \
  --collect-all markitdown \
  --distpath "$dist_root" \
  --workpath "$tool_root/build" \
  --specpath "$tool_root/spec" \
  "$bridge"

if [[ ! -x "$output" ]]; then
  echo "MarkItDown sidecar build failed: $output" >&2
  exit 1
fi

chmod +x "$output"
echo "Built macOS MarkItDown sidecar: $output"
