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
  webhookUrl = WEBHOOK_URL,
  secret     = SECRET,
  scannerId  = SCANNER_ID,
} = {}) {
  return postToWebhook({ messages: [] }, { _fetch, _delay, webhookUrl, secret, scannerId })
}

async function postToWebhook(payload, {
  _fetch     = fetch,
  _delay     = (ms) => new Promise(r => setTimeout(r, ms)),
  webhookUrl = WEBHOOK_URL,
  secret     = SECRET,
  scannerId  = SCANNER_ID,
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= MAX_WEBHOOK_POST_TRIES; attempt++) {
    let res
    try {
      res = await _fetch(webhookUrl, {
        method:  'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-pugs-sync-secret': secret,
          'x-pugs-scanner-id':  scannerId,
        },
        body: JSON.stringify(payload),
      })
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

// Fetch the prospect-handle allowlist from pugs-sales. Returns
// { phones: Set, emails: Set, total }. Retries up to MAX_PROSPECT_FETCH_TRIES
// times with exponential backoff before throwing. Throws on persistent failure
// so the caller can halt — we never ingest without a valid allowlist.
async function fetchProspectHandles({
  _fetch     = fetch,
  _delay     = (ms) => new Promise(r => setTimeout(r, ms)),
  webhookUrl = WEBHOOK_URL,
  secret     = SECRET,
  scannerId  = SCANNER_ID,
} = {}) {
  const base = new URL(webhookUrl).origin
  const url  = `${base}/api/sync/prospect-handles`
  let lastError
  for (let attempt = 1; attempt <= MAX_PROSPECT_FETCH_TRIES; attempt++) {
    try {
      const res = await _fetch(url, {
        headers: { 'x-pugs-sync-secret': secret, 'x-pugs-scanner-id': scannerId },
      })
      if (res.ok) {
        const j = await res.json()
        return parseProspectHandles(j)
      }
      const errText = (await res.text()).slice(0, 200)
      lastError = new Error(`prospect-handles ${res.status}: ${errText}`)
    } catch (e) {
      lastError = e
    }
    if (attempt < MAX_PROSPECT_FETCH_TRIES) await _delay(500 * attempt)
  }
  throw lastError
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
  } catch (e) {
    console.error(`Failed to fetch prospect allowlist — halting scan to avoid un-filtered ingest. ${e.message}`)
    process.exit(5)
  }

  const state = loadState(STATE_PATH)
  let cutoffRowid = state.last_rowid || 0
  let newDraftsThisRun = 0  // populated from /api/import/imessage response, used to trigger contacts sync

  // On very first run, derive a cutoff from INITIAL_BACKFILL_DAYS to avoid
  // dumping years of history in one request.
  const snapshotPath = snapshotDb()
  let db
  try {
    db = new Database(snapshotPath, { readonly: true })

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
    const rows = db.prepare(`
      WITH chat_participant_counts AS (
        SELECT chat_id, COUNT(*) AS participant_count
        FROM chat_handle_join
        GROUP BY chat_id
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
          WHERE chj2.chat_id = cmj.chat_id
        )               AS chat_participants_concat
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat_participant_counts cpc ON cpc.chat_id = cmj.chat_id
      JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ?
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.ROWID ASC
      LIMIT ?
    `).all(cutoffRowid, BATCH_SIZE)

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
      return
    }

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
  } finally {
    if (db) db.close()
    cleanupSnapshot(snapshotPath)
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
  const lastContactsAt = latestState.last_contacts_at ? new Date(latestState.last_contacts_at).getTime() : 0
  const sinceLastSync = Date.now() - lastContactsAt
  const NEW_DRAFT_MIN_THROTTLE_MS = 60 * 1000  // 60s
  const shouldRunForNewDrafts = newDraftsThisRun > 0 && sinceLastSync > NEW_DRAFT_MIN_THROTTLE_MS
  const shouldRunForFallback = sinceLastSync > CONTACTS_SYNC_INTERVAL_MS
  if (shouldRunForNewDrafts || shouldRunForFallback) {
    const trigger = shouldRunForNewDrafts ? `${newDraftsThisRun} new draft(s)` : 'hourly fallback'
    console.log(`Contacts sync trigger: ${trigger}`)
    const webhookBase = WEBHOOK_URL.replace(/\/api\/.*$/, '')
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

module.exports = { fetchProspectHandles, parseProspectHandles, postToWebhook, sendHeartbeat, parseNewDraftsCount }
