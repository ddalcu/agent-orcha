#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GIT_DIR="$SCRIPT_DIR/../.git"

if [ ! -d "$GIT_DIR" ]; then
  echo "Not a git repository. Skipping hook install."
  exit 0
fi

HOOK_TARGET="$GIT_DIR/hooks/pre-commit"
mkdir -p "$GIT_DIR/hooks"

# Write a portable shim that invokes the Node.js pre-commit script
cat > "$HOOK_TARGET" << 'HOOK'
#!/bin/sh
node "$(dirname "$0")/../../scripts/pre-commit.mjs"
HOOK

chmod +x "$HOOK_TARGET"
echo "Pre-commit hook installed."
