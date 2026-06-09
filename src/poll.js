/**
 * Pugs Sync Agent — Outbound Queue Poller
 *
 * Long-running process: every POLL_INTERVAL_MS, GETs the pugs-sales
 * outbound queue at /api/sync/outbound-queue, dispatches each due item
 * to the LOCAL sender (src/send.js → AppleScript), then POSTs back to
 * /api/sync/outbound-queue/[id] with the outcome.
 *
 * Why this exists: pugs-sales runs on Vercel and cannot reach Connor's
 * Mac directly (NAT). The agent polls outward — same pattern as the
 * inbound scanner. iMessage-only (no SMS fallback) per v1 decision.
 *
 * Run via launchd: com.pugs.syncagent.poller.plist (RunAtLoad + KeepAlive).
 *
 * Env (in .env at the agent root):
 *   PUGS_SYNC_WEBHOOK_URL   → e.g. https://pugs-sales.vercel.app/api/import/imessage
 *                             (we derive the /api/sync base from this — same host)
 *   PUGS_SYNC_SECRET        → shared secret, sent as x-pugs-sync-secret
 *   SENDER_PORT             → defaults to 7890 (matches src/send.js)
 *   POLL_INTERVAL_MS        → defaults to 5000
 *   MAX_ATTEMPTS            → defaults to 5; rows with attempts >= MAX are skipped
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { planItem } = require('./dispatch')
const { fetchWithTimeout } = require('./fetch-timeout')

const WEBHOOK_URL      = process.env.PUGS_SYNC_WEBHOOK_URL
const SECRET           = process.env.PUGS_SYNC_SECRET
// Identifies this machine to pugs-sales' ALLOWED_SCANNER_IDS allowlist.
// Empty string = unidentified; harmless if allowlist isn't active server-side.
const SCANNER_ID       = process.env.PUGS_SCANNER_ID || ''
const SENDER_PORT      = parseInt(process.env.SENDER_PORT      || '7890', 10)
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10)
const MAX_ATTEMPTS     = parseInt(process.env.MAX_ATTEMPTS     || '5',    10)

// send.js has a 15 s osascript timeout; 20 s gives it headroom while still
// bounding the window where a hung sender stalls the entire poller loop.
const DISPATCH_TIMEOUT_MS = 20_000

if (!WEBHOOK_URL || !SECRET) {
  console.error('Missing PUGS_SYNC_WEBHOOK_URL or PUGS_SYNC_SECRET in .env')
  process.exit(2)
}

// Derive the cloud-app API origin from the inbound webhook URL — same host.
// e.g. https://pugs-sales.vercel.app/api/import/imessage → https://pugs-sales.vercel.app
const API_BASE = new URL(WEBHOOK_URL).origin

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// Retries up to MAX_FETCH_TRIES times on 5xx and network errors; throws
// immediately on 4xx (permanent: bad secret, bad request — no point retrying).
// Matches the retry contract of postToWebhook, reportOutcome, and
// postContactsPayload so a transient Vercel cold-start doesn't drop the
// entire poll cycle.
const MAX_QUEUE_FETCH_TRIES = 3

async function fetchPendingBatch({
  _fetch    = fetch,
  _delay    = (ms) => new Promise(r => setTimeout(r, ms)),
  _timeoutMs = 10_000,
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= MAX_QUEUE_FETCH_TRIES; attempt++) {
    let res
    try {
      res = await fetchWithTimeout(`${API_BASE}/api/sync/outbound-queue?limit=10`, {
        headers: { 'x-pugs-sync-secret': SECRET, 'x-pugs-scanner-id': SCANNER_ID },
      }, _timeoutMs, _fetch)
    } catch (e) {
      lastError = e
      if (attempt < MAX_QUEUE_FETCH_TRIES) await _delay(500 * attempt)
      continue
    }
    if (res.ok) {
      let j
      try {
        j = await res.json()
      } catch (e) {
        throw new Error(`queue GET 200 bad JSON: ${e.message}`)
      }
      return Array.isArray(j.items) ? j.items : []
    }
    const errText = (await res.text()).slice(0, 300)
    const err = new Error(`queue GET ${res.status}: ${errText}`)
    if (res.status >= 400 && res.status < 500) throw err  // permanent: no retry
    lastError = err
    if (attempt < MAX_QUEUE_FETCH_TRIES) await _delay(500 * attempt)
  }
  throw lastError
}

// Retries up to MAX_REPORT_TRIES times (exponential backoff) before logging and swallowing.
// Prevents a transient cloud hiccup from leaving a 'sent' item stuck as 'pending',
// which would cause the next poll cycle to dispatch it again as a duplicate iMessage.
const MAX_REPORT_TRIES = 3

async function reportOutcome(id, payload, {
  _fetch     = fetch,
  _delay     = (ms) => new Promise(r => setTimeout(r, ms)),
  _timeoutMs = 10_000,
} = {}) {
  for (let attempt = 1; attempt <= MAX_REPORT_TRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/sync/outbound-queue/${id}`, {
        method:  'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-pugs-sync-secret': SECRET,
          'x-pugs-scanner-id':  SCANNER_ID,
        },
        body: JSON.stringify(payload),
      }, _timeoutMs, _fetch)
      if (res.ok) return
      const errText = (await res.text()).slice(0, 200)
      if (res.status >= 400 && res.status < 500) {
        log(`report-outcome ${id} permanent error ${res.status} — not retrying: ${errText}`)
        return
      }
      if (attempt < MAX_REPORT_TRIES) { await _delay(500 * attempt); continue }
      log(`report-outcome ${id} failed after ${MAX_REPORT_TRIES} attempts: ${res.status} ${errText}`)
    } catch (e) {
      if (attempt < MAX_REPORT_TRIES) { await _delay(500 * attempt); continue }
      log(`report-outcome ${id} network error after ${MAX_REPORT_TRIES} attempts: ${e.message || e}`)
    }
  }
}

async function dispatchToLocalSender(item, { _fetch = fetch, _timeoutMs = DISPATCH_TIMEOUT_MS } = {}) {
  // item: { id, to_handle, body, attempts }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), _timeoutMs)
  try {
    const res = await _fetch(`http://127.0.0.1:${SENDER_PORT}/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-pugs-sync-secret': SECRET },
      body:    JSON.stringify({ to: item.to_handle, text: item.body, service: 'iMessage' }),
      signal:  controller.signal,
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`local send ${res.status}: ${errText.slice(0, 400)}`)
    }
    try {
      return await res.json()
    } catch (e) {
      throw new Error(`local send 200 malformed JSON: ${e.message}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Process a batch of queue items. Extracted for testability — poll.test.js
 * exercises every branch with injected deps instead of live network calls.
 *
 * @param {object[]} items
 * @param {{ reportOutcome, dispatchToLocalSender, maxAttempts, log }} deps
 */
async function processBatch(items, { reportOutcome, dispatchToLocalSender, maxAttempts, log }) {
  for (const item of items) {
    const plan = planItem(item, { maxAttempts })

    if (plan.action === 'drop') {
      log(`drop queue item (${plan.reason}):`, JSON.stringify(item).slice(0, 200))
      continue
    }
    if (plan.action === 'skip') {
      log(`skip ${item.id}: attempts=${item.attempts} >= MAX_ATTEMPTS=${maxAttempts}`)
      // Report the skip so the cloud can reap the row. Without this the item
      // stays 'pending' and re-appears every poll cycle, consuming queue slots
      // and starving new outbound messages.
      await reportOutcome(item.id, { status: 'skipped', reason: 'exceeded max retry attempts' })
      continue
    }
    if (plan.action === 'fail') {
      // Malformed/blank row — fail it WITHOUT calling the local sender so it can
      // never misfire a real iMessage.
      log(`failed ${item.id}: ${plan.reason} (not dispatched)`)
      await reportOutcome(item.id, { status: 'failed', error: plan.reason })
      continue
    }

    try {
      await dispatchToLocalSender(item)
      await reportOutcome(item.id, { status: 'sent' })
      log(`sent ${item.id} → ${item.to_handle}`)
    } catch (e) {
      const msg = e?.message || String(e)
      log(`failed ${item.id}: ${msg}`)
      await reportOutcome(item.id, { status: 'failed', error: msg })
    }
  }
}

async function pollOnce() {
  let items
  try {
    items = await fetchPendingBatch()
  } catch (e) {
    log('poll fetch error:', e.message || e)
    return
  }
  if (items.length === 0) return

  log(`processing ${items.length} pending iMessage(s)`)
  await processBatch(items, { reportOutcome, dispatchToLocalSender, maxAttempts: MAX_ATTEMPTS, log })
}

// Set by SIGTERM/SIGINT handlers so the loop finishes the current poll cycle
// before exiting instead of being killed mid-dispatch (which would leave the
// just-sent item as 'pending' on the cloud, triggering a duplicate iMessage
// on the next poll cycle after the process restarts).
let shuttingDown = false

/**
 * Main polling loop. Extracted with injectable deps so tests can drive it
 * without live network calls or module-level state pollution.
 *
 * @param {{ _pollOnce?, _delay?, _isShuttingDown? }} deps
 */
async function loop({
  _pollOnce = pollOnce,
  _delay = (ms) => new Promise(r => setTimeout(r, ms)),
  _isShuttingDown = () => shuttingDown,
} = {}) {
  // First tick immediately, then on interval.
  for (;;) {
    await _pollOnce()
    if (_isShuttingDown()) return
    await _delay(POLL_INTERVAL_MS)
    if (_isShuttingDown()) return
  }
}

if (require.main === module) {
  // On SIGTERM (launchctl unload / auto-updater reload) or SIGINT (Ctrl-C),
  // drain the current poll cycle then exit cleanly rather than dying mid-dispatch.
  process.once('SIGTERM', () => { log('SIGTERM — draining current poll cycle then exiting'); shuttingDown = true })
  process.once('SIGINT',  () => { log('SIGINT — draining current poll cycle then exiting');  shuttingDown = true })

  log(`pugs-sync poller starting · base=${API_BASE} · interval=${POLL_INTERVAL_MS}ms`)
  loop().then(() => {
    log('graceful shutdown complete')
    process.exit(0)
  }).catch(e => {
    log('fatal loop error:', e)
    process.exit(1)
  })
}

module.exports = { processBatch, reportOutcome, fetchPendingBatch, dispatchToLocalSender, loop }
