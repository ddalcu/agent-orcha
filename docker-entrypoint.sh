#!/bin/sh
set -e

# Start browser sandbox services if enabled
if [ "${BROWSER_SANDBOX:-false}" = "true" ]; then
  export DISPLAY=:99
  # Clean up stale X lock files from previous container runs
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb :99 -screen 0 1280x720x24 -ac &
  sleep 1
  x11vnc -display :99 -rfbport 5900 -shared -forever -nopw &
  websockify --web /usr/share/novnc 6080 localhost:5900 &
  chromium --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --disable-software-rasterizer --remote-debugging-address=0.0.0.0 \
    --remote-debugging-port=9222 --window-size=1280,720 \
    --user-data-dir=/tmp/.chromium about:blank &
  echo "Browser sandbox ready (noVNC: http://localhost:6080/vnc.html, CDP: ws://localhost:9222)"
fi

# If workspace has no agents/ directory, initialize from templates
if [ ! -d "/data/agents" ]; then
  echo "Empty workspace detected. Running init..."
  node /app/src/cli/index.ts init
fi

# Default to "start" when no command is given
if [ -z "${1:-}" ]; then
  set -- start
fi

# If first arg is a known subcommand, prepend the CLI
case "$1" in
  start|init|help)
    if [ "${NODE_ENV:-}" = "development" ]; then
      exec node --watch-path=/app/lib --watch-path=/app/src /app/src/cli/index.ts "$@"
    else
      exec node /app/src/cli/index.ts "$@"
    fi
    ;;
esac

exec "$@"
