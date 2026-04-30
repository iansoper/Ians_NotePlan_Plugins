# 🤝 Amie Meeting Sync for NotePlan

Syncs meeting notes, summaries, action items, and audio from **Amie** into **NotePlan** — writing individual meeting notes and appending a summary block to your daily note after every call.

---

## How it works

```
Amie (on meeting end)
  └─► POST webhook ─► Relay server (localhost:3747)
                            │
                            ├─ stores meeting data
                            └─ downloads audio locally

NotePlan plugin (on demand)
  └─► GET /meetings ─► Relay server
                            │
                            └─► writes .md meeting note + daily note block
```

The **relay** is a small Node.js server that runs in the background on your Mac. It receives webhooks from Amie, stores the meeting data, and serves it to the NotePlan plugin on request. It runs as a macOS **LaunchAgent**, so it starts automatically at login.

---

## Files

```
iansoper.AmieSync/
├── plugin.json           NotePlan plugin manifest
├── script.js             NotePlan plugin logic
├── install-relay.sh      One-time installer — run this first
├── uninstall-relay.sh    Removes the relay LaunchAgent
└── relay/
    └── server.js         The relay server (Node.js, zero npm dependencies)
```

---

## Requirements

- **NotePlan 3.9+** (macOS)
- **Node.js** — install with `brew install node` if you don't have it

---

## Installation

### Step 1 — Install the NotePlan plugin

1. In Finder, go to `~/Library/Application Support/NotePlan 3/Plugins/`
2. Copy the entire `iansoper.AmieSync/` folder into it
3. In NotePlan, open **Preferences → Plugins** — the plugin will appear automatically

### Step 2 — Install the relay server

Open **Terminal** and run:

```bash
bash ~/Library/Application\ Support/NotePlan\ 3/Plugins/iansoper.AmieSync/install-relay.sh
```

The installer will:
- Verify Node.js is available
- Generate a random API key
- Install a LaunchAgent so the relay starts automatically at login
- Start the relay immediately
- Print your API key and next steps

When it finishes you'll see something like:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Setup complete!

  Next steps:
  1. In NotePlan, run: Configure Amie Sync
     • Relay URL:  http://localhost:3747
     • API Key:    a1b2c3d4e5f6...

  2. In Amie → Settings → Integrations → API:
     Add webhook URL (needs a public tunnel):
     npx cloudflared tunnel --url http://localhost:3747

  3. Run: Sync Amie Meetings
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

> Your API key is also saved to `iansoper.AmieSync/.relay-api-key` in case you need it later.

### Step 3 — Configure the NotePlan plugin

In NotePlan, press `⌘J` and run **Configure Amie Sync**. Enter the values printed by the installer:

| Setting | Value |
|---|---|
| Relay URL | `http://localhost:3747` |
| API Key | _(printed by installer, or check `.relay-api-key`)_ |
| Meeting notes folder | `Meetings` _(or your preference)_ |
| Action item tag | `#amie` _(or your preference)_ |

### Step 4 — Connect Amie webhooks

Amie's webhooks are in **Early Access** — enable them at **Settings → Integrations → API**.

Amie needs a public HTTPS URL to POST to. The easiest way on a Mac is a free Cloudflare tunnel:

```bash
npx cloudflared tunnel --url http://localhost:3747
```

This prints a URL like `https://abc123.trycloudflare.com`. In Amie, add:

```
https://abc123.trycloudflare.com/webhook
```

> Free tunnels generate a new URL each time you run the command. For a permanent URL, use a paid [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [ngrok](https://ngrok.com) plan.

---

## Uninstallation

To stop the relay and remove it from auto-start, open Terminal and run:

```bash
bash ~/Library/Application\ Support/NotePlan\ 3/Plugins/iansoper.AmieSync/uninstall-relay.sh
```

This will:
- Stop the relay immediately
- Remove the LaunchAgent (so it no longer starts at login)
- Remove the saved API key file

Your meeting data at `~/Documents/AmieMeetings/` is **not deleted**. To remove that too:

```bash
rm -rf ~/Documents/AmieMeetings/
```

To remove the plugin itself, delete the folder:

```bash
rm -rf ~/Library/Application\ Support/NotePlan\ 3/Plugins/iansoper.AmieSync/
```

---

## Usage

Once set up, meetings sync automatically when Amie sends a webhook after each call ends. You can also sync manually from the NotePlan command bar (`⌘J`):

| Command | What it does |
|---|---|
| **Sync Amie Meetings** | Syncs today's meetings |
| **Sync Amie Meetings for Date Range** | Pick a custom start and end date |
| **Amie Relay Status** | Check if the relay is running and how many meetings are stored |
| **Configure Amie Sync** | Update relay URL, API key, folder, and tag settings |

---

## What gets created in NotePlan

### Individual meeting note — `Meetings/2025-04-30 Design Review.md`

```markdown
# Design Review

**Date:** 2025-04-30
**Time:** 10:00 AM – 11:00 AM
**Platform:** Google Meet
**Meeting ID:** amie_abc123

---

## 👥 Attendees
- Ian Soper <ian@example.com>
- Jane Doe <jane@example.com>

---

## 📋 Summary
Reviewed the Meridian design system token architecture…

---

## ✅ Action Items
* [ ] Update button radius tokens #amie @ian >2025-05-02
* [ ] Share Figma link with dev team #amie

---

## 🎙 Recording
[Open Audio](file:///Users/ian/Documents/AmieMeetings/audio/2025-04-30 Design Review.m4a)
```

### Daily note block — appended to `2025-04-30.md`

```markdown
## Meetings
<!-- amie-sync:amie_abc123 -->
### 10:00 AM–11:00 AM Design Review
  📄 [[2025-04-30 Design Review]]
  🎙 [Recording](file://…)
  * [ ] Update button radius tokens #amie @ian >2025-05-02
  * [ ] Share Figma link with dev team #amie
```

---

## Troubleshooting

**Relay won't start after installing**
Check the log for errors:
```bash
tail -f ~/Documents/AmieMeetings/relay.log
```

**"Relay is not running" when I try to sync**
The LaunchAgent may not have loaded yet (e.g. after a fresh install before a login). Start it manually for this session:
```bash
launchctl load ~/Library/LaunchAgents/io.iansoper.amie-relay.plist
```

**Node.js not found during install**
Install it via Homebrew:
```bash
brew install node
```
Then re-run `install-relay.sh`.

**Relay is running but no meetings appear**
- Confirm Amie's webhook is pointing at your tunnel URL + `/webhook`
- Check the relay log for incoming webhook events: `tail -f ~/Documents/AmieMeetings/relay.log`
- Verify the health endpoint: `curl http://localhost:3747/health`

**Duplicate meetings in my daily note**
Re-running sync won't create duplicates — each meeting block is keyed by its Amie meeting ID. If you see duplicates, they came from separate webhook deliveries with different IDs.

---

## Data locations

| What | Where |
|---|---|
| Meeting data (JSON) | `~/Documents/AmieMeetings/meetings.json` |
| Audio recordings | `~/Documents/AmieMeetings/audio/` |
| Relay log | `~/Documents/AmieMeetings/relay.log` |
| API key | `iansoper.AmieSync/.relay-api-key` |
| LaunchAgent plist | `~/Library/LaunchAgents/io.iansoper.amie-relay.plist` |
