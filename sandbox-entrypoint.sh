#!/bin/sh
set -e

export DISPLAY=:99

# Clean up stale X lock files
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Start Xvfb
Xvfb :99 -screen 0 1280x720x24 -ac &
sleep 1

# Start VNC server
x11vnc -display :99 -rfbport 5900 -shared -forever -nopw &

# Start noVNC websocket proxy
websockify --web /usr/share/novnc 6080 localhost:5900 &

# Pre-create Chrome profile with preferences that suppress infobars and
# first-run prompts without needing detectable flags like --test-type
mkdir -p /tmp/.chromium/Default
chown -R sandbox:sandbox /tmp/.chromium
cat > /tmp/.chromium/Default/Preferences <<'PREFS'
{
  "profile": {
    "exit_type": "Normal",
    "exited_cleanly": true,
    "content_settings": {
      "exceptions": {
        "notifications": { "*": { "setting": 2 } },
        "geolocation": { "*": { "setting": 2 } },
        "media_stream_camera": { "*": { "setting": 2 } },
        "media_stream_mic": { "*": { "setting": 2 } }
      }
    }
  },
  "browser": {
    "has_seen_welcome_page": true,
    "check_default_browser": false
  },
  "download": {
    "prompt_for_download": false,
    "default_directory": "/tmp"
  }
}
PREFS
touch /tmp/.chromium/'First Run'
chown sandbox:sandbox /tmp/.chromium/Default/Preferences /tmp/.chromium/'First Run'

# Chrome flags — kiosk mode removes close/minimize buttons so users can't kill it via VNC.
# Container must have SYS_ADMIN capability for Chrome's internal sandbox.
# Flags chosen to look like a normal browser — no --test-type, --enable-automation, --headless.
CHROME_FLAGS='--disable-gpu --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --window-size=1280,720 \
  --kiosk \
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
  --user-data-dir=/tmp/.chromium chrome://newtab'

su -s /bin/sh sandbox -c "chromium $CHROME_FLAGS 2>/dev/null" &

# Wait for Chromium CDP to be ready
for i in $(seq 1 20); do
  if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Expose CDP on 0.0.0.0 — Chromium ignores --remote-debugging-address in newer versions
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

echo "Sandbox ready (CDP: ws://0.0.0.0:9223, VNC: http://0.0.0.0:6080/vnc.html)"

# Keep alive
exec tail -f /dev/null
