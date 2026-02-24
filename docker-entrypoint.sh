#!/bin/sh
set -e

# If workspace has no agents/ directory, initialize from templates
if [ ! -d "/data/agents" ]; then
  echo "Empty workspace detected. Running init..."
  node /app/src/cli/index.ts init
fi

# If first arg is a known subcommand, prepend the CLI
case "${1:-}" in
  start|init|help)
    exec node /app/src/cli/index.ts "$@"
    ;;
esac

exec "$@"
