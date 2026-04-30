#!/usr/bin/env node
// ============================================================
// Amie → NotePlan Webhook Relay
// relay/server.js
//
// Run this locally: node relay/server.js
//
// 1. In Amie: Settings → Integrations → API → Webhooks
//    Add endpoint: http://<your-public-tunnel>/webhook
//    (Use `npx cloudflared tunnel` or `ngrok http 3747` for a public URL)
//
// 2. The relay stores incoming webhook payloads in memory (and
//    optionally saves audio to a local folder).
//
// 3. The NotePlan plugin calls GET /meetings?start=YYYY-MM-DD
//    to fetch buffered meetings.
// ============================================================

const http      = require('http')
const fs        = require('fs')
const path      = require('path')
const url       = require('url')
const https     = require('https')
const crypto    = require('crypto')
const { execFile } = require('child_process')

// ─── Configuration ───────────────────────────────────────────
const CONFIG = {
  port:        process.env.PORT        || 3747,
  apiKey:      process.env.API_KEY     || '',          // Shared secret for NotePlan plugin
  webhookSecret: process.env.AMIE_WEBHOOK_SECRET || '', // Optional Amie signing secret
  audioFolder: process.env.AUDIO_FOLDER || path.join(process.env.HOME, 'Documents', 'AmieMeetings', 'audio'),
  logFile:     process.env.LOG_FILE    || path.join(process.env.HOME, 'Documents', 'AmieMeetings', 'relay.log'),
}

// ─── Storage ─────────────────────────────────────────────────
// Meetings stored in memory, keyed by id, plus persisted to JSON
const DATA_FILE = path.join(process.env.HOME, 'Documents', 'AmieMeetings', 'meetings.json')

function ensureDirs() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  fs.mkdirSync(CONFIG.audioFolder, { recursive: true })
}

function loadMeetings() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    }
  } catch (_) {}
  return {}
}

function saveMeetings(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2))
}

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { fs.appendFileSync(CONFIG.logFile, line + '\n') } catch (_) {}
}

// ─── Webhook Payload Parser ───────────────────────────────────
//
// Amie webhook shape (as documented in Settings → Integrations → API):
// {
//   event: "meeting.completed",
//   meeting: {
//     id, title, startAt, endAt, platform,
//     attendees: [{name, email}],
//     summary, transcript,
//     actionItems: [{text, assignee?, dueDate?}],
//     audioUrl,      // URL to audio file hosted by Amie (if available)
//     privateNotes
//   }
// }
//
// The relay normalises this into a consistent shape the plugin expects.

function normaliseMeeting(raw) {
  const m = raw.meeting || raw
  return {
    id:           m.id           || `unknown-${Date.now()}`,
    title:        m.title        || 'Untitled Meeting',
    startAt:      m.startAt      || m.start_at || new Date().toISOString(),
    endAt:        m.endAt        || m.end_at   || new Date().toISOString(),
    platform:     m.platform     || '',
    attendees:    m.attendees    || [],
    summary:      m.summary      || '',
    transcript:   m.transcript   || '',
    actionItems:  m.actionItems  || m.action_items || [],
    audioUrl:     m.audioUrl     || m.audio_url    || '',
    privateNotes: m.privateNotes || m.private_notes || '',
    syncedAt:     new Date().toISOString(),
  }
}

// ─── Auth Check ───────────────────────────────────────────────

function checkApiKey(req) {
  if (!CONFIG.apiKey) return true // no key configured = open
  const key = req.headers['x-api-key'] || ''
  return key === CONFIG.apiKey
}

function verifyWebhookSignature(rawBody, req) {
  // If a webhook signing secret is configured, require a valid HMAC-SHA256
  // signature delivered in the x-amie-signature header.
  if (CONFIG.webhookSecret) {
    const provided = req.headers['x-amie-signature'] || ''
    const expected = 'sha256=' + crypto
      .createHmac('sha256', CONFIG.webhookSecret)
      .update(rawBody)
      .digest('hex')
    const providedBuf = Buffer.from(provided)
    const expectedBuf = Buffer.from(expected)
    // timingSafeEqual requires equal-length buffers; reject immediately if lengths differ
    if (providedBuf.length !== expectedBuf.length) return false
    return crypto.timingSafeEqual(providedBuf, expectedBuf)
  }
  // Fall back to API key check so an API_KEY can also protect the webhook
  // endpoint when no signing secret is configured.
  if (CONFIG.apiKey) {
    const key = req.headers['x-api-key'] || ''
    return key === CONFIG.apiKey
  }
  // Neither secret configured — accept (localhost-only is still safe)
  return true
}

// ─── Request Body Reader ──────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ─── Handlers ────────────────────────────────────────────────

async function handleWebhook(req, res, store) {
  // Amie posts to /webhook
  const body = await readBody(req)

  // Verify signature / API key before processing the payload
  if (!verifyWebhookSignature(body, req)) {
    logLine('Webhook rejected: invalid signature or missing API key')
    res.writeHead(401)
    res.end('Unauthorized')
    return
  }

  let payload

  try {
    payload = JSON.parse(body)
  } catch (e) {
    logLine(`Bad JSON from Amie: ${body.slice(0, 200)}`)
    res.writeHead(400)
    res.end('Bad JSON')
    return
  }

  const event = payload.event || 'unknown'
  logLine(`Received Amie event: ${event}`)

  if (event === 'meeting.completed' || event === 'meeting.updated' || payload.meeting) {
    const meeting = normaliseMeeting(payload)
    store[meeting.id] = meeting
    saveMeetings(store)
    logLine(`Stored meeting: "${meeting.title}" (${meeting.id})`)

    // Optionally download audio to local folder
    if (meeting.audioUrl && meeting.audioUrl.startsWith('https://')) {
      downloadAudioAsync(meeting)
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

function handleGetMeetings(req, res, store) {
  if (!checkApiKey(req)) {
    res.writeHead(401)
    res.end('Unauthorized')
    return
  }

  const query     = url.parse(req.url, true).query
  const startDate = query.start || todayStr()
  const endDate   = query.end   || startDate

  const meetings = Object.values(store).filter(m => {
    const d = m.startAt.split('T')[0]
    return d >= startDate && d <= endDate
  })

  // If audio was downloaded locally, rewrite audioUrl to a file:// path
  const rewritten = meetings.map(m => {
    const localPath = localAudioPath(m)
    if (localPath && fs.existsSync(localPath)) {
      return { ...m, audioUrl: `file://${localPath}` }
    }
    return m
  })

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ meetings: rewritten }))
  logLine(`Served ${rewritten.length} meetings (${startDate} → ${endDate})`)
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }))
}

function handleStatus(req, res, store) {
  if (!checkApiKey(req)) { res.writeHead(401); res.end('Unauthorized'); return }
  const count = Object.keys(store).length
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ totalMeetings: count, dataFile: DATA_FILE, audioFolder: CONFIG.audioFolder }))
}

// ─── Audio Download ───────────────────────────────────────────

function localAudioPath(meeting) {
  if (!meeting.audioUrl) return null
  const ext  = path.extname(meeting.audioUrl.split('?')[0]) || '.m4a'
  const safe = meeting.title.replace(/[/\\?%*:|"<>]/g, '-').trim()
  const date = meeting.startAt.split('T')[0]
  return path.join(CONFIG.audioFolder, `${date} ${safe}${ext}`)
}

function downloadAudioAsync(meeting) {
  const dest = localAudioPath(meeting)
  if (!dest || fs.existsSync(dest)) return

  // Validate the URL to prevent request forgery: must be a well-formed https URL
  // with a public hostname (no localhost, loopback, or private ranges).
  let parsedUrl
  try {
    parsedUrl = new URL(meeting.audioUrl)
  } catch (_) {
    logLine(`Skipping audio download for ${meeting.id}: invalid URL`)
    return
  }
  if (parsedUrl.protocol !== 'https:') {
    logLine(`Skipping audio download for ${meeting.id}: URL must use https`)
    return
  }
  const hostname = parsedUrl.hostname.toLowerCase()
  // Block loopback, private (RFC 1918), link-local, and unspecified IPv4 addresses.
  // Note: parsedUrl.hostname strips brackets from IPv6 literals (e.g. [::1] → ::1).
  if (
    hostname === 'localhost' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||   // link-local
    hostname === '0.0.0.0' ||
    hostname === '::1' ||                // IPv6 loopback (no brackets after URL parse)
    hostname.startsWith('fc') ||         // IPv6 unique local (fc00::/7)
    hostname.startsWith('fd') ||         // IPv6 unique local (fd00::/8)
    hostname.startsWith('fe80')          // IPv6 link-local (fe80::/10)
  ) {
    logLine(`Skipping audio download for ${meeting.id}: private/loopback hostname not allowed`)
    return
  }
  // Block the 172.16.0.0/12 private range (172.16.x.x – 172.31.x.x).
  // Require all four octets to be present to avoid matching non-IP hostnames.
  const match172 = hostname.match(/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/)
  if (match172) {
    logLine(`Skipping audio download for ${meeting.id}: private/loopback hostname not allowed`)
    return
  }

  // Ensure the destination path is within the configured audio folder to
  // prevent path traversal via a crafted meeting title or date.
  const resolvedDest = path.resolve(dest)
  const resolvedAudioFolder = path.resolve(CONFIG.audioFolder)
  if (!resolvedDest.startsWith(resolvedAudioFolder + path.sep)) {
    logLine(`Skipping audio download for ${meeting.id}: destination path outside audio folder`)
    return
  }

  // Reconstruct the URL explicitly from validated components so that curl
  // receives exactly the same URL we validated (protocol, host, path, query).
  const safeUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}`

  // Use execFile so the URL and destination are passed as separate arguments,
  // preventing shell injection from a crafted audioUrl value.
  // --max-redirs 0 prevents an attacker from bypassing the above hostname
  // validation by supplying a valid URL that redirects to a private address.
  setTimeout(() => {
    execFile('curl', ['-s', '--max-redirs', '0', safeUrl, '-o', dest], { timeout: 120000 }, (err) => {
      if (err) {
        logLine(`Audio download failed for ${meeting.id}: ${err.message}`)
      } else {
        logLine(`Audio downloaded: ${path.basename(dest)}`)
      }
    })
  }, 100)
}

// ─── Date Helper ─────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

// ─── Server ───────────────────────────────────────────────────

function main() {
  ensureDirs()
  const store = loadMeetings()
  logLine(`Relay starting on port ${CONFIG.port}. ${Object.keys(store).length} meetings loaded.`)
  if (CONFIG.apiKey) {
    logLine('API key authentication ENABLED.')
  } else {
    logLine('⚠️  No API_KEY set — relay is open (localhost only is still safe).')
  }
  if (CONFIG.webhookSecret) {
    logLine('Webhook HMAC signature verification ENABLED.')
  } else if (CONFIG.apiKey) {
    logLine('Webhook protected by API key (no HMAC secret configured).')
  } else {
    logLine('⚠️  No AMIE_WEBHOOK_SECRET set — webhook endpoint is unprotected.')
  }

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url)
    const pathname = parsed.pathname

    try {
      if (req.method === 'POST' && pathname === '/webhook') {
        await handleWebhook(req, res, store)
      } else if (req.method === 'GET' && pathname === '/meetings') {
        handleGetMeetings(req, res, store)
      } else if (req.method === 'GET' && pathname === '/health') {
        handleHealth(req, res)
      } else if (req.method === 'GET' && pathname === '/status') {
        handleStatus(req, res, store)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    } catch (err) {
      logLine('Server error: ' + err.message)
      res.writeHead(500)
      res.end('Internal server error')
    }
  })

  server.listen(CONFIG.port, '127.0.0.1', () => {
    logLine(`✅ Relay listening at http://127.0.0.1:${CONFIG.port}`)
    logLine(`   Webhook endpoint: POST /webhook`)
    logLine(`   Meetings API:     GET  /meetings?start=YYYY-MM-DD&end=YYYY-MM-DD`)
    logLine(`   Health check:     GET  /health`)
  })
}

main()
