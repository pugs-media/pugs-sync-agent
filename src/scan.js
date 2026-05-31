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
 * Apple Core Data dates are seconds (older macOS) OR nanoseconds (Sierra+)
 * since 2001-01-01 00:00:00 UTC (978307200 unix seconds). Auto-detect.
 */
function appleDateToISO(d) {
  if (d === null || d === undefined) return null
  // Sentinel: nanoseconds since 2001 is > 1e15 in modern macOS
  const ms = d > 1e15 ? (d / 1e6) + 978307200000 : (d * 1000) + 978307200000
  if (!isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { last_rowid: 0 }
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

/**
 * Copy chat.db to a temp file we can safely query.
 */
function snapshotDb() {
  const dest = path.join(os.tmpdir(), `pugs-chat-${Date.now()}.db`)
  fs.copyFileSync(CHAT_DB, dest)
  return dest
}

// ───────────────────────────────────────────────────────────────────────
// Main

// Fetch the prospect-handle allowlist from pugs-sales. Returns
// { phonesSet, emailsSet, total }. Throws on network error so caller can
// decide whether to bail (we bail rather than ship un-filtered messages —
// a failed allowlist fetch is exactly the kind of edge case that should
// halt ingestion, not bypass it).
async function fetchProspectHandles() {
  const base = new URL(WEBHOOK_URL).origin
  const res = await fetch(`${base}/api/sync/prospect-handles`, {
    headers: {
      'x-pugs-sync-secret': SECRET,
      'x-pugs-scanner-id':  SCANNER_ID,
    },
  })
  if (!res.ok) {
    throw new Error(`prospect-handles ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const j = await res.json()
  return {
    phones: new Set(j.phones || []),
    emails: new Set((j.emails || []).map(e => e.toLowerCase())),
    total:  (j.count_phones || 0) + (j.count_emails || 0),
  }
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
    prospects = await fetchProspectHandles()
    console.log(`Prospect allowlist: ${prospects.phones.size} phones + ${prospects.emails.size} emails (${prospects.total} total)`)
  } catch (e) {
    console.error(`Failed to fetch prospect allowlist — halting scan to avoid un-filtered ingest. ${e.message}`)
    process.exit(5)
  }

  const state = loadState()
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
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-pugs-sync-secret': SECRET,
            'x-pugs-scanner-id': SCANNER_ID,
          },
          body: JSON.stringify({ messages: [] }),
        })
      } catch (e) {
        console.error(`Heartbeat failed: ${e.message}`)
      }
      db.close()
      fs.unlinkSync(snapshotPath)
      return
    }

    const payload = rows
      .map(r => ({
        rowid: r.rowid,
        guid: r.guid,
        text: r.text,
        sent_at: appleDateToISO(r.date),
        is_from_me: r.is_from_me ? 1 : 0,
        handle: r.handle,
        account: r.account || null,
        service: r.service === 'SMS' ? 'SMS' : 'iMessage',
        chat_id: r.chat_guid || null,
        // 1 external handle = direct (Connor + one other); 2+ = group.
        chat_kind: r.participant_count === 1 ? 'direct' : 'group',
        chat_name: r.chat_display_name || null,
        // group_concat uses ASCII Unit Separator (0x1F) — won't collide
        // with phone/email content. Returns null when chat has no handles.
        chat_participants: r.chat_participants_concat
          ? r.chat_participants_concat.split('').filter(Boolean)
          : null,
      }))
      .filter(r => r.sent_at && r.handle)

    // Prospect intersect — drop inbound rows whose sender handle isn't in
    // the allowlist. Outbound (is_from_me=1) passes if (a) the row's
    // account matches EXPECTED_APPLE_ID (or EXPECTED_APPLE_ID is unset),
    // because outbound from the configured iCloud is Connor's deliberate
    // first-touch that auto-extends the allowlist server-side. Outbound
    // from a DIFFERENT account (= a different iCloud signed into Messages
    // on this Mac) gets dropped — that's the backdoor we're closing.
    const beforeProspect = payload.length
    let droppedWrongAccount = 0
    // Is a single handle (phone or email) an allowlisted prospect/client?
    const handleAllowed = (handle) => {
      if (!handle) return false
      if (handle.includes('@')) return prospects.emails.has(handle.trim().toLowerCase())
      const digits = handle.replace(/\D/g, '').slice(-10)
      return digits.length === 10 && prospects.phones.has(digits)
    }
    const filteredPayload = payload.filter(p => {
      // Wrong-iCloud guard: outbound must come from the configured Apple ID,
      // regardless of chat kind. (account is like "iMessage;-;cjfpug@icloud.com";
      // includes() lets EXPECTED_APPLE_ID be the bare email/phone.)
      if (p.is_from_me && EXPECTED_APPLE_ID && p.account && !p.account.includes(EXPECTED_APPLE_ID)) {
        droppedWrongAccount++
        return false
      }
      if (p.chat_kind === 'group') {
        // Sales-relevant groups only: keep iff a client/prospect is in the room.
        // Personal groups (no allowlisted participant) never leave the Mac.
        return Array.isArray(p.chat_participants) && p.chat_participants.some(handleAllowed)
      }
      // Direct 1:1: outbound from the right account passes; inbound passes only
      // from an allowlisted prospect/client handle (unchanged behavior).
      if (p.is_from_me) return true
      return handleAllowed(p.handle)
    })
    const droppedNotProspect = beforeProspect - filteredPayload.length - droppedWrongAccount
    if (droppedNotProspect > 0 || droppedWrongAccount > 0) {
      console.log(`Dropped ${droppedNotProspect + droppedWrongAccount}/${beforeProspect} rows (${droppedNotProspect} not-prospect, ${droppedWrongAccount} wrong-apple-id)`)
    }

    console.log(`Posting ${filteredPayload.length} messages (ROWIDs ${rows[0].rowid}..${rows[rows.length - 1].rowid})`)

    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pugs-sync-secret': SECRET,
        'x-pugs-scanner-id': SCANNER_ID,
      },
      body: JSON.stringify({ messages: filteredPayload }),
    })
    const text = await resp.text()
    if (!resp.ok) {
      console.error(`Webhook failed ${resp.status}: ${text.slice(0, 500)}`)
      db.close()
      fs.unlinkSync(snapshotPath)
      process.exit(4)
    }
    console.log(`Webhook OK: ${text.slice(0, 200)}`)

    // Parse new_drafts_created from response so we can immediately enrich
    // names below. If parsing fails, fall back to hourly cadence — the
    // server-side response shape might evolve.
    try { newDraftsThisRun = (JSON.parse(text) || {}).new_drafts_created || 0 } catch {}

    // Only advance state if the POST succeeded
    const lastRowid = rows[rows.length - 1].rowid
    saveState({ ...state, last_rowid: lastRowid, last_run_at: new Date().toISOString() })
    console.log(`Advanced state to ROWID ${lastRowid}`)
  } finally {
    if (db) db.close()
    try { fs.unlinkSync(snapshotPath) } catch {}
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
  const latestState = loadState()
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
        saveState({ ...latestState, last_contacts_at: new Date().toISOString() })
      }
    } catch (e) {
      console.error('Contacts sync failed (non-fatal):', e.message || e)
    }
  }
}

main().catch(e => {
  console.error('Scan failed:', e)
  process.exit(1)
})
