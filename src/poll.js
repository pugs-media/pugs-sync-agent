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
const { reportHealth } = require('./health-report')
const journal = require('./dispatch-journal')

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

if (!Number.isInteger(SENDER_PORT) || SENDER_PORT < 1 || SENDER_PORT > 65535) {
  console.error(`Invalid SENDER_PORT: "${process.env.SENDER_PORT || '7890'}" — must be a port number 1-65535`)
  process.exit(2)
}

if (!Number.isInteger(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 1) {
  console.error(`Invalid POLL_INTERVAL_MS: "${process.env.POLL_INTERVAL_MS || '5000'}" — must be a positive integer (milliseconds)`)
  process.exit(2)
}

if (!Number.isInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS < 0) {
  console.error(`Invalid MAX_ATTEMPTS: "${process.env.MAX_ATTEMPTS || '5'}" — must be a non-negative integer`)
  process.exit(2)
}

// Derive the cloud-app API origin from the inbound webhook URL — same host.
// e.g. https://pugs-sales.vercel.app/api/import/imessage → https://pugs-sales.vercel.app
let API_BASE
try {
  API_BASE = new URL(WEBHOOK_URL).origin
} catch (e) {
  console.error(`Invalid PUGS_SYNC_WEBHOOK_URL: ${e.message}`)
  process.exit(2)
}

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
    // 408 (Request Timeout) and 429 (Too Many Requests) are transient; retry with backoff.
    // Other 4xx are permanent failures (bad auth, bad request) — throw immediately, no retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw err
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
      if (res.ok) return true
      const errText = (await res.text()).slice(0, 200)
      // 408 (Request Timeout) and 429 (Too Many Requests) are transient; retry with backoff.
      // Other 4xx are permanent failures (bad auth, bad request) — don't retry, allow journal clear.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        log(`report-outcome ${id} permanent error ${res.status} — not retrying: ${errText}`)
        return true  // Cloud will not accept a retry; safe to clear the journal entry
      }
      if (attempt < MAX_REPORT_TRIES) { await _delay(500 * attempt); continue }
      log(`report-outcome ${id} failed after ${MAX_REPORT_TRIES} attempts: ${res.status} ${errText}`)
    } catch (e) {
      if (attempt < MAX_REPORT_TRIES) { await _delay(500 * attempt); continue }
      log(`report-outcome ${id} network error after ${MAX_REPORT_TRIES} attempts: ${e.message || e}`)
    }
  }
  return false  // Cloud did not confirm; caller must NOT clear the journal entry
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
 * @param {{ reportOutcome, dispatchToLocalSender, maxAttempts, log, journalMark?, journalClear?, journalList? }} deps
 */
async function processBatch(items, {
  reportOutcome,
  dispatchToLocalSender,
  maxAttempts,
  log,
  journalMark  = () => {},
  journalClear = () => {},
  journalList  = () => [],
}) {
  // Dedup guard: seenIds is pre-seeded with every ID currently in the dispatch
  // journal (already dispatched but not yet cloud-confirmed). If flushJournal
  // couldn't confirm an item this cycle and the cloud then re-delivers it in
  // the batch, processing it again would cause a double-send — a client-comms
  // error. The pre-seed prevents that without touching the happy path.
  //
  // Also catches within-batch duplicates: cloud must never return the same id
  // twice in one fetch, but a cloud bug could. Tracked as strings so numeric
  // and string forms of the same id (42 vs "42") collapse to one slot.
  const seenIds = new Set(journalList().map(String))

  for (const item of items) {
    const plan = planItem(item, { maxAttempts })

    if (plan.action === 'drop') {
      log(`drop queue item (${plan.reason}):`, JSON.stringify(item).slice(0, 200))
      continue
    }

    // item.id is present here (drop is the only id-less path)
    const idKey = String(item.id)
    if (seenIds.has(idKey)) {
      log(`dedup skip ${item.id}: id already in journal or appeared twice in this batch — skipping to prevent double-send`)
      continue
    }
    seenIds.add(idKey)

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
      // Mark the journal BEFORE reporting so a crash between dispatch and
      // reportOutcome is recoverable: flushJournal on the next startup will
      // re-report the outcome without re-sending the iMessage.
      // If journal mark fails (disk full, permissions), it's a fatal error —
      // we cannot safely track the dispatch and must not proceed.
      const markOk = journalMark(item.id)
      if (!markOk) {
        throw new Error('journal mark failed — cannot safely track dispatch (disk full? permissions?)')
      }
      const reported = await reportOutcome(item.id, { status: 'sent' })
      // Only clear after cloud confirms receipt. If reportOutcome exhausts retries
      // (cloud down), the entry stays; the next cycle's flushJournal retries before
      // fetching the batch — preventing a double-send if the cloud re-delivers the
      // item as pending before we can report it sent.
      if (reported) journalClear(item.id)
      log(`sent ${item.id} → ${item.to_handle}`)
    } catch (e) {
      const msg = e?.message || String(e)
      log(`failed ${item.id}: ${msg}`)
      await reportOutcome(item.id, { status: 'failed', error: msg })
    }
  }
}

/**
 * On startup, report outcomes for any items that were dispatched in a prior
 * run that crashed before reportOutcome could complete. Called at the top of
 * each pollOnce() so the first real batch runs against a clean journal.
 *
 * @param {{ reportOutcome, journalList, journalClear, log }} deps
 */
async function flushJournal({ reportOutcome, journalList, journalClear, log }) {
  const pending = journalList()
  if (pending.length === 0) return
  log(`flushing ${pending.length} unconfirmed dispatch(es) from prior crash`)
  for (const id of pending) {
    const reported = await reportOutcome(id, { status: 'sent' })
    if (reported) {
      journalClear(id)
      log(`flushed dispatch journal for item ${id}`)
    } else {
      log(`could not confirm outcome for ${id} — journal entry kept, will retry on next cycle`)
    }
  }
}

async function pollOnce() {
  await flushJournal({
    reportOutcome,
    journalList:  () => journal.list(),
    journalClear: (id) => journal.clear(id),
    log,
  })

  let items
  try {
    items = await fetchPendingBatch()
  } catch (e) {
    log('poll fetch error:', e.message || e)
    return { itemCount: 0, fetchError: e.message || String(e) }
  }
  if (items.length === 0) return { itemCount: 0 }

  log(`processing ${items.length} pending iMessage(s)`)
  await processBatch(items, {
    reportOutcome,
    dispatchToLocalSender,
    maxAttempts: MAX_ATTEMPTS,
    log,
    journalMark:  (id) => journal.mark(id),
    journalClear: (id) => journal.clear(id),
    journalList:  () => journal.list(),
  })

  return { itemCount: items.length }
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
 * @param {{ _pollOnce?, _delay?, _isShuttingDown?, _reportHealth? }} deps
 */
async function loop({
  _pollOnce = pollOnce,
  _delay = (ms) => new Promise(r => setTimeout(r, ms)),
  _isShuttingDown = () => shuttingDown,
  _reportHealth = reportHealth,
} = {}) {
  // First tick immediately, then on interval.
  for (;;) {
    const startMs = Date.now()
    try {
      const result = await _pollOnce()
      const durationMs = Date.now() - startMs
      if (result?.fetchError) {
        // fetchPendingBatch exhausted retries — queue unreachable. Surface as
        // error so the cloud health dashboard doesn't show a silent 0-item run.
        _reportHealth('poller', 'error', { errorMessage: result.fetchError, durationMs })
      } else {
        const itemCount = result?.itemCount || 0
        _reportHealth('poller', 'ok', { itemCount, durationMs })
      }
    } catch (e) {
      const durationMs = Date.now() - startMs
      log('poll cycle error (will retry):', e.message || e)
      _reportHealth('poller', 'error', { errorMessage: e.message, durationMs })
    }
    if (_isShuttingDown()) return
    await _delay(POLL_INTERVAL_MS)
    if (_isShuttingDown()) return
  }
}

if (require.main === module) {
  // Catch unhandled exceptions so they're logged before the process exits.
  // launchd will restart the poller, but without this, crashes would appear
  // only in poller.error.log — easy to miss in triage.
  process.on('uncaughtException', (err) => {
    log('FATAL: uncaught exception:', err.message)
    log(err.stack || err)
    process.exit(1)
  })

  // Catch unhandled promise rejections so they don't silently fail.
  process.on('unhandledRejection', (reason, promise) => {
    log('FATAL: unhandled rejection:', reason)
    process.exit(1)
  })

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

module.exports = { processBatch, flushJournal, reportOutcome, fetchPendingBatch, dispatchToLocalSender, loop }
