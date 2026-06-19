#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECTS=(
  "demo-main"
  "cencomall"
  "hub-providencia"
)

COMMON_ITEMS=(
  "bridge.js"
  "app.css"
  "fragment.js"
  "qrcode.min.js"
  "mapvx"
)

for project in "${PROJECTS[@]}"; do
  target="$ROOT_DIR/projects/$project/Assets/StreamingAssets/sima_services/shared"
  mkdir -p "$target"

  for item in "${COMMON_ITEMS[@]}"; do
    if [ -e "$ROOT_DIR/shared/$item" ]; then
      cp -R "$ROOT_DIR/shared/$item" "$target/"
    fi
    if [ -e "$ROOT_DIR/shared/$item.meta" ]; then
      cp "$ROOT_DIR/shared/$item.meta" "$target/"
    fi
  done
done

echo "Common files synced to project mirrors."
