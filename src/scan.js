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
  const lastSync = lastContactsAt ? new Date(lastContactsAt).getTime() : 0
  const sinceLastSync = now - lastSync
  if (newDraftsThisRun > 0 && sinceLastSync > NEW_DRAFT_MIN_THROTTLE_MS) {
    return { should: true, trigger: `${newDraftsThisRun} new draft(s)` }
  }
  if (sinceLastSync > CONTACTS_SYNC_INTERVAL_MS) {
    return { should: true, trigger: 'hourly fallback' }
  }
  return { should: false, trigger: null }
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
    if (res.status >= 400 && res.status < 500) throw err  // permanent: no retry
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
  return {
    phones: new Set(j.phones ?? []),
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
    if (res.status >= 400 && res.status < 500) throw err  // permanent: no retry
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
    prospects = await fetchProspectHandles({ webhookUrl: WEBHOOK_URL, secret: SECRET, scannerId: SCANNER_ID })
    console.log(`Prospect allowlist: ${prospects.phones.size} phones + ${prospects.emails.size} emails (${prospects.total} total)`)
    // Persist a fresh copy immediately so the next run can fall back to it if
    // the cloud is temporarily unreachable. We load-then-merge to avoid
    // clobbering last_rowid or last_contacts_at that may already be on disk.
    const stateForCache = loadState(STATE_PATH)
    saveState(STATE_PATH, { ...stateForCache, cached_prospects: serializeProspects(prospects) })
  } catch (e) {
    // Cloud is down or unreachable — try the most-recently cached allowlist.
    // A stale cache is far safer than halting all inbound ingest: the allowlist
    // only ever grows (prospects are added, never removed mid-conversation), so
    // a few-hours-old list risks at most a temporary gap in new-prospect detection,
    // not leaking non-prospect messages (the cache is only used when fetch fails).
    const stateForCache = loadState(STATE_PATH)
    const cache = stateForCache.cached_prospects
    if (cache) {
      try {
        prospects = parseProspectHandles(cache)
        console.warn(`Could not reach prospect-handles endpoint (${e.message}) — using cached allowlist (${prospects.phones.size} phones + ${prospects.emails.size} emails)`)
      } catch (cacheErr) {
        console.error(`Failed to fetch prospect allowlist and cached allowlist is invalid — halting scan. fetch: ${e.message}; cache: ${cacheErr.message}`)
        process.exit(5)
      }
    } else {
      console.error(`Failed to fetch prospect allowlist — halting scan (no cache available). ${e.message}`)
      process.exit(5)
    }
  }

  const state = loadState(STATE_PATH)
  let cutoffRowid = state.last_rowid || 0
  let newDraftsThisRun = 0  // populated from /api/import/imessage response, used to trigger contacts sync

  // On very first run, derive a cutoff from INITIAL_BACKFILL_DAYS to avoid
  // dumping years of history in one request.
  let snapshotPath
  let db
  try {
    snapshotPath = snapshotDb()
    db = new Database(snapshotPath, { readonly: true })
    assertChatDbSchema(db)

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

    if (!rows.length) {
      // Post empty payload so the server records a heartbeat — otherwise
      // a silent scanner is indistinguishable from a crashed scanner.
      console.log('No new messages — sending heartbeat')
      try {
        await sendHeartbeat()
      } catch (e) {
        console.error(`Heartbeat failed after retries: ${e.message}`)
        process.exit(4)
      }
      // Fall through to contacts sync — the hourly cadence must fire even
      // on quiet runs with no new messages so address-book renames stay current.
    } else {

    // Row -> cloud payload mapping lives in ./payload.js (pure + unit-tested) so
    // the group_concat participant separator and sent_at/handle drop rules cannot
    // silently regress. Drops rows with no usable timestamp or sender handle.
    const payload = normalizeRows(rows)

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

    console.log(`Posting ${filteredPayload.length} messages (ROWIDs ${rows[0].rowid}..${rows[rows.length - 1].rowid})`)

    let webhookResp
    try {
      webhookResp = await postToWebhook({ messages: filteredPayload })
    } catch (e) {
      console.error(`Webhook failed: ${e.message}`)
      process.exit(4)
    }
    const text = await webhookResp.text()
    console.log(`Webhook OK: ${text.slice(0, 200)}`)

    // Parse new_drafts_created from response so we can immediately enrich
    // names below. If parsing fails, fall back to hourly cadence — the
    // server-side response shape might evolve.
    newDraftsThisRun = parseNewDraftsCount(text)

    // Only advance state if the POST succeeded
    const lastRowid = rows[rows.length - 1].rowid
    saveState(STATE_PATH, { ...state, last_rowid: lastRowid, last_run_at: new Date().toISOString() })
    console.log(`Advanced state to ROWID ${lastRowid}`)
    } // end else (rows.length > 0)
  } finally {
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
        saveState(STATE_PATH, { ...latestState, last_contacts_at: new Date().toISOString() })
      }
    } catch (e) {
      console.error('Contacts sync failed (non-fatal):', e.message || e)
    }
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('Scan failed:', e)
    process.exit(1)
  })
}

module.exports = { fetchProspectHandles, parseProspectHandles, postToWebhook, sendHeartbeat, parseNewDraftsCount, serializeProspects, contactsBase, assertChatDbSchema, queryNewMessages, shouldSyncContacts }
