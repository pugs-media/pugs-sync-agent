/**
 * Pugs Sync Agent — Scanner
 *
 * Reads new iMessage rows from ~/Library/Messages/chat.db and POSTs them to
 * the Pugs Sales cloud webhook. Tracks state in ../state.json so we only
 * send messages we haven't sent before.
 *
 * Run by launchd every 5 minutes via com.pugs.syncagent.scanner.plist.
 *
 * Why we copy the DB first: chat.db is locked while Messages.app is open.
 * SQLite supports concurrent readers via WAL, but copying is safer.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { syncContacts } = require('./contacts')
const { filterMessages } = require('./filter')
const { snapshotSqlite, cleanupSnapshot } = require('./snapshot')
const { normalizeRows } = require('./payload')
const { loadState, saveState } = require('./state')
const { fetchWithTimeout } = require('./fetch-timeout')
const { reportHealth } = require('./health-report')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const WEBHOOK_URL = process.env.PUGS_SYNC_WEBHOOK_URL
const SECRET      = process.env.PUGS_SYNC_SECRET
// PUGS_SCANNER_ID identifies which physical machine is sending. Must match
// one of the values in pugs-sales' ALLOWED_SCANNER_IDS env (comma-separated)
// once that allowlist is active. Empty string = unidentified scanner —
// pugs-sales' scanner-guard will 403 if the allowlist is on.
const SCANNER_ID  = process.env.PUGS_SCANNER_ID || ''
// EXPECTED_APPLE_ID: if set, the scanner only treats outbound messages as
// "Connor's" when chat.db's message.account matches this value. Otherwise
// outbound from any account (which can happen if multiple iClouds are
// signed into Messages.app) gets dropped, preventing the prospect
// auto-extend backdoor where a different iCloud's outbound silently
// promotes recipients into the allowlist. Unset = no filter (back-compat).
const EXPECTED_APPLE_ID = process.env.EXPECTED_APPLE_ID || ''
const CHAT_DB     = process.env.CHAT_DB_PATH || path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
const STATE_PATH  = path.join(__dirname, '..', 'state.json')
const BATCH_SIZE  = 200
const MAX_PROSPECT_FETCH_TRIES = 3
const MAX_WEBHOOK_POST_TRIES = 3
const INITIAL_BACKFILL_DAYS = parseInt(process.env.INITIAL_BACKFILL_DAYS || '90', 10)
const CONTACTS_SYNC_INTERVAL_MS = 60 * 60 * 1000  // once per hour (was 24h —
// dropped while we get visibility into whether the sync is firing at all)
const NEW_DRAFT_MIN_THROTTLE_MS = 60 * 1000   // min gap between new-draft-triggered contact syncs

if (!WEBHOOK_URL || !SECRET) {
  console.error('Missing PUGS_SYNC_WEBHOOK_URL or PUGS_SYNC_SECRET in .env')
  process.exit(2)
}

try {
  new URL(WEBHOOK_URL)
} catch (e) {
  console.error(`Invalid PUGS_SYNC_WEBHOOK_URL: ${e.message}`)
  process.exit(2)
}

if (!Number.isInteger(INITIAL_BACKFILL_DAYS) || INITIAL_BACKFILL_DAYS < 0) {
  console.error(`Invalid INITIAL_BACKFILL_DAYS: "${process.env.INITIAL_BACKFILL_DAYS || '90'}" — must be a non-negative integer`)
  process.exit(2)
}

// ───────────────────────────────────────────────────────────────────────
// Helpers


/**
 * Copy chat.db (plus its WAL sidecars) to a temp file we can safely query.
 * Messages.app runs chat.db in WAL mode, so the newest messages live in
 * chat.db-wal until a checkpoint — snapshotSqlite copies the sidecars too so
 * the read-only open below replays the WAL and sees them. See ./snapshot.js.
 */
function snapshotDb() {
  const dest = path.join(os.tmpdir(), `pugs-chat-${Date.now()}.db`)
  snapshotSqlite(CHAT_DB, dest)
  return dest
}

/**
 * Parse the new_drafts_created count from the webhook response body.
 * Returns 0 and logs a warning if the body is not valid JSON or lacks the
 * field — callers fall back to the hourly contacts-sync cadence rather than
 * silently skipping enrichment with no log trail.
 */
function parseNewDraftsCount(text) {
  try {
    return (JSON.parse(text) || {}).new_drafts_created || 0
  } catch (e) {
    console.warn(`parseNewDraftsCount: could not parse webhook response (${e.message}) — falling back to hourly contacts-sync cadence`)
    return 0
  }
}

/**
 * Derive the contacts-sync webhook base URL from the inbound webhook URL.
 * Uses URL.origin (scheme + host + port) — NOT a regex path-strip — so it
 * works correctly regardless of the webhook path (e.g. staging URLs without
 * '/api/' in the path). Mirrors the same approach used by fetchProspectHandles.
 *
 * @param {string} webhookUrl  e.g. https://pugs-sales.vercel.app/api/import/imessage
 * @returns {string}           e.g. https://pugs-sales.vercel.app
 */
function contactsBase(webhookUrl) {
  return new URL(webhookUrl).origin
}

/**
 * Decide whether to run a contacts sync this scanner tick.
 * Pure — injectable `now` makes it unit-testable without real clocks.
 *
 * Returns { should: bool, trigger: string|null }.
 *
 * Two paths to true:
 *  - new drafts were created AND >60s since last sync (immediate enrichment)
 *  - >1h since last sync, regardless of new drafts (rename/rename catch-up)
 *
 * The hourly fallback is the correctness invariant: it must fire even on
 * scanner runs that found zero new messages, so address-book renames stay
 * current during quiet periods. Callers that return early before reaching
 * this check break that invariant.
 */
function shouldSyncContacts(lastContactsAt, newDraftsThisRun, { now = Date.now() } = {}) {
  // Parse the stored timestamp. new Date('garbage').getTime() returns NaN, and
  // NaN comparisons always return false — so a corrupt value would silently
  // prevent the hourly fallback from ever firing, stopping all name enrichment.
  // Fall back to 0 (treat as "never synced") so the hourly fallback triggers
  // on the very next run, the same as when the field is absent entirely.
  const parsedMs = lastContactsAt ? new Date(lastContactsAt).getTime() : NaN
  const lastSync = Number.isFinite(parsedMs) ? parsedMs : 0
  const sinceLastSync = now - lastSync
  if (newDraftsThisRun > 0 && sinceLastSync > NEW_DRAFT_MIN_THROTTLE_MS) {
    return { should: true, trigger: `${newDraftsThisRun} new draft(s)` }
  }
  if (sinceLastSync > CONTACTS_SYNC_INTERVAL_MS) {
    return { should: true, trigger: 'hourly fallback' }
  }
  return { should: false, trigger: null }
}

/**
 * Fetch the prospect handle allowlist from the cloud, falling back to the
 * cached version in state.json if the cloud is temporarily unreachable.
 *
 * Returns a live prospects object { phones: Set, emails: Set, total } on
 * success (either live or cached). Throws on permanent failure so the caller
 * can exit(5) with a clear error.
 *
 * Extracted from main() so the cache-fallback branch is unit-testable without
 * mocking the entire scan flow. Without this, a silent regression in the
 * fallback path (wrong cache key, corrupt state read) would cause the scanner
 * to halt on every cloud outage rather than use cached data — an undetected
 * lead-loss risk.
 */
async function fetchOrCachedProspects({
  webhookUrl  = WEBHOOK_URL,
  secret      = SECRET,
  scannerId   = SCANNER_ID,
  statePath   = STATE_PATH,
  _fetch,
  _delay,
  _timeoutMs,
  _saveState  = saveState,
} = {}) {
  const fetchOpts = { webhookUrl, secret, scannerId }
  if (_fetch     !== undefined) fetchOpts._fetch     = _fetch
  if (_delay     !== undefined) fetchOpts._delay     = _delay
  if (_timeoutMs !== undefined) fetchOpts._timeoutMs = _timeoutMs

  let prospects
  try {
    prospects = await fetchProspectHandles(fetchOpts)
  } catch (fetchErr) {
    const stateForCache = loadState(statePath)
    const cache = stateForCache.cached_prospects
    if (cache) {
      let cachedProspects
      try {
        cachedProspects = parseProspectHandles(cache)
      } catch (cacheErr) {
        throw new Error(`Failed to fetch prospect allowlist and cached allowlist is invalid — halting scan. fetch: ${fetchErr.message}; cache: ${cacheErr.message}`)
      }
      console.warn(`Could not reach prospect-handles endpoint (${fetchErr.message}) — using cached allowlist (${cachedProspects.phones.size} phones + ${cachedProspects.emails.size} emails)`)
      return cachedProspects
    }
    throw new Error(`Failed to fetch prospect allowlist — halting scan (no cache available). ${fetchErr.message}`)
  }

  // Persist the fresh allowlist to state.json so it's available as a cache
  // fallback on the next run if the cloud is temporarily unreachable. A save
  // failure (disk full, permissions) must not mask the fresh fetch — use the
  // fresh data for this run and log a warning so the failure is visible.
  try {
    const stateForCache = loadState(statePath)
    _saveState(statePath, { ...stateForCache, cached_prospects: serializeProspects(prospects) })
  } catch (saveErr) {
    console.warn(`fetchOrCachedProspects: could not cache fresh allowlist — ${saveErr.message}. Fresh data used this run; cache will not reflect latest allowlist.`)
  }

  return prospects
}

// ───────────────────────────────────────────────────────────────────────
// Main

/**
 * POST a message batch to the inbound webhook. Retries up to
 * MAX_WEBHOOK_POST_TRIES times on 5xx and network errors; throws immediately
 * on 4xx (permanent errors: bad secret, bad request — no point retrying).
 * Returns the Response object on success so the caller can read the body.
 *
 * Without this, a transient Vercel cold-start or brief network blip would
 * fail the most critical path in the scan — matching the retry behaviour
 * already in fetchProspectHandles and poll.js's fetchPendingBatch.
 */
async function sendHeartbeat({
  _fetch     = fetch,
  _delay     = (ms) => new Promise(r => setTimeout(r, ms)),
  _timeoutMs = 10_000,
  webhookUrl = WEBHOOK_URL,
  secret     = SECRET,
  scannerId  = SCANNER_ID,
} = {}) {
  return postToWebhook({ messages: [] }, { _fetch, _delay, _timeoutMs, webhookUrl, secret, scannerId })
}

async function postToWebhook(payload, {
  _fetch     = fetch,
  _delay     = (ms) => new Promise(r => setTimeout(r, ms)),
  _timeoutMs = 10_000,
  webhookUrl = WEBHOOK_URL,
  secret     = SECRET,
  scannerId  = SCANNER_ID,
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= MAX_WEBHOOK_POST_TRIES; attempt++) {
    let res
    try {
      res = await fetchWithTimeout(webhookUrl, {
        method:  'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-pugs-sync-secret': secret,
          'x-pugs-scanner-id':  scannerId,
        },
        body: JSON.stringify(payload),
      }, _timeoutMs, _fetch)
    } catch (e) {
      // Network error — retry
      lastError = e
      if (attempt < MAX_WEBHOOK_POST_TRIES) await _delay(500 * attempt)
      continue
    }
    if (res.ok) return res
    const errText = (await res.text()).slice(0, 500)
    const err = new Error(`webhook ${res.status}: ${errText}`)
    // 408 (timeout) and 429 (rate limit) are transient; retry like 5xx.
    // Other 4xx (401, 403, 400) are permanent — no retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw err
    lastError = err
    if (attempt < MAX_WEBHOOK_POST_TRIES) await _delay(500 * attempt)
  }
  throw lastError
}

/**
 * Validates and parses the raw JSON body from the prospect-handles endpoint.
 * Throws if the shape is wrong — a malformed response (e.g. phones:null or
 * phones:{}) would otherwise silently zero out the allowlist, dropping all
 * prospect messages with no error logged.
 */
function parseProspectHandles(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    throw new Error('prospect-handles response is not an object')
  }
  if (j.phones !== undefined && !Array.isArray(j.phones)) {
    throw new TypeError(`prospect-handles: phones must be an array, got ${j.phones === null ? 'null' : typeof j.phones}`)
  }
  if (j.emails !== undefined && !Array.isArray(j.emails)) {
    throw new TypeError(`prospect-handles: emails must be an array, got ${j.emails === null ? 'null' : typeof j.emails}`)
  }
  // Normalize phones to bare 10-digit keys so they match the same normalization
  // makeHandleAllowed applies to incoming chat.db handles. Without this, a phone
  // returned by the API in E.164 (+14155550100) or any other format would never
  // match a normalized handle (4155550100), silently filtering the message as
  // "not-prospect" — a lead loss. Non-numeric or too-short entries are dropped.
  const normalizedPhones = (j.phones ?? [])
    .map(p => (typeof p === 'string' ? p.replace(/\D/g, '').slice(-10) : ''))
    .filter(p => p.length === 10)
  return {
    phones: new Set(normalizedPhones),
    emails: new Set((j.emails ?? []).map(e => e.toLowerCase())),
    total:  (j.count_phones || 0) + (j.count_emails || 0),
  }
}

/**
 * Convert a live prospects object ({ phones: Set, emails: Set }) to a plain
 * JSON-serializable form for caching in state.json. Use parseProspectHandles
 * to reconstruct the live form from the serialized value.
 */
function serializeProspects(prospects) {
  return {
    phones: [...prospects.phones],
    emails: [...prospects.emails],
  }
}

// Fetch the prospect-handle allowlist from pugs-sales. Returns
// { phones: Set, emails: Set, total }. Retries up to MAX_PROSPECT_FETCH_TRIES
// times with exponential backoff before throwing. Throws on persistent failure
// so the caller can halt — we never ingest without a valid allowlist.
async function fetchProspectHandles({
  _fetch     = fetch,
  _delay     = (ms) => new Promise(r => setTimeout(r, ms)),
  _timeoutMs = 10_000,
  webhookUrl = WEBHOOK_URL,
  secret     = SECRET,
  scannerId  = SCANNER_ID,
} = {}) {
  const base = new URL(webhookUrl).origin
  const url  = `${base}/api/sync/prospect-handles`
  let lastError
  for (let attempt = 1; attempt <= MAX_PROSPECT_FETCH_TRIES; attempt++) {
    let res
    try {
      res = await fetchWithTimeout(url, {
        headers: { 'x-pugs-sync-secret': secret, 'x-pugs-scanner-id': scannerId },
      }, _timeoutMs, _fetch)
    } catch (e) {
      lastError = e
      if (attempt < MAX_PROSPECT_FETCH_TRIES) await _delay(500 * attempt)
      continue
    }
    if (res.ok) {
      let j
      try {
        j = await res.json()
      } catch (e) {
        throw new Error(`prospect-handles 200 bad JSON: ${e.message}`)
      }
      return parseProspectHandles(j)
    }
    const errText = (await res.text()).slice(0, 200)
    const err = new Error(`prospect-handles ${res.status}: ${errText}`)
    // 408 (timeout) and 429 (rate limit) are transient; retry like 5xx.
    // Other 4xx (401, 403, 400) are permanent — no retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw err
    lastError = err
    if (attempt < MAX_PROSPECT_FETCH_TRIES) await _delay(500 * attempt)
  }
  throw lastError
}

/**
 * Validate that the expected chat.db tables and columns exist before querying.
 * Throws with a clear, diagnosable message if a macOS upgrade has altered the
 * schema — far better than a cryptic SQL error mid-scan or silent data loss.
 * Called once per snapshot in main() before queryNewMessages.
 *
 * @param {import('better-sqlite3').Database} db  open snapshot DB
 */
function assertChatDbSchema(db) {
  const required = {
    message:           ['ROWID', 'guid', 'text', 'date', 'is_from_me', 'service', 'account', 'handle_id'],
    handle:            ['ROWID', 'id'],
    chat:              ['ROWID', 'guid', 'display_name'],
    chat_message_join: ['chat_id', 'message_id'],
    chat_handle_join:  ['chat_id', 'handle_id'],
  }
  for (const [table, cols] of Object.entries(required)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all()
    if (info.length === 0) {
      throw new Error(`chat.db schema: table '${table}' not found — macOS may have changed the schema`)
    }
    const existing = new Set(info.map(r => r.name))
    for (const col of cols) {
      if (!existing.has(col)) {
        throw new Error(`chat.db schema: column '${table}.${col}' not found (found: ${[...existing].join(', ')}) — macOS may have changed the schema`)
      }
    }
  }
}

/**
 * Detect and recover from ROWID reset (VACUUM, macOS upgrade, Time Machine restore).
 * If the stored last_rowid is significantly greater than the current max ROWID,
 * it's a reset — fall back to a safe cutoff. Pure — injectable `now` makes it
 * unit-testable.
 *
 * Returns { cutoffRowid: number, detected: bool, reason: string|null }.
 *
 * @param {import('better-sqlite3').Database} db  open snapshot DB
 * @param {number} lastRowid   stored highwater mark
 * @param {object} [opts]
 * @param {() => number} [opts._now]  injectable clock — defaults to Date.now()
 * @returns {object}
 */
function detectAndRecoverRowidReset(db, lastRowid, { _now = Date.now } = {}) {
  if (lastRowid === 0) return { cutoffRowid: 0, detected: false, reason: null }

  const maxRow = db.prepare('SELECT MAX(ROWID) AS max_id FROM message').get()
  const maxRowid = maxRow?.max_id || 0

  // If max ROWID is 0 (empty table), no new messages — no reset needed, preserve cutoff
  if (maxRowid === 0) return { cutoffRowid: lastRowid, detected: false, reason: null }

  const cutoffMs = _now() - 7 * 86400000  // 7 days back
  const cutoffAppleNs = (cutoffMs - 978307200000) * 1e6

  // Primary check: large gap (>100K) between stored cursor and current max —
  // unmistakable major reset (macOS full rebuild, multi-year VACUUM).
  const ROWID_RESET_THRESHOLD = 100_000
  const isReset = lastRowid > maxRowid + ROWID_RESET_THRESHOLD

  // Secondary stall check: cursor is ahead of current max (any gap) AND a message
  // received in the last 7 days has ROWID below the cursor. In normal operation,
  // all recent messages would have ROWIDs above lastRowid (we processed them and
  // advanced the cursor). After a modest VACUUM or macOS rebuild that compresses
  // the DB by < 100K rows, recent messages are renumbered below the old cursor
  // and new messages start at maxRowid+1 — meaning every new lead is silently
  // missed until 100K new messages push the sequence past lastRowid (months on a
  // sales tool). Checking for recent messages below the cursor catches this class
  // of stall that the primary threshold alone misses.
  const isStall = !isReset && lastRowid > maxRowid && !!db.prepare(
    'SELECT ROWID FROM message WHERE date >= ? AND ROWID < ? LIMIT 1'
  ).get(cutoffAppleNs, lastRowid)

  if (isReset || isStall) {
    const row = db.prepare(
      'SELECT ROWID FROM message WHERE date >= ? ORDER BY ROWID ASC LIMIT 1'
    ).get(cutoffAppleNs)
    const safeCutoff = row ? row.ROWID - 1 : maxRowid
    const reason = isReset
      ? `ROWID reset detected (was ${lastRowid}, now max ${maxRowid})`
      : `ROWID stall detected (cursor ${lastRowid} > max ${maxRowid})`
    return { cutoffRowid: safeCutoff, detected: true, reason }
  }

  return { cutoffRowid: lastRowid, detected: false, reason: null }
}

/**
 * Query new messages from a chat.db snapshot.
 *
 * Uses a first_chat CTE to deduplicate: a message appearing in multiple rows
 * of chat_message_join (iCloud-sync and backup-restore edge cases) would
 * otherwise generate N rows for the same ROWID, causing the webhook to receive
 * the same iMessage multiple times. MIN(chat_id) makes the selection
 * deterministic — ties resolve to the lower-numbered chat rather than
 * whichever SQLite happens to return first.
 *
 * @param {import('better-sqlite3').Database} db  open snapshot DB
 * @param {number} lastRowid   highwater mark — only rows with ROWID > lastRowid are returned
 * @param {number} batchSize   maximum rows to return (LIMIT)
 * @returns {object[]} raw chat.db rows
 */
function queryNewMessages(db, lastRowid, batchSize) {
  return db.prepare(`
    WITH chat_participant_counts AS (
      SELECT chat_id, COUNT(*) AS participant_count
      FROM chat_handle_join
      GROUP BY chat_id
    ),
    first_chat AS (
      SELECT message_id, MIN(chat_id) AS chat_id
      FROM chat_message_join
      GROUP BY message_id
    )
    SELECT
      m.ROWID         AS rowid,
      m.guid          AS guid,
      m.text          AS text,
      m.date          AS date,
      m.is_from_me    AS is_from_me,
      m.service       AS service,
      m.account       AS account,
      h.id            AS handle,
      c.guid          AS chat_guid,
      c.display_name  AS chat_display_name,
      cpc.participant_count AS participant_count,
      (
        SELECT group_concat(h2.id, char(31))
        FROM chat_handle_join chj2
        JOIN handle h2 ON h2.ROWID = chj2.handle_id
        WHERE chj2.chat_id = fc.chat_id
      )               AS chat_participants_concat
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    JOIN first_chat fc ON fc.message_id = m.ROWID
    JOIN chat_participant_counts cpc ON cpc.chat_id = fc.chat_id
    JOIN chat c ON c.ROWID = fc.chat_id
    WHERE m.ROWID > ?
      AND m.text IS NOT NULL
      AND m.text != ''
    ORDER BY m.ROWID ASC
    LIMIT ?
  `).all(lastRowid, batchSize)
}

/**
 * Returns the ROWID to advance the cursor to when every row in a batch was
 * filtered by GUID dedup (already sent in a prior run), or null if the
 * condition does not apply.
 *
 * Extracted from main() so the condition and cursor formula can be unit-tested
 * independently. Without this, the advance-cursor branch in main() could be
 * silently removed or its formula changed without any test failing — a
 * regression risk for the post-ROWID-reset stall path.
 */
function computeAllDedupCursorRowid(rows, dedupedRows) {
  if (rows.length > 0 && dedupedRows.length === 0) {
    return rows[rows.length - 1].rowid
  }
  return null
}

async function main() {
  if (!fs.existsSync(CHAT_DB)) {
    console.error(`chat.db not found at ${CHAT_DB}`)
    console.error('Have you granted Full Disk Access to the Node binary?')
    process.exit(3)
  }

  // STRUCTURAL DEFENSE (added 2026-05-22): fetch the sales-prospect handle
  // allowlist before scanning. Only messages whose sender handle is in this
  // set (OR outbound messages from this Mac) get shipped to pugs-sales.
  // Stops Wickie / Nancy / Mom / friends / newsletter-collision noise dead
  // at the scanner — server has the same check as belt+suspenders.
  let prospects
  try {
    prospects = await fetchOrCachedProspects()
    console.log(`Prospect allowlist: ${prospects.phones.size} phones + ${prospects.emails.size} emails (${prospects.total} total)`)
  } catch (e) {
    console.error(e.message)
    process.exit(5)
  }

  const state = loadState(STATE_PATH)
  let cutoffRowid = state.last_rowid || 0
  let newDraftsThisRun = 0  // populated from /api/import/imessage response, used to trigger contacts sync
  let messageCount = 0  // track messages sent for health reporting

  // On very first run, derive a cutoff from INITIAL_BACKFILL_DAYS to avoid
  // dumping years of history in one request.
  let snapshotPath
  let db
  // process.exit() bypasses finally blocks, so a snapshot (full chat.db copy,
  // potentially hundreds of MB) would be left in /tmp every time the webhook or
  // state-save fails. With launchd restarting every 5 min, a sustained outage
  // could fill the disk. Register a once-exit handler so cleanup runs regardless
  // of whether the process exits via normal return or process.exit().
  let snapshotCleaned = false
  const cleanupOnExit = () => {
    if (snapshotCleaned) return
    snapshotCleaned = true
    try { if (db) db.close() } catch {}
    if (snapshotPath) cleanupSnapshot(snapshotPath)
  }
  process.once('exit', cleanupOnExit)
  try {
    snapshotPath = snapshotDb()
    db = new Database(snapshotPath, { readonly: true })
    assertChatDbSchema(db)

    // Detect ROWID reset (VACUUM, macOS upgrade) — if last_rowid is far ahead
    // of current max, it's a reset. Fall back to 7-day window to avoid losing
    // recent messages and not dumping pre-reset history.
    const resetCheck = detectAndRecoverRowidReset(db, cutoffRowid)
    if (resetCheck.detected) {
      console.warn(`${resetCheck.reason} — recovering with 7-day fallback`)
      cutoffRowid = resetCheck.cutoffRowid
    }

    if (cutoffRowid === 0 && INITIAL_BACKFILL_DAYS > 0) {
      const cutoffMs = Date.now() - INITIAL_BACKFILL_DAYS * 86400000
      // Apple nanoseconds since 2001
      const cutoffAppleNs = (cutoffMs - 978307200000) * 1e6
      const row = db.prepare(
        `SELECT ROWID FROM message WHERE date >= ? ORDER BY ROWID ASC LIMIT 1`
      ).get(cutoffAppleNs)
      cutoffRowid = row ? row.ROWID - 1 : 0
      console.log(`First run: starting from ROWID ${cutoffRowid} (${INITIAL_BACKFILL_DAYS}d back)`)
    }

    // Pull BOTH 1:1 and group chats. We used to filter groups out here with a
    // HAVING COUNT(*) = 1 CTE (groups = friends/family noise), but Connor wants
    // SALES-RELEVANT groups too (a deal/stakeholder chat). We no longer gate by
    // kind in SQL — instead we pull the per-chat participant count (1 external
    // handle = direct, 2+ = group) and let the prospect-intersect filter below
    // keep only chats with a client/prospect in them. Personal groups (no
    // allowlisted participant) are still dropped before anything leaves the Mac.
    //
    // chat-context (added 2026-05-21, migration 049): we also pull the chat
    // row's GUID, display_name, and the concatenated participant handles so
    // pugs-sales can give every message a stable thread identity.
    const rows = queryNewMessages(db, cutoffRowid, BATCH_SIZE)

    // GUID-based dedup: filter out rows we've already sent (by GUID).
    // This guards against ROWID reset (SQLite VACUUM or major macOS updates).
    const sentGuids = state.sent_guids ? new Set(state.sent_guids) : new Set()
    const dedupedRows = rows.filter(row => {
      if (sentGuids.has(row.guid)) {
        console.log(`Dedup skip GUID ${row.guid} (ROWID ${row.rowid}) — already sent in prior run`)
        return false
      }
      return true
    })

    if (!dedupedRows.length && !rows.length) {
      // Post empty payload so the server records a heartbeat — otherwise
      // a silent scanner is indistinguishable from a crashed scanner.
      console.log('No new messages — sending heartbeat')
      try {
        await sendHeartbeat()
      } catch (e) {
        const msg = `Heartbeat failed after retries: ${e.message}`
        console.error(msg)
        await reportHealth('scanner', 'error', { errorMessage: msg })
        process.exit(4)
      }
      // Fall through to contacts sync — the hourly cadence must fire even
      // on quiet runs with no new messages so address-book renames stay current.
    } else if (computeAllDedupCursorRowid(rows, dedupedRows) !== null) {
      const lastRowid = computeAllDedupCursorRowid(rows, dedupedRows)
      console.log(`All ${rows.length} rows were GUID-deduped (already sent) — advancing cursor to ROWID ${lastRowid} to unblock new messages`)
      try {
        saveState(STATE_PATH, { ...state, last_rowid: lastRowid, last_run_at: new Date().toISOString() })
      } catch (e) {
        const msg = `State save failed after all-GUID-dedup cursor advance: ${e.message}`
        console.error(msg)
        await reportHealth('scanner', 'error', { errorMessage: msg })
        process.exit(3)
      }
    } else if (dedupedRows.length > 0) {

    // Row -> cloud payload mapping lives in ./payload.js (pure + unit-tested) so
    // the group_concat participant separator and sent_at/handle drop rules cannot
    // silently regress. Drops rows with no usable timestamp or sender handle.
    const payload = normalizeRows(dedupedRows)
    const droppedByNormalize = dedupedRows.length - payload.length
    if (droppedByNormalize > 0) {
      console.log(`Dropped ${droppedByNormalize}/${dedupedRows.length} rows during normalization (corrupt timestamp or missing sender handle)`)
    }

    // Prospect intersect — drop inbound rows whose sender handle isn't in
    // the allowlist. Outbound (is_from_me=1) passes if (a) the row's
    // account matches EXPECTED_APPLE_ID (or EXPECTED_APPLE_ID is unset),
    // because outbound from the configured iCloud is Connor's deliberate
    // first-touch that auto-extends the allowlist server-side. Outbound
    // from a DIFFERENT account (= a different iCloud signed into Messages
    // on this Mac) gets dropped — that's the backdoor we're closing.
    const beforeProspect = payload.length
    // Scoping filter lives in ./filter.js (pure + unit-tested) — it enforces
    // the wrong-iCloud guard, group prospect-intersect, and direct-1:1 rules
    // that keep non-prospect/personal messages from ever leaving this Mac.
    const { kept: filteredPayload, droppedWrongAccount, droppedNotProspect } =
      filterMessages(payload, { prospects, expectedAppleId: EXPECTED_APPLE_ID })
    if (droppedNotProspect > 0 || droppedWrongAccount > 0) {
      console.log(`Dropped ${droppedNotProspect + droppedWrongAccount}/${beforeProspect} rows (${droppedNotProspect} not-prospect, ${droppedWrongAccount} wrong-apple-id)`)
    }

    const lastRowid = dedupedRows[dedupedRows.length - 1].rowid

    if (filteredPayload.length === 0) {
      // All rows were dropped by the prospect/account filter — nothing to ship.
      // Advance the cursor so the next scan doesn't re-read the same noise, but
      // do NOT call postToWebhook: an empty POST is wasteful and, if the webhook
      // is transiently down, would cause process.exit(4) for a batch with nothing
      // to send — masking the real health of the scanner.
      console.log(`All ${dedupedRows.length} rows filtered (${droppedNotProspect} not-prospect, ${droppedWrongAccount} wrong-apple-id) — advancing cursor to ROWID ${lastRowid}, no webhook POST`)
      try {
        saveState(STATE_PATH, { ...state, last_rowid: lastRowid, last_run_at: new Date().toISOString() })
      } catch (e) {
        const msg = `State save failed after all-filtered cursor advance: ${e.message}`
        console.error(msg)
        await reportHealth('scanner', 'error', { errorMessage: msg })
        process.exit(3)
      }
    } else {
    console.log(`Posting ${filteredPayload.length} messages (ROWIDs ${dedupedRows[0].rowid}..${lastRowid})`)

    let webhookResp
    try {
      webhookResp = await postToWebhook({ messages: filteredPayload })
    } catch (e) {
      const msg = `Webhook POST failed after retries: ${e.message}`
      console.error(msg)
      await reportHealth('scanner', 'error', { errorMessage: msg })
      process.exit(4)
    }
    const text = await webhookResp.text()
    console.log(`Webhook OK: ${text.slice(0, 200)}`)

    // Parse new_drafts_created from response so we can immediately enrich
    // names below. If parsing fails, fall back to hourly cadence — the
    // server-side response shape might evolve.
    newDraftsThisRun = parseNewDraftsCount(text)
    messageCount = filteredPayload.length

    // Only advance state if the POST succeeded.
    // Track GUIDs of ACTUALLY SENT messages (filteredPayload, not dedupedRows) so
    // that a non-prospect scanned today who becomes a prospect later can still have
    // their messages delivered after a ROWID reset recovery. Using dedupedRows would
    // permanently block those messages in sent_guids even though they were never
    // shipped to pugs-sales — a lead-loss risk after a VACUUM or macOS upgrade.
    const guidsToAdd = filteredPayload.map(r => r.guid)
    const newSentGuids = [...sentGuids, ...guidsToAdd]
    const MAX_SENT_GUIDS = 10000
    const boundedSentGuids = newSentGuids.slice(-MAX_SENT_GUIDS)
    try {
      saveState(STATE_PATH, { ...state, last_rowid: lastRowid, sent_guids: boundedSentGuids, last_run_at: new Date().toISOString() })
      console.log(`Advanced state to ROWID ${lastRowid}, tracked ${boundedSentGuids.length} sent GUIDs`)
    } catch (e) {
      // State persist failed (disk full, permissions, etc). A duplicate send is
      // safer than halting: the next scan will re-ingest the same messages but
      // the GUID dedup guard will prevent double-POST to pugs-sales. However,
      // this is a serious condition — report it so Charlie can investigate.
      const msg = `State save failed after webhook POST — risk of duplicate send on next scan: ${e.message}`
      console.error(msg)
      await reportHealth('scanner', 'error', { errorMessage: msg })
      process.exit(3)
    }
    } // end if (filteredPayload.length > 0)
    } // end else (rows.length > 0)
  } finally {
    snapshotCleaned = true  // prevent exit handler from double-running
    if (db) db.close()
    if (snapshotPath) cleanupSnapshot(snapshotPath)
  }

  // Contacts enrichment — POST (name, phone) and (name, email) pairs from
  // macOS AddressBook so nameless drafts in pugs-sales get their real names.
  // Server is enrichment-only: never creates new people rows from this payload.
  //
  // Trigger logic:
  //   - If this scan created any new drafts on the server, sync NOW (subject
  //     to a 60s minimum throttle to avoid burst hammering on backlog catchup).
  //   - Otherwise fall back to the hourly cadence (handles renames in Connor's
  //     address book even when no new leads arrive).
  const latestState = loadState(STATE_PATH)
  const { should: runContacts, trigger: contactsTrigger } =
    shouldSyncContacts(latestState.last_contacts_at, newDraftsThisRun)
  if (runContacts) {
    console.log(`Contacts sync trigger: ${contactsTrigger}`)
    const webhookBase = contactsBase(WEBHOOK_URL)
    try {
      const res = await syncContacts({ webhookBase, secret: SECRET, scannerId: SCANNER_ID })
      console.log('Contacts sync:', JSON.stringify(res))
      // Only advance the cadence on actual success — keep retrying if the
      // post failed or the AddressBook wasn't readable.
      if (res?.ok) {
        try {
          saveState(STATE_PATH, { ...latestState, last_contacts_at: new Date().toISOString() })
        } catch (e) {
          // State persist failed (disk full, permissions, etc). Non-fatal: contacts sync will run
          // again on the next scan. Log it and report so Charlie can monitor.
          const msg = `Contacts state save failed: ${e.message}`
          console.warn(msg)
          await reportHealth('scanner', 'error', { errorMessage: msg })
        }
      } else {
        // POST failed or returned error — report to cloud health so Charlie can monitor
        const reason = res?.error || 'unknown failure'
        await reportHealth('scanner', 'error', { errorMessage: `contacts sync failed: ${reason}` })
      }
    } catch (e) {
      console.error('Contacts sync failed (non-fatal):', e.message || e)
      // Surface sync errors to the cloud health endpoint so stalled enrichment is visible
      await reportHealth('scanner', 'error', { errorMessage: `contacts sync threw: ${e.message || String(e)}` })
    }
  }

  return { messageCount }
}

if (require.main === module) {
  // Catch unhandled exceptions so they're logged before the process exits.
  // launchd will restart the scanner, but without this, crashes would appear
  // only in scanner.error.log — easy to miss in triage.
  process.on('uncaughtException', (err) => {
    console.error('FATAL: uncaught exception:', err.message)
    console.error(err.stack || err)
    process.exit(1)
  })

  // Catch unhandled promise rejections so they don't silently fail.
  process.on('unhandledRejection', (reason, promise) => {
    console.error('FATAL: unhandled rejection:', reason)
    process.exit(1)
  })

  const startMs = Date.now()
  // Async IIFE so both branches can await reportHealth before exiting.
  // Without this, the .catch() callback is sync and process.exit(1) kills
  // the process before the health POST completes — the cloud dashboard
  // never sees the failure.
  ;(async () => {
    try {
      const result = await main()
      const durationMs = Date.now() - startMs
      // result may be undefined or { messageCount } depending on the main() flow
      const messageCount = result?.messageCount || 0
      await reportHealth('scanner', 'ok', { itemCount: messageCount, durationMs })
    } catch (e) {
      const durationMs = Date.now() - startMs
      console.error('Scan failed:', e)
      await reportHealth('scanner', 'error', { errorMessage: e.message, durationMs })
      process.exit(1)
    }
  })()
}

module.exports = { fetchProspectHandles, parseProspectHandles, fetchOrCachedProspects, postToWebhook, sendHeartbeat, parseNewDraftsCount, serializeProspects, contactsBase, assertChatDbSchema, detectAndRecoverRowidReset, queryNewMessages, shouldSyncContacts, computeAllDedupCursorRowid }
