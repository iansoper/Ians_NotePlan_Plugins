# Amie → NotePlan Meeting Sync

Syncs meeting notes, summaries, action items, and audio from **Amie** into **NotePlan** automatically — including your daily notes and individual meeting note files.

---

## How it works

```
Amie app  ──webhook──▶  Relay server (localhost:3747)
                                │
                         stores payloads
                                │
NotePlan plugin  ──fetch──▶  /meetings?start=…
                                │
                     writes structured .md notes
```

Because Amie's webhook support is **early access** and fires on meeting completion, no polling is needed — the relay is a lightweight buffer that the NotePlan plugin reads from on demand.

---

## Files

```
iansoper.AmieSync/
├── plugin.json           ← NotePlan plugin manifest
├── script.js             ← NotePlan plugin logic
└── relay/
    ├── server.js         ← Webhook relay (Node.js, no dependencies)
    └── io.amie.noteplan-relay.plist  ← macOS LaunchAgent (auto-start)
```

---

## Setup

### 1 — Install the NotePlan plugin

1. Open Finder and navigate to:
   `~/Library/Application Support/NotePlan/Plugins/`
2. Create a folder named `iansoper.AmieSync`
3. Copy `plugin.json` and `script.js` into it
4. In NotePlan, open **Preferences → Plugins** and enable the plugin
5. Optionally create the `relay/` sub-folder there too (for auto-start)

### 2 — Start the relay server

**Option A — manual (for testing)**
```bash
node /path/to/relay/server.js
```

You should see:
```
✅ Relay listening at http://127.0.0.1:3747
```

**Option B — auto-start on login (recommended)**

```bash
# Edit the plist — replace YOUR_USERNAME and paths:
nano relay/io.amie.noteplan-relay.plist

# Install:
cp relay/io.amie.noteplan-relay.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/io.amie.noteplan-relay.plist
```

To verify it's running:
```bash
curl http://localhost:3747/health
# → {"status":"ok","version":"1.0.0"}
```

### 3 — Connect Amie webhooks

Amie's webhook feature is in **Early Access**. To enable it:

1. Open Amie → **Settings → Integrations → API**
2. Create a new webhook endpoint
3. You need a **public URL** pointing to your relay's `/webhook` path

**Get a public URL** (free options):
```bash
# Cloudflared (recommended — free, stable):
npx cloudflared tunnel --url http://localhost:3747

# ngrok:
ngrok http 3747
```

Copy the public URL shown (e.g. `https://abc123.trycloudflare.com`) and paste it into Amie as:
```
https://abc123.trycloudflare.com/webhook
```

> **Note:** Free tunnels get a new URL each restart. For a permanent URL, use a paid Cloudflare Tunnel or ngrok plan. Alternatively, you can also **manually trigger a sync** (see below).

### 4 — Configure the NotePlan plugin

In NotePlan, press `⌘J`, type **Configure Amie Sync**, and enter:

| Setting | Example |
|---------|---------|
| Relay URL | `http://localhost:3747` |
| API Key | `change-me-to-a-random-secret` _(match your plist)_ |
| Meeting folder | `Meetings` |
| Task tag | `#amie` |

---

## Usage

### Auto-sync (recommended)
Meetings sync automatically once Amie sends the webhook after each meeting ends.

### Manual sync
In NotePlan command bar (`⌘J`):

| Command | What it does |
|---------|-------------|
| **Sync Amie Meetings** | Syncs today's meetings |
| **Sync Amie Meetings (Date Range)** | Pick a custom date range |
| **Configure Amie Sync** | Change settings |

---

## Output format

### Individual meeting note (`Meetings/2025-04-30 Design Review.md`)

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
Reviewed the Meridian design system tokens…

---

## ✅ Action Items
* [ ] Update button radius tokens #amie @ian >2025-05-02
* [ ] Share Figma link with dev team #amie

---

## 🎙 Recording
[Open Audio](file:///Users/ian/Documents/AmieMeetings/audio/2025-04-30 Design Review.m4a)
```

### Daily note block (`2025-04-30.md`)

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

## Audio files

When Amie provides an `audioUrl` in the webhook, the relay automatically downloads the file to:
```
~/Documents/AmieMeetings/audio/YYYY-MM-DD Meeting Title.m4a
```

The NotePlan plugin then links to the local file, so recordings open directly in Quick Look or your audio player.

---

## Troubleshooting

**Relay won't start**
- Make sure Node.js is installed: `node --version`
- Check the log: `~/Documents/AmieMeetings/relay.log`

**No meetings returned**
- Confirm the relay is running: `curl http://localhost:3747/health`
- Check the relay status: `curl -H "x-api-key: your-key" http://localhost:3747/status`

**Webhook not firing**
- Check Amie's Early Access webhook status in Settings → Integrations → API
- Test manually: in Amie you can trigger a webhook send from the API page

**Duplicate daily note blocks**
- Each meeting is keyed by its Amie ID — re-running sync won't duplicate entries

---

## Limitations

- Amie's webhook feature is **Early Access** — the payload shape may change
- A public tunnel is needed for Amie to reach your local relay (unless you deploy the relay to a VPS)
- Audio download requires the audio URL to be publicly accessible from your Mac

---

## Extending

The relay's `/meetings` API returns raw JSON, so you can also query it from:
- Shortcuts (Apple Shortcuts app)  
- any script that can do HTTP GET

The relay stores all meetings in `~/Documents/AmieMeetings/meetings.json` — plain JSON, easy to inspect.
