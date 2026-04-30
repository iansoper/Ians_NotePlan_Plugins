#!/bin/bash
# ============================================================
# 🤝 Amie Sync — Relay Uninstaller
# Stops and removes the relay LaunchAgent from your Mac.
# Your meeting data and audio files are NOT deleted.
# ============================================================

PLIST_NAME="io.iansoper.amie-relay"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_FILE="$SCRIPT_DIR/.relay-api-key"

echo "🤝 Amie Sync — Relay Uninstaller"
echo ""

# ─── Stop and unload the LaunchAgent ────────────────────────
if [ -f "$PLIST_PATH" ]; then
  echo "Stopping relay..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "✅ LaunchAgent stopped and removed."
else
  echo "ℹ️  No LaunchAgent found at $PLIST_PATH — already uninstalled."
fi

# ─── Remove the saved API key ────────────────────────────────
if [ -f "$KEY_FILE" ]; then
  rm -f "$KEY_FILE"
  echo "✅ API key file removed."
fi

# ─── Confirm relay is no longer responding ───────────────────
sleep 1
STATUS=$(curl -s http://localhost:3747/health 2>/dev/null || true)
if echo "$STATUS" | grep -q '"ok"'; then
  echo ""
  echo "⚠️  The relay is still responding on port 3747."
  echo "   It may have been started outside of the LaunchAgent."
  echo "   Find and stop the process manually:"
  echo "   lsof -i :3747"
else
  echo "✅ Relay is no longer running."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Uninstall complete."
echo ""
echo "  Your meeting data is kept at:"
echo "  ~/Documents/AmieMeetings/"
echo ""
echo "  To remove that data too:"
echo "  rm -rf ~/Documents/AmieMeetings/"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
