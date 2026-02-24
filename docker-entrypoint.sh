#!/bin/sh
set -e

# If workspace has no agents/ directory, initialize from templates
if [ ! -d "/data/agents" ]; then
  echo "Empty workspace detected. Running init..."
  node /app/src/cli/index.ts init
fi

exec "$@"
