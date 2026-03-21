#!/bin/bash
# Package the SEA binary into a macOS .app bundle
# Usage: scripts/package-macos.sh [signing-identity]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="dist/sea/agent-orcha"
APP_NAME="Agent Orcha"
BUNDLE_ID="com.agentorcha.app"
APP_DIR="dist/sea/${APP_NAME}.app"
VERSION=$(cat dist/sea/version.txt 2>/dev/null || echo "1.0.0")
SIGNING_IDENTITY="${1:--}"
ENTITLEMENTS="${SCRIPT_DIR}/entitlements.plist"
ICON="${SCRIPT_DIR}/AppIcon.icns"

if [ ! -f "$BINARY" ]; then
  echo "Error: SEA binary not found at $BINARY"
  echo "Run 'node scripts/build-sea.mjs' first."
  exit 1
fi

echo "Packaging ${APP_NAME}.app (v${VERSION})..."

# Clean previous build
rm -rf "$APP_DIR"

# Create .app bundle structure
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy binary
cp "$BINARY" "$APP_DIR/Contents/MacOS/agent-orcha"

# Copy icon
if [ -f "$ICON" ]; then
  cp "$ICON" "$APP_DIR/Contents/Resources/AppIcon.icns"
fi

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleExecutable</key>
    <string>agent-orcha</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppNapDisabled</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
PLIST

# Sign the .app bundle
echo "Signing with: ${SIGNING_IDENTITY}"
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --deep --sign "$SIGNING_IDENTITY" "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

echo ""
echo "Created: $APP_DIR"
echo "Version: $VERSION"
du -sh "$APP_DIR" | awk '{print "Size:    " $1}'
