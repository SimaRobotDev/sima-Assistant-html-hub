#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  echo "Usage: scripts/import-project.sh <source_project_root> <project_slug>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ROOT="$1"
PROJECT_SLUG="$2"
DEST_ROOT="$ROOT_DIR/projects/$PROJECT_SLUG"
SOURCE_SIMA="$SOURCE_ROOT/Assets/StreamingAssets/sima_services"
DEST_SIMA="$DEST_ROOT/Assets/StreamingAssets/sima_services"

if [ ! -d "$SOURCE_SIMA" ]; then
  echo "Source path not found: $SOURCE_SIMA" >&2
  exit 1
fi

mkdir -p "$DEST_SIMA"

rsync -a --delete --exclude='.DS_Store' "$SOURCE_SIMA/" "$DEST_SIMA/"

if [ -d "$ROOT_DIR/shared" ]; then
  mkdir -p "$DEST_SIMA/shared"
  cp -R "$ROOT_DIR/shared/." "$DEST_SIMA/shared/"
fi

echo "Imported $PROJECT_SLUG from $SOURCE_ROOT"

