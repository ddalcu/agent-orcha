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
  # Pre-create Chrome profile to suppress infobars and deny permissions
  # without using detectable flags like --test-type or --enable-automation
  # Pre-create Chrome profile to suppress infobars and deny permissions
  mkdir -p /tmp/.chromium/Default
  chown -R sandbox:sandbox /tmp/.chromium
  cat > /tmp/.chromium/Default/Preferences <<'PREFS'
{"profile":{"exit_type":"Normal","exited_cleanly":true,"content_settings":{"exceptions":{"notifications":{"*":{"setting":2}},"geolocation":{"*":{"setting":2}},"media_stream_camera":{"*":{"setting":2}},"media_stream_mic":{"*":{"setting":2}}}}},"browser":{"has_seen_welcome_page":true,"check_default_browser":false},"download":{"prompt_for_download":false,"default_directory":"/tmp"}}
PREFS
  touch /tmp/.chromium/'First Run'
  chown sandbox:sandbox /tmp/.chromium/Default/Preferences /tmp/.chromium/'First Run'
  # Run Chromium as sandbox user — no --no-sandbox, no warning banner.
  # Container needs SYS_ADMIN capability for Chrome's internal sandbox.
  CHROMIUM_FLAGS="--disable-gpu --disable-dev-shm-usage \
    --disable-software-rasterizer --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 --window-size=1280,720 \
    --no-first-run --no-default-browser-check \
    --disable-background-networking \
    --disable-client-side-phishing-detection \
    --disable-hang-monitor \
    --disable-popup-blocking \
    --disable-prompt-on-repost \
    --disable-sync \
    --disable-translate \
    --metrics-recording-only \
    --lang=en-US \
    --user-data-dir=/tmp/.chromium"
  if [ "${BROWSER_VERBOSE:-false}" = "true" ]; then
    su -s /bin/sh sandbox -c "chromium $CHROMIUM_FLAGS chrome://newtab" &
  else
    su -s /bin/sh sandbox -c "chromium $CHROMIUM_FLAGS chrome://newtab 2>/dev/null" &
  fi
  echo "Browser sandbox ready (noVNC: http://localhost:6080/vnc.html, CDP: ws://localhost:9222)"
fi

# Set default workspace for Docker
export WORKSPACE="${WORKSPACE:-/data}"

# Default to "start" when no command is given
if [ -z "${1:-}" ]; then
  set -- start
fi

# If first arg is a known subcommand, prepend the CLI
case "$1" in
  start|help)
    if [ "${NODE_ENV:-}" = "development" ]; then
      exec node --watch-path=/app/lib --watch-path=/app/src /app/src/cli/index.ts "$@"
    else
      exec node /app/src/cli/index.ts "$@"
    fi
    ;;
esac

exec "$@"
