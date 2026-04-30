// ============================================================
// 🤝 Amie Meeting Sync — NotePlan Plugin
// iansoper.AmieSync / script.js
//
// Syncs Amie meeting notes, summaries, action items, and audio
// into NotePlan daily and project notes.
//
// Auto-start: The relay server is managed by a macOS LaunchAgent
// installed via install-relay.sh (run once from Terminal).
// The plugin checks relay health on each sync and shows clear
// instructions if it isn't running.
// ============================================================

/* global DataStore, Editor, CommandBar, NotePlan */

// ─── Settings ───────────────────────────────────────────────

function getSetting(key) {
  return DataStore.settings?.[key] ?? ''
}

// ─── Logging ─────────────────────────────────────────────────

function log(msg) {
  console.log(`[iansoper.AmieSync] ${msg}`)
}

// ─── Date / time helpers ─────────────────────────────────────

function formatDate(dateStr) {
  return new Date(dateStr).toISOString().split('T')[0]
}

function formatTime(dateStr) {
  const d = new Date(dateStr)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

// ─── Relay health check ──────────────────────────────────────
//
// NotePlan's fetch() is HTTPS-only for external URLs, but
// localhost HTTP is allowed because it never leaves the machine.

async function isRelayRunning(relayUrl) {
  return new Promise(resolve => {
    fetch(`${relayUrl}/health`, { timeout: 2000 })
      .then(resp => {
        if (!resp || resp === '') { resolve(false); return }
        const data = typeof resp === 'string' ? JSON.parse(resp) : resp
        resolve(data.status === 'ok')
      })
      .catch(() => resolve(false))
  })
}

// ─── Relay guard ─────────────────────────────────────────────
//
// The relay runs as a macOS LaunchAgent, started automatically
// at login by install-relay.sh. This function checks whether
// it's up and shows actionable instructions if not.

async function ensureRelay() {
  const relayUrl = getSetting('relayUrl') || 'http://localhost:3747'
  const running  = await isRelayRunning(relayUrl)

  if (running) {
    log('Relay is up.')
    return true
  }

  log('Relay not responding.')

  // Show a clear, actionable prompt — no silent failures.
  const choice = await CommandBar.showOptions(
    [
      '📋 Show setup instructions',
      '🔁 Retry (I just started it manually)',
      '✕ Cancel',
    ],
    '⚠️ Amie relay server is not running'
  )

  if (!choice || choice.index === 2) return false

  if (choice.index === 0) {
    // Write setup instructions into a new NotePlan note so the
    // user has them available without leaving the app.
    await showSetupNote()
    return false
  }

  if (choice.index === 1) {
    // One more try after user says they started it
    const retryOk = await isRelayRunning(relayUrl)
    if (retryOk) {
      log('Relay up after retry.')
      return true
    }
    await CommandBar.showInput(
      'Still not responding. Check Terminal for errors.\n\nLog file: ~/Documents/AmieMeetings/relay.log',
      'OK'
    )
    return false
  }

  return false
}

async function showSetupNote() {
  const content = `# 🤝 Amie Sync — Relay Setup

The Amie Sync plugin requires a small background server (the "relay") to receive
webhooks from Amie and serve them to NotePlan.

## One-time setup (takes ~2 minutes)

Open Terminal and run:

\`\`\`bash
# 1. Navigate to the plugin folder
cd ~/Library/Application\\ Support/NotePlan\\ 3/Plugins/iansoper.AmieSync/

# 2. Run the installer (installs a LaunchAgent so the relay starts at login)
bash install-relay.sh
\`\`\`

The relay will start immediately and auto-start on every login from then on.

## Manual start (if you skipped the installer)

\`\`\`bash
node ~/Library/Application\\ Support/NotePlan\\ 3/Plugins/iansoper.AmieSync/relay/server.js
\`\`\`

## Check relay status

Run *Amie Relay Status* from the NotePlan command bar, or:

\`\`\`bash
curl http://localhost:3747/health
\`\`\`

## Relay log

\`~/Documents/AmieMeetings/relay.log\`
`

  try {
    const existing = DataStore.noteByTitle('Amie Sync — Relay Setup', 'Notes', false)
    if (existing) {
      existing.content = content
      await Editor.openNoteByTitle('Amie Sync — Relay Setup')
    } else {
      await DataStore.newNoteWithContent(content, '', 'Amie Sync — Relay Setup')
      await Editor.openNoteByTitle('Amie Sync — Relay Setup')
    }
  } catch (err) {
    // Fallback: show in command bar
    await CommandBar.showInput(
      'Run this in Terminal to install the relay:\n\nbash ~/Library/Application\\ Support/NotePlan\\ 3/Plugins/iansoper.AmieSync/install-relay.sh',
      'OK'
    )
  }
}

// ─── Relay API fetch ─────────────────────────────────────────

async function fetchMeetings(startDate, endDate) {
  const relayUrl = getSetting('relayUrl') || 'http://localhost:3747'
  const apiKey   = getSetting('apiKey')   || ''
  const url      = `${relayUrl}/meetings?start=${startDate}&end=${endDate || startDate}`

  return new Promise((resolve) => {
    fetch(url, {
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      timeout: 15000,
    })
      .then(resp => {
        if (!resp || resp === '') { resolve([]); return }
        const data = typeof resp === 'string' ? JSON.parse(resp) : resp
        resolve(Array.isArray(data.meetings) ? data.meetings : [])
      })
      .catch(err => {
        log('fetchMeetings error: ' + err)
        resolve(null)
      })
  })
}

// ─── Note builder ────────────────────────────────────────────

function buildMeetingNote(meeting, taskTag) {
  const date  = formatDate(meeting.startAt)
  const start = formatTime(meeting.startAt)
  const end   = formatTime(meeting.endAt)
  const tag   = taskTag || '#amie'

  const attendeeList = (meeting.attendees || [])
    .map(a => `- ${a.name}${a.email ? ` <${a.email}>` : ''}`)
    .join('\n')

  const actionItems = (meeting.actionItems || [])
    .map(item => {
      let line = `* [ ] ${item.text} ${tag}`
      if (item.assignee) line += ` @${item.assignee.replace(/\s+/g, '_')}`
      if (item.dueDate)  line += ` >${item.dueDate}`
      return line
    })
    .join('\n')

  const audioSection    = meeting.audioUrl     ? `## 🎙 Recording\n[Open Audio](${meeting.audioUrl})\n` : ''
  const transcriptSection = meeting.transcript ? `## 📝 Transcript\n${meeting.transcript.trim()}\n`     : ''
  const privateSection  = meeting.privateNotes ? `## 🔒 Private Notes\n${meeting.privateNotes.trim()}\n` : ''

  return `# ${meeting.title}

**Date:** ${date}
**Time:** ${start} – ${end}
**Platform:** ${meeting.platform || 'Unknown'}
**Meeting ID:** ${meeting.id}

---

## 👥 Attendees
${attendeeList || '_None recorded_'}

---

## 📋 Summary
${(meeting.summary || '_No summary available_').trim()}

---

## ✅ Action Items
${actionItems || '_No action items_'}

---

${audioSection}${privateSection}${transcriptSection}`.trim()
}

// ─── Daily note block ────────────────────────────────────────

function buildDailyBlock(meeting, noteTitle, taskTag) {
  const start = formatTime(meeting.startAt)
  const end   = formatTime(meeting.endAt)
  const tag   = taskTag || '#amie'

  const actionLines = (meeting.actionItems || [])
    .map(item => {
      let line = `  * [ ] ${item.text} ${tag}`
      if (item.assignee) line += ` @${item.assignee.replace(/\s+/g, '_')}`
      if (item.dueDate)  line += ` >${item.dueDate}`
      return line
    })
    .join('\n')

  const audioLink = meeting.audioUrl ? `  🎙 [Recording](${meeting.audioUrl})\n` : ''
  const noteLink  = noteTitle ? `  📄 [[${noteTitle}]]\n` : ''

  return `### ${start}–${end} ${meeting.title}\n${noteLink}${audioLink}${actionLines ? actionLines + '\n' : ''}`
}

// ─── Write meeting note ──────────────────────────────────────

async function writeMeetingNote(meeting, folder, taskTag) {
  const date     = formatDate(meeting.startAt)
  const safeName = meeting.title.replace(/[/\\?%*:|"<>]/g, '-').trim()
  const title    = `${date} ${safeName}`
  const content  = buildMeetingNote(meeting, taskTag)

  try {
    const existing = DataStore.noteByTitle(title, 'Notes', false)
    if (existing) {
      existing.content = content
      log(`Updated: ${title}`)
    } else {
      await DataStore.newNoteWithContent(content, folder, title)
      log(`Created: ${title}`)
    }
    return title
  } catch (err) {
    log('writeMeetingNote error: ' + JSON.stringify(err))
    return null
  }
}

// ─── Append to daily note ────────────────────────────────────

async function appendToDailyNote(meeting, noteTitle, taskTag) {
  const date = formatDate(meeting.startAt)
  try {
    const dailyNote = DataStore.calendarNoteByDateString(date)
    if (!dailyNote) { log(`No daily note for ${date}`); return }

    const marker = `<!-- amie-sync:${meeting.id} -->`
    if (dailyNote.content.includes(marker)) { log(`Already in daily note: ${meeting.id}`); return }

    const block = buildDailyBlock(meeting, noteTitle, taskTag)

    if (dailyNote.content.includes('## Meetings')) {
      dailyNote.content = dailyNote.content.replace(/## Meetings\n/, `## Meetings\n${marker}\n${block}\n`)
    } else {
      dailyNote.content += `\n\n## Meetings\n${marker}\n${block}`
    }

    log(`Appended to daily note: ${date}`)
  } catch (err) {
    log('appendToDailyNote error: ' + JSON.stringify(err))
  }
}

// ─── Core sync ───────────────────────────────────────────────

async function runSync(startDate, endDate) {
  const folder      = getSetting('meetingFolder') || 'Meetings'
  const appendDaily = getSetting('appendToDaily') !== false
  const taskTag     = getSetting('taskTag') || '#amie'

  const relayOk = await ensureRelay()
  if (!relayOk) return

  log(`Syncing ${startDate} → ${endDate || startDate}`)

  const meetings = await fetchMeetings(startDate, endDate)

  if (meetings === null) {
    await CommandBar.showInput('Could not reach the relay server. Check the log: ~/Documents/AmieMeetings/relay.log', 'OK')
    return
  }

  if (meetings.length === 0) {
    await CommandBar.showInput(
      `No meetings found for ${startDate}${endDate && endDate !== startDate ? ' – ' + endDate : ''}.`,
      'OK'
    )
    return
  }

  for (const meeting of meetings) {
    const noteTitle = await writeMeetingNote(meeting, folder, taskTag)
    if (appendDaily) await appendToDailyNote(meeting, noteTitle, taskTag)
  }

  await CommandBar.showInput(
    `✅ Synced ${meetings.length} meeting${meetings.length !== 1 ? 's' : ''} → ${folder}/`,
    'Done'
  )
}

// ─── Commands ────────────────────────────────────────────────

async function syncAmieMeetings() {
  try {
    await runSync(todayStr())
  } catch (err) {
    log('syncAmieMeetings error: ' + JSON.stringify(err))
    await CommandBar.showInput('Sync failed: ' + err.message, 'Dismiss')
  }
}

async function syncAmieMeetingsRange() {
  try {
    const start = await CommandBar.showInput('Start date (YYYY-MM-DD)', 'Next')
    if (!start) return
    const end = await CommandBar.showInput('End date (YYYY-MM-DD) — leave blank for single day', 'Sync')
    await runSync(start.trim(), end?.trim() || start.trim())
  } catch (err) {
    log('syncAmieMeetingsRange error: ' + JSON.stringify(err))
  }
}

async function relayStatusCommand() {
  try {
    const relayUrl = getSetting('relayUrl') || 'http://localhost:3747'
    const apiKey   = getSetting('apiKey')   || ''
    const running  = await isRelayRunning(relayUrl)

    if (running) {
      const detail = await new Promise(resolve => {
        fetch(`${relayUrl}/status`, { headers: { 'x-api-key': apiKey }, timeout: 3000 })
          .then(resp => {
            if (!resp) { resolve(''); return }
            const d = typeof resp === 'string' ? JSON.parse(resp) : resp
            resolve(`\nMeetings stored: ${d.totalMeetings ?? '?'}`)
          })
          .catch(() => resolve(''))
      })
      await CommandBar.showInput(`✅ Relay is running at ${relayUrl}${detail}`, 'OK')
    } else {
      await CommandBar.showInput(
        `❌ Relay is not running.\n\nTo install and auto-start it, run in Terminal:\n\nbash ~/Library/Application\\ Support/NotePlan\\ 3/Plugins/iansoper.AmieSync/install-relay.sh`,
        'OK'
      )
    }
  } catch (err) {
    log('relayStatusCommand error: ' + JSON.stringify(err))
  }
}

async function configureAmieSync() {
  try {
    const relayUrl = await CommandBar.showInput('Relay URL (default: http://localhost:3747)', 'Save')
    const apiKey   = await CommandBar.showInput('Relay API key (leave blank if none)', 'Save')
    const folder   = await CommandBar.showInput('Meeting notes folder (default: Meetings)', 'Save')
    const taskTag  = await CommandBar.showInput('Action item tag (default: #amie)', 'Save')

    DataStore.settings = {
      ...DataStore.settings,
      relayUrl:      relayUrl?.trim()  || 'http://localhost:3747',
      apiKey:        apiKey?.trim()    || '',
      meetingFolder: folder?.trim()    || 'Meetings',
      taskTag:       taskTag?.trim()   || '#amie',
      appendToDaily: true,
    }

    await CommandBar.showInput('✅ Settings saved. Run "Sync Amie Meetings" to import today\'s meetings.', 'Done')
  } catch (err) {
    log('configureAmieSync error: ' + JSON.stringify(err))
  }
}
