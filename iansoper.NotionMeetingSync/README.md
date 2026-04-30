# Notion Meeting Sync

Syncs meeting notes from **Notion** into **NotePlan** as structured markdown files — pulling from two sources: your **Fireflies** meetings database and **native Notion meeting recordings**.

---

## How it works

```
Notion (Fireflies DB)  ──API──▶  NotePlan plugin
Notion (native recordings)  ──API──▶  NotePlan plugin
                                          │
                                 writes structured .md notes
                                 into your configured folder
```

The plugin queries the Notion API directly from NotePlan. It tracks the last sync timestamp so only new or updated meetings are imported on subsequent runs. Use **Clear Last Sync** to force a full re-import.

---

## Files

```
iansoper.NotionMeetingSync/
├── plugin.json   ← NotePlan plugin manifest
└── script.js     ← NotePlan plugin logic
```

---

## Setup

### 1 — Install the NotePlan plugin

1. Open Finder and navigate to:
   `~/Library/Application Support/NotePlan/Plugins/`
2. Create a folder named `iansoper.NotionMeetingSync`
3. Copy `plugin.json` and `script.js` into it
4. In NotePlan, open **Preferences → Plugins** and enable the plugin

### 2 — Create a Notion integration

1. Go to [notion.so/my-integrations](https://notion.so/my-integrations) and create a new integration
2. Copy the **Internal Integration Token** (starts with `ntn_` or `secret_`)
3. Open each Notion database you want to sync and click **Connect** to grant access to your integration

### 3 — Configure the plugin

In NotePlan, press `⌘J`, type **Sync Notion Meetings**, then open plugin settings:

| Setting | Description | Example |
|---------|-------------|---------|
| Notion API Token | Your integration token | `ntn_abc123…` |
| Fireflies Database ID | Notion DB ID from the URL (leave blank to skip) | `abc123def456…` |
| Sync Folder | NotePlan folder for synced notes | `0_Inbox` |
| Last Sync Timestamp | Set automatically; clear to force full re-sync | _(auto)_ |

**Finding your database ID:** open the database in Notion, copy the URL, and extract the ID between the last `/` and `?v=`:
```
notion.so/workspace/abc123def456789...?v=...
                    └─ this is the database ID
```

---

## Usage

In NotePlan command bar (`⌘J`):

| Command | What it does |
|---------|-------------|
| **Sync Notion Meetings** | Import new/updated meetings from Notion |
| **Notion Sync: Clear Last Sync** | Reset timestamp to force full re-import on next run |

---

## Output format

Each meeting is written as a separate note in your configured folder:

```markdown
---
title: "Design Review"
date: 2025-04-30
attendees: "Ian Soper, Jane Doe"
host: "Ian Soper"
source: fireflies
notion_url: https://notion.so/...
synced: 2025-04-30
tags: meeting, notion-sync, fireflies
---

# Design Review
*2025-04-30*
**Attendees:** Ian Soper, Jane Doe
**Host:** Ian Soper

## Action Items
* [ ] Update button radius tokens
* [ ] Share Figma link with dev team

## Summary
Reviewed the Meridian design system tokens…

## Notes
- Discussed colour palette changes
- Agreed on spacing scale

## Full Notes
…full body content from Notion…

---
[View in Notion](https://notion.so/...)
[Transcript](https://fireflies.ai/...)
```

---

## Troubleshooting

**No meetings imported**
- Confirm the Notion token starts with `ntn_` or `secret_` and the integration has access to the database
- Try **Notion Sync: Clear Last Sync** and run again to force a full re-import

**Wrong folder**
- The `Sync Folder` must exactly match an existing NotePlan folder path (e.g. `0_Inbox`, `1_Projects/Work`). The plugin logs available folders on each sync run.

**Fireflies meetings not appearing**
- Confirm the Fireflies Database ID is correct and the integration is connected to that database in Notion

---

## Limitations

- Requires a Notion integration token with read access to the target databases
- Native meeting recordings are synced by page URL to avoid duplicates; deleting the NotePlan note and re-syncing will recreate it
- The `lastSync` timestamp is based on Notion's `last_edited_time` — meetings edited in Notion after initial sync will be re-imported
