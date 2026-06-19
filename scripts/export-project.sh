#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  echo "Usage: scripts/export-project.sh <target_project_root> <project_slug>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="$1"
PROJECT_SLUG="$2"
SOURCE_ROOT="$ROOT_DIR/projects/$PROJECT_SLUG"
SOURCE_SIMA="$SOURCE_ROOT/Assets/StreamingAssets/sima_services"
TARGET_SIMA="$TARGET_ROOT/Assets/StreamingAssets/sima_services"

if [ ! -d "$SOURCE_SIMA" ]; then
  echo "Source path not found: $SOURCE_SIMA" >&2
  exit 1
fi

mkdir -p "$TARGET_SIMA"

rsync -a --delete --exclude='.DS_Store' "$SOURCE_SIMA/" "$TARGET_SIMA/"

echo "Exported $PROJECT_SLUG to $TARGET_ROOT"
