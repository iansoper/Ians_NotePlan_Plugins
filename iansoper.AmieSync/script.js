// ============================================================
// Amie Meeting Sync — NotePlan Plugin
// iansoper.AmieSync / script.js
//
// Pulls meeting data from the local Amie webhook relay and
// writes structured notes into NotePlan calendar and project notes.
//
// The relay server (relay/server.js) is started automatically
// if it isn't already running, using a background shell script.
// ============================================================

/* global DataStore, Editor, CommandBar, NotePlan */

// ─── Helpers ────────────────────────────────────────────────

function getSetting(key) {
  return DataStore.settings?.[key] ?? ''
}

function log(msg) {
  console.log(`[iansoper.AmieSync] ${msg}`)
}

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

// ─── Relay path resolution ───────────────────────────────────
//
// The relay script lives alongside this plugin in the NotePlan
// Plugins folder. We resolve the path from DataStore.pluginPath
// (available in NotePlan 3.7+) or fall back to a configurable
// setting so the user can override it if needed.

function relayScriptPath() {
  const override = getSetting('relayScriptPath')
  if (override) return override

  // DataStore.pluginPath returns the folder of THIS plugin
  const pluginDir = DataStore.pluginPath ?? ''
  if (pluginDir) {
    return `${pluginDir}/relay/server.js`
  }

  // Last-resort hardcoded default (SetApp path)
  return `${NotePlan.environment.homePath}/Library/Application Support/NotePlan 3/Plugins/iansoper.AmieSync/relay/server.js`
}

// ─── Relay auto-start ────────────────────────────────────────
//
// NotePlan plugins can't spawn processes directly, but they CAN:
//   1. Write a shell script to disk
//   2. Trigger it silently via `open` and a background-only
//      AppleScript trick using NotePlan.openURL with an
//      applescript: URL — or more portably, write a .command
//      file and open it with the "j" flag (background).
//
// The cleanest cross-version approach is:
//   - Write a one-shot launcher .sh to /tmp
//   - Open it via NotePlan.openURL using an applescript: URI
//     that runs it with `do shell script … without administrator`
//   - The relay starts as a detached background process (nohup)
//   - We then poll /health for up to 5 seconds

async function isRelayRunning(relayUrl) {
  try {
    const resp = await fetch(`${relayUrl}/health`, { timeout: 2000 })
    if (!resp || resp === '') return false
    const data = typeof resp === 'string' ? JSON.parse(resp) : resp
    return data.status === 'ok'
  } catch (_) {
    return false
  }
}

async function startRelay() {
  const relayUrl    = getSetting('relayUrl')    || 'http://localhost:3747'
  const apiKey      = getSetting('apiKey')      || ''
  const scriptPath  = relayScriptPath()
  const port        = relayUrl.replace(/.*:/, '') || '3747'

  log(`Relay not running — attempting auto-start via: ${scriptPath}`)

  // Build a nohup launcher script written to /tmp
  const launcherPath = '/tmp/amie-relay-start.sh'
  const logPath      = `${NotePlan.environment.homePath}/Documents/AmieMeetings/relay.log`

  // We write the launcher content via a "write to file" fetch trick:
  // NotePlan doesn't expose fs, but we can write via DataStore.saveData
  // (available in NP 3.7+). Fall back to the applescript URL approach.

  const launcherScript = [
    '#!/bin/bash',
    `export PORT="${port}"`,
    `export API_KEY="${apiKey}"`,
    `export AUDIO_FOLDER="$HOME/Documents/AmieMeetings/audio"`,
    `export LOG_FILE="${logPath}"`,
    `mkdir -p "$HOME/Documents/AmieMeetings/audio"`,
    // Try system node first, then common brew/nvm paths
    `NODE=$(command -v node || echo /usr/local/bin/node || echo /opt/homebrew/bin/node)`,
    `nohup "$NODE" "${scriptPath}" >> "${logPath}" 2>&1 &`,
    `echo $! > /tmp/amie-relay.pid`,
    `echo "Relay PID: $!"`,
  ].join('\n')

  // Write launcher via DataStore.saveData (NP 3.7+)
  try {
    DataStore.saveData(launcherScript, 'amie-relay-start.sh', true)
    // DataStore.saveData writes to the plugin's data folder, so
    // we need the actual path — fall through to applescript method
  } catch (_) {}

  // Use AppleScript URL scheme to run the launcher silently in background.
  // This is the only way to execute shell commands from a NotePlan plugin
  // without showing a Terminal window.
  //
  // applescript: URIs are opened by Script Editor / osascript transparently.
  const ascript = `do shell script "${launcherScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`
  const encodedScript = encodeURIComponent(ascript)

  try {
    // NotePlan.openURL supports applescript: URIs on macOS
    await NotePlan.openURL(`applescript:${encodedScript}`)
    log('Launcher triggered via AppleScript URL')
  } catch (e1) {
    log('AppleScript URL failed, trying x-callback fallback: ' + e1)
    // Fallback: open a tiny Terminal window (less ideal but reliable)
    const terminalCmd = encodeURIComponent(
      `osascript -e 'tell app "Terminal" to do script "${launcherScript.replace(/\n/g, '; ')}" activate'`
    )
    try {
      await NotePlan.openURL(`x-callback-url://run?cmd=${terminalCmd}`)
    } catch (e2) {
      log('All auto-start methods failed: ' + e2)
      CommandBar.showInput(
        `Could not auto-start the relay.\n\nPlease start it manually:\n\nnode "${scriptPath}"`,
        'OK'
      )
      return false
    }
  }

  // Poll until healthy (max 6 seconds, 500ms intervals)
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    if (await isRelayRunning(relayUrl)) {
      log(`Relay is up after ~${(i + 1) * 0.5}s`)
      return true
    }
  }

  log('Relay did not become healthy within 6s')
  return false
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Ensure relay is running ─────────────────────────────────

async function ensureRelay() {
  const relayUrl = getSetting('relayUrl') || 'http://localhost:3747'

  if (await isRelayRunning(relayUrl)) {
    log('Relay already running.')
    return true
  }

  log('Relay not detected — starting…')
  const started = await startRelay()

  if (!started) {
    CommandBar.showInput(
      '⚠️ Could not reach the Amie relay server.\n\nStart it manually:\n\nnode relay/server.js\n\n(See README for auto-start with LaunchAgent)',
      'Dismiss'
    )
    return false
  }

  return true
}

// ─── Relay API ──────────────────────────────────────────────

async function fetchMeetings(startDate, endDate) {
  const relayUrl = getSetting('relayUrl') || 'http://localhost:3747'
  const apiKey   = getSetting('apiKey')   || ''

  // Auto-start relay if not running
  const relayReady = await ensureRelay()
  if (!relayReady) return null

  const url = `${relayUrl}/meetings?start=${startDate}&end=${endDate || startDate}`

  try {
    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'Accept':    'application/json'
      },
      timeout: 15000
    })

    if (!response || response === '') {
      log('Empty response from relay.')
      return []
    }

    const data = typeof response === 'string' ? JSON.parse(response) : response
    return Array.isArray(data.meetings) ? data.meetings : []
  } catch (err) {
    log('Relay fetch error: ' + JSON.stringify(err))
    CommandBar.showInput(
      'Could not reach the Amie relay.\n\n' + JSON.stringify(err),
      'Dismiss'
    )
    return null
  }
}

// ─── Note Builder ───────────────────────────────────────────

/**
 * Build a full markdown note for one meeting.
 *
 * Expected meeting shape (from relay/webhook):
 * {
 *   id: string,
 *   title: string,
 *   startAt: ISO string,
 *   endAt: ISO string,
 *   attendees: [{ name, email }],
 *   summary: string,
 *   transcript: string,            // optional
 *   actionItems: [{ text, assignee?, dueDate? }],
 *   audioUrl: string,              // optional – local path or https URL
 *   privateNotes: string,          // optional
 *   platform: string               // e.g. "Google Meet", "Zoom"
 * }
 */
function buildMeetingNote(meeting, taskTag) {
  const date    = formatDate(meeting.startAt)
  const start   = formatTime(meeting.startAt)
  const end     = formatTime(meeting.endAt)
  const tag     = taskTag || '#amie'

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

  const audioSection = meeting.audioUrl
    ? `## 🎙 Recording\n[Open Audio](${meeting.audioUrl})\n`
    : ''

  const transcriptSection = meeting.transcript
    ? `## 📝 Transcript\n${meeting.transcript.trim()}\n`
    : ''

  const privateSection = meeting.privateNotes
    ? `## 🔒 Private Notes\n${meeting.privateNotes.trim()}\n`
    : ''

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

// ─── Daily Note Block ────────────────────────────────────────

function buildDailyBlock(meeting, noteFilename, taskTag) {
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

  const audioLink = meeting.audioUrl
    ? `  🎙 [Recording](${meeting.audioUrl})\n`
    : ''

  const noteLink = noteFilename
    ? `  📄 [[${noteFilename}]]\n`
    : ''

  return `### ${start}–${end} ${meeting.title}
${noteLink}${audioLink}${actionLines ? actionLines + '\n' : ''}`
}

// ─── Write Meeting Note ──────────────────────────────────────

async function writeMeetingNote(meeting, folder, taskTag) {
  const date     = formatDate(meeting.startAt)
  const safeName = meeting.title.replace(/[/\\?%*:|"<>]/g, '-').trim()
  const filename = `${folder}/${date} ${safeName}`

  const content = buildMeetingNote(meeting, taskTag)

  try {
    // Check if note already exists
    let note = await DataStore.noteByFilename(`${filename}.md`, 'Notes')

    if (note) {
      // Overwrite content (re-sync)
      note.content = content
      log(`Updated existing note: ${filename}`)
    } else {
      // Create new note
      note = await DataStore.newNoteWithContent(content, folder, `${date} ${safeName}`)
      log(`Created new note: ${filename}`)
    }

    return `${date} ${safeName}`
  } catch (err) {
    log('Error writing note: ' + JSON.stringify(err))
    return null
  }
}

// ─── Append to Daily Note ────────────────────────────────────

async function appendToDailyNote(meeting, noteFilename, taskTag) {
  const date = formatDate(meeting.startAt)

  try {
    const dailyNote = await DataStore.calendarNoteByDateString(date)
    if (!dailyNote) {
      log(`No daily note found for ${date}`)
      return
    }

    const block = buildDailyBlock(meeting, noteFilename, taskTag)
    const marker = `<!-- amie-sync:${meeting.id} -->`

    // Avoid duplicate blocks
    if (dailyNote.content.includes(marker)) {
      log(`Daily note already has block for meeting ${meeting.id}`)
      return
    }

    // Find or create a "## Meetings" section
    const hasMeetingsSection = dailyNote.content.includes('## Meetings')
    if (!hasMeetingsSection) {
      dailyNote.content += `\n\n## Meetings\n${marker}\n${block}`
    } else {
      // Append after the Meetings header
      dailyNote.content = dailyNote.content.replace(
        /## Meetings\n/,
        `## Meetings\n${marker}\n${block}\n`
      )
    }

    log(`Appended to daily note for ${date}`)
  } catch (err) {
    log('Error appending to daily note: ' + JSON.stringify(err))
  }
}

// ─── Main Sync Logic ─────────────────────────────────────────

async function runSync(startDate, endDate) {
  const folder      = getSetting('meetingFolder') || 'Meetings'
  const appendDaily = getSetting('appendToDaily') !== false
  const taskTag     = getSetting('taskTag') || '#amie'

  log(`Syncing meetings from ${startDate} to ${endDate || startDate}`)

  const meetings = await fetchMeetings(startDate, endDate)
  if (!meetings) return // error already shown

  if (meetings.length === 0) {
    CommandBar.showInput(`No meetings found for ${startDate}${endDate && endDate !== startDate ? ' – ' + endDate : ''}.`, 'OK')
    return
  }

  let created = 0
  let updated = 0

  for (const meeting of meetings) {
    const noteFilename = await writeMeetingNote(meeting, folder, taskTag)
    if (noteFilename) {
      created++
    } else {
      updated++
    }

    if (appendDaily) {
      await appendToDailyNote(meeting, noteFilename, taskTag)
    }
  }

  const total = meetings.length
  CommandBar.showInput(
    `✅ Amie Sync complete.\n${total} meeting${total !== 1 ? 's' : ''} processed.\nSaved to: ${folder}/`,
    'Done'
  )
}

// ─── Commands ────────────────────────────────────────────────

async function syncAmieMeetings() {
  try {
    await runSync(todayStr())
  } catch (error) {
    log('syncAmieMeetings error: ' + JSON.stringify(error))
    CommandBar.showInput('Amie Sync failed: ' + error.message, 'Dismiss')
  }
}

async function syncAmieMeetingsRange() {
  try {
    const startInput = await CommandBar.showInput('Enter start date (YYYY-MM-DD)', 'Next')
    if (!startInput) return

    const endInput = await CommandBar.showInput(
      'Enter end date (YYYY-MM-DD)\nLeave blank to use start date only',
      'Sync'
    )

    await runSync(startInput.trim(), endInput?.trim() || startInput.trim())
  } catch (error) {
    log('syncAmieMeetingsRange error: ' + JSON.stringify(error))
  }
}

async function configureAmieSync() {
  try {
    const relayUrl = await CommandBar.showInput(
      'Relay server URL\n(default: http://localhost:3747)',
      'Save'
    )
    const apiKey = await CommandBar.showInput(
      'Relay API key (leave blank if none)',
      'Save'
    )
    const folder = await CommandBar.showInput(
      'NotePlan folder for meeting notes\n(default: Meetings)',
      'Save'
    )
    const taskTag = await CommandBar.showInput(
      'Tag for action items\n(default: #amie)',
      'Save'
    )

    DataStore.settings = {
      ...DataStore.settings,
      relayUrl:      relayUrl?.trim()  || 'http://localhost:3747',
      apiKey:        apiKey?.trim()    || '',
      meetingFolder: folder?.trim()    || 'Meetings',
      taskTag:       taskTag?.trim()   || '#amie',
      appendToDaily: true
    }

    CommandBar.showInput('✅ Amie Sync configured! Run "Sync Amie Meetings" to import today\'s meetings.', 'Done')
  } catch (error) {
    log('configureAmieSync error: ' + JSON.stringify(error))
  }
}

// ─── Relay management commands ───────────────────────────────

async function startRelayCommand() {
  try {
    const relayUrl = getSetting('relayUrl') || 'http://localhost:3747'

    if (await isRelayRunning(relayUrl)) {
      CommandBar.showInput('✅ Relay is already running.', 'OK')
      return
    }

    const started = await startRelay()
    if (started) {
      CommandBar.showInput('✅ Relay server started successfully.', 'OK')
    } else {
      CommandBar.showInput(
        `⚠️ Could not auto-start the relay.\n\nStart it manually:\n\nnode "${relayScriptPath()}"`,
        'OK'
      )
    }
  } catch (error) {
    log('startRelayCommand error: ' + JSON.stringify(error))
  }
}

async function stopRelayCommand() {
  try {
    const pidFile = '/tmp/amie-relay.pid'
    const killScript = `if [ -f "${pidFile}" ]; then PID=$(cat "${pidFile}"); kill "$PID" 2>/dev/null; rm -f "${pidFile}"; echo "stopped"; else echo "no-pid"; fi`
    const ascript = `do shell script "${killScript.replace(/"/g, '\\"')}"`

    await NotePlan.openURL(`applescript:${encodeURIComponent(ascript)}`)

    await sleep(800)
    const relayUrl = getSetting('relayUrl') || 'http://localhost:3747'
    const stillUp  = await isRelayRunning(relayUrl)

    if (stillUp) {
      CommandBar.showInput('⚠️ Relay still responding — it may have been started outside this plugin (e.g. LaunchAgent). Stop it there instead.', 'OK')
    } else {
      CommandBar.showInput('✅ Relay server stopped.', 'OK')
    }
  } catch (error) {
    log('stopRelayCommand error: ' + JSON.stringify(error))
    CommandBar.showInput('Could not stop relay: ' + error.message, 'OK')
  }
}

async function relayStatusCommand() {
  try {
    const relayUrl  = getSetting('relayUrl') || 'http://localhost:3747'
    const apiKey    = getSetting('apiKey')   || ''
    const running   = await isRelayRunning(relayUrl)
    const scriptPath = relayScriptPath()

    if (running) {
      let detail = ''
      try {
        const resp = await fetch(`${relayUrl}/status`, {
          headers: { 'x-api-key': apiKey },
          timeout: 3000
        })
        if (resp) {
          const data = typeof resp === 'string' ? JSON.parse(resp) : resp
          detail = `\nMeetings stored: ${data.totalMeetings ?? '?'}`
        }
      } catch (_) {}
      CommandBar.showInput(`✅ Relay is RUNNING at ${relayUrl}${detail}`, 'OK')
    } else {
      CommandBar.showInput(
        `❌ Relay is NOT running.\n\nScript: ${scriptPath}\n\nRun "Start Amie Relay" to launch it.`,
        'OK'
      )
    }
  } catch (error) {
    log('relayStatusCommand error: ' + JSON.stringify(error))
  }
}
