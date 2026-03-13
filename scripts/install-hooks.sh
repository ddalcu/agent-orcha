#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SOURCE="$SCRIPT_DIR/pre-commit"
HOOK_TARGET="$SCRIPT_DIR/../.git/hooks/pre-commit"

if [ ! -d "$SCRIPT_DIR/../.git" ]; then
  echo "Not a git repository. Skipping hook install."
  exit 0
fi

chmod +x "$HOOK_SOURCE"
ln -sf "$HOOK_SOURCE" "$HOOK_TARGET"
echo "Pre-commit hook installed."
