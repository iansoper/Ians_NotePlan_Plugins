#!/bin/bash
# ============================================================
# 🤝 Amie Sync — Relay Installer
# Run once from Terminal to install the auto-start LaunchAgent.
# ============================================================

set -e

# ─── Resolve paths ──────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_SCRIPT="$SCRIPT_DIR/relay/server.js"
PLIST_NAME="io.iansoper.amie-relay"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$HOME/Documents/AmieMeetings"
AUDIO_DIR="$LOG_DIR/audio"
LOG_FILE="$LOG_DIR/relay.log"
PID_FILE="/tmp/amie-relay.pid"
PORT="${PORT:-3747}"
API_KEY="${API_KEY:-}"

# ─── Checks ─────────────────────────────────────────────────
echo "🤝 Amie Sync — Relay Installer"
echo ""

if [ ! -f "$RELAY_SCRIPT" ]; then
  echo "❌ relay/server.js not found at: $RELAY_SCRIPT"
  echo "   Make sure you are running this from the plugin folder."
  exit 1
fi

# Find node
NODE_PATH=$(command -v node 2>/dev/null || true)
if [ -z "$NODE_PATH" ]; then
  # Try common locations
  for p in /opt/homebrew/bin/node /usr/local/bin/node ~/.nvm/versions/node/*/bin/node; do
    if [ -x "$p" ]; then NODE_PATH="$p"; break; fi
  done
fi

if [ -z "$NODE_PATH" ]; then
  echo "❌ Node.js not found. Install it with: brew install node"
  exit 1
fi

echo "✅ Node: $NODE_PATH ($(\"$NODE_PATH\" --version))"
echo "✅ Relay script: $RELAY_SCRIPT"

# Generate a random API key if none set
if [ -z "$API_KEY" ]; then
  API_KEY=$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 32 2>/dev/null || openssl rand -hex 16)
  echo "✅ Generated API key: $API_KEY"
  echo "   (Save this — you'll need it in NotePlan's plugin settings)"
fi

# ─── Create directories ─────────────────────────────────────
mkdir -p "$LOG_DIR" "$AUDIO_DIR"

# ─── Unload existing agent if present ───────────────────────
if [ -f "$PLIST_DEST" ]; then
  echo "↺  Unloading existing LaunchAgent..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# ─── Write the plist ────────────────────────────────────────
cat > "$PLIST_DEST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${RELAY_SCRIPT}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>API_KEY</key>
    <string>${API_KEY}</string>
    <key>AUDIO_FOLDER</key>
    <string>${AUDIO_DIR}</string>
    <key>LOG_FILE</key>
    <string>${LOG_FILE}</string>
  </dict>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
PLIST

echo "✅ LaunchAgent written: $PLIST_DEST"

# ─── Load and start ─────────────────────────────────────────
launchctl load "$PLIST_DEST"
echo "✅ LaunchAgent loaded and started."

# Wait for it to come up
echo -n "   Waiting for relay to start"
for i in $(seq 1 10); do
  sleep 1
  echo -n "."
  STATUS=$(curl -s http://localhost:$PORT/health 2>/dev/null || true)
  if echo "$STATUS" | grep -q '"ok"'; then
    echo ""
    echo "✅ Relay is running at http://localhost:$PORT"
    break
  fi
done

if ! echo "$STATUS" | grep -q '"ok"'; then
  echo ""
  echo "⚠️  Relay didn't respond within 10s. Check the log:"
  echo "   tail -f $LOG_FILE"
  exit 1
fi

# ─── Done ───────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. In NotePlan, run: Configure Amie Sync"
echo "     • Relay URL:  http://localhost:$PORT"
echo "     • API Key:    $API_KEY"
echo ""
echo "  2. In Amie → Settings → Integrations → API:"
echo "     Add webhook URL (needs a public tunnel):"
echo "     npx cloudflared tunnel --url http://localhost:$PORT"
echo ""
echo "  3. Run: Sync Amie Meetings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Also write the API key to a local file so it's not lost
KEY_FILE="$SCRIPT_DIR/.relay-api-key"
echo "$API_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
echo ""
echo "  API key saved to: $KEY_FILE"
