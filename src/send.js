/**
 * Pugs Sync Agent — Outbound Sender
 *
 * Tiny HTTP listener on 127.0.0.1:SENDER_PORT. The cloud app POSTs send
 * requests here; we then trigger AppleScript to send via Messages.app.
 *
 * Auth: x-pugs-sync-secret header must match .env value. Listens on
 * localhost only — never expose this externally.
 *
 * To send a message:
 *   POST /send
 *   { "to": "+14155550100" | "user@example.com", "text": "Hello", "service": "iMessage" | "SMS" }
 */

const path = require('path')
const { execFile: defaultExecFile } = require('child_process')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const express = require('express')
const { buildSendScript: defaultBuildScript, parseOsascriptResult: defaultParseResult } = require('./applescript')

const PORT   = parseInt(process.env.SENDER_PORT || '7890', 10)
const SECRET = process.env.PUGS_SYNC_SECRET

/**
 * Creates the Express app with injectable dependencies for testability.
 * All deps default to the real implementations; tests pass in mocks.
 */
function createApp({
  secret = SECRET,
  execFile = defaultExecFile,
  buildSendScript = defaultBuildScript,
  parseOsascriptResult = defaultParseResult,
} = {}) {
  const app = express()
  app.use(express.json({ limit: '32kb' }))

  // Require localhost connection AND matching secret. Defense in depth.
  app.use((req, res, next) => {
    const remote = req.socket.remoteAddress
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      return res.status(403).json({ error: 'localhost only' })
    }
    const got = req.header('x-pugs-sync-secret')
    if (!got || got !== secret) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    next()
  })

  app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }))

  app.post('/send', (req, res) => {
    const { to, text, service } = req.body || {}
    if (!to || !text) return res.status(400).json({ error: 'to and text required' })
    if (typeof to !== 'string' || typeof text !== 'string') {
      return res.status(400).json({ error: 'to/text must be strings' })
    }
    // Build the AppleScript with escaped handle/body so a quote, backslash, or
    // newline in either can't break out of the string literal (see applescript.js).
    const svc = service === 'SMS' ? 'SMS' : 'iMessage'
    const script = buildSendScript({ to, text, service: svc })

    execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('osascript process error:', stderr || err.message)
        return res.status(500).json({ error: 'send failed', detail: (stderr || err.message).slice(0, 400) })
      }
      const parsed = parseOsascriptResult(stdout)
      if (!parsed.ok) {
        console.error('osascript reported send failure:', parsed.detail)
        return res.status(500).json({ error: 'send failed', detail: parsed.detail })
      }
      res.json({ ok: true, to, service: svc })
    })
  })

  return app
}

module.exports = { createApp }

if (require.main === module) {
  if (!SECRET) {
    console.error('Missing PUGS_SYNC_SECRET in .env')
    process.exit(2)
  }
  createApp().listen(PORT, '127.0.0.1', () => {
    console.log(`Pugs sender listening on http://127.0.0.1:${PORT}`)
  })
}
