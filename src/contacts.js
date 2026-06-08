/**
 * Pugs Sync Agent — Contacts exporter (called from scan.js once/day)
 *
 * Reads Connor's Mac Contacts (AddressBook SQLite) and POSTs (name, phone)
 * and (name, email) pairs to pugs-sales so phone-only drafts in the people
 * table get named.
 *
 * Enrichment-only on the server side: the pugs-sales endpoint MUST NOT
 * create new people rows from contacts — only update existing ones. If
 * Connor saves someone in Contacts but has no iMessage / email history
 * with them, they don't become a CRM contact. Keeps the platform tight
 * to Connor's actual conversations.
 *
 * Address book schema (macOS 13+):
 *   ZABCDRECORD          — one row per contact; ZFIRSTNAME, ZLASTNAME, ZORGANIZATION
 *   ZABCDPHONENUMBER     — ZOWNER -> ZABCDRECORD.Z_PK; ZFULLNUMBER
 *   ZABCDEMAILADDRESS    — ZOWNER -> ZABCDRECORD.Z_PK; ZADDRESS
 *
 * macOS keeps multiple "sources" — iCloud, local, exchange — each with its
 * own AddressBook-v22.abcddb. We enumerate all of them and union the rows.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { snapshotSqlite, cleanupSnapshot } = require('./snapshot')

const MAX_CONTACTS_POST_TRIES = 3

const SOURCES_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources')

function findAddressBooks() {
  if (!fs.existsSync(SOURCES_DIR)) return []
  const dbs = []
  for (const sourceUuid of fs.readdirSync(SOURCES_DIR)) {
    const candidate = path.join(SOURCES_DIR, sourceUuid, 'AddressBook-v22.abcddb')
    if (fs.existsSync(candidate)) dbs.push(candidate)
  }
  return dbs
}

// Copy an AddressBook DB to a private temp path BEFORE querying it. Like
// chat.db, AddressBook-v22.abcddb is held open by Contacts.app in WAL journal
// mode, so the newest contacts (a prospect Connor just saved) live in the
// un-checkpointed `-wal` sidecar and are invisible if we copy only the main
// file. snapshotSqlite copies the sidecars too so the read-only open replays
// the WAL and sees them — same fix the scanner uses for chat.db. See
// ./snapshot.js.
function snapshot(srcPath) {
  const dest = path.join(os.tmpdir(), `pugs-ab-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  snapshotSqlite(srcPath, dest)
  return dest
}

function buildName(first, last, org) {
  const fn = (first || '').trim()
  const ln = (last  || '').trim()
  const combined = [fn, ln].filter(Boolean).join(' ').trim()
  if (combined) return combined
  return (org || '').trim() || ''
}

function extractFromDb(dbPath) {
  const out = { phones: [], emails: [] }
  let db
  try {
    db = new Database(dbPath, { readonly: true })

    const phoneRows = db.prepare(`
      SELECT
        r.ZFIRSTNAME    AS first,
        r.ZLASTNAME     AS last,
        r.ZORGANIZATION AS org,
        p.ZFULLNUMBER   AS phone
      FROM ZABCDRECORD r
      JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
      WHERE p.ZFULLNUMBER IS NOT NULL
    `).all()
    for (const row of phoneRows) {
      const name = buildName(row.first, row.last, row.org)
      if (!name) continue
      out.phones.push({ name, phone: row.phone })
    }

    const emailRows = db.prepare(`
      SELECT
        r.ZFIRSTNAME    AS first,
        r.ZLASTNAME     AS last,
        r.ZORGANIZATION AS org,
        e.ZADDRESS      AS email
      FROM ZABCDRECORD r
      JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
      WHERE e.ZADDRESS IS NOT NULL
    `).all()
    for (const row of emailRows) {
      const name = buildName(row.first, row.last, row.org)
      if (!name) continue
      out.emails.push({ name, email: row.email })
    }
  } catch (e) {
    console.error(`extractFromDb(${dbPath}): ${e.message} — returning empty, contacts from this source skipped`)
    return out
  } finally {
    if (db) db.close()
  }
  return out
}

/**
 * Canonicalize and de-duplicate the raw {name, phone} / {name, email} pairs
 * pulled from one or more AddressBook sources into the cloud payload shape.
 *
 * macOS keeps several AddressBook sources (iCloud, local, Exchange) and the
 * same person can appear in more than one, so the same number/email shows up
 * repeatedly — this is where that union collapses to one entry per handle.
 *
 *   - Phones are keyed by their last 10 digits (NANP local number) — the SAME
 *     key the scanner's prospect allowlist uses (see filter.js makeHandleAllowed)
 *     — so the cloud can match a contact regardless of +1 / spacing / punctuation.
 *     Anything that doesn't reduce to exactly 10 digits (short codes, partial
 *     entries) is dropped rather than shipped as an un-matchable handle.
 *   - Emails are keyed by their trimmed, lower-cased form; anything without an
 *     '@' is dropped.
 *   - First write wins per key, so earlier sources take precedence, and input
 *     order is preserved in the output for stable, testable results.
 *
 * Pure (no I/O) so this PII-shipping boundary is unit-testable on its own —
 * same pattern as filter.js / dispatch.js. syncContacts feeds it the rows it
 * read from each AddressBook snapshot.
 *
 * @param {{phones?: {name: string, phone: string}[], emails?: {name: string, email: string}[]}} raw
 * @returns {{phones: {name: string, phone: string}[], emails: {name: string, email: string}[]}}
 */
function dedupeContacts({ phones = [], emails = [] } = {}) {
  const phoneMap = new Map()
  for (const { name, phone } of phones) {
    const digits = (phone || '').replace(/\D/g, '').slice(-10)
    if (digits.length !== 10) continue
    if (!phoneMap.has(digits)) phoneMap.set(digits, { name, phone })
  }
  const emailMap = new Map()
  for (const { name, email } of emails) {
    const lower = (email || '').trim().toLowerCase()
    if (!lower.includes('@')) continue
    if (!emailMap.has(lower)) emailMap.set(lower, { name, email: lower })
  }
  return { phones: [...phoneMap.values()], emails: [...emailMap.values()] }
}

/**
 * POST contacts payload to the cloud with retry. Mirrors postToWebhook in
 * scan.js: retries up to MAX_CONTACTS_POST_TRIES times on 5xx / network
 * errors; throws immediately on 4xx (permanent — bad secret, bad request).
 * Returns the Response on success.
 *
 * Injectable _fetch / _delay allow deterministic unit testing.
 */
async function postContactsPayload(url, body, {
  _fetch    = fetch,
  _delay    = (ms) => new Promise(r => setTimeout(r, ms)),
  secret,
  scannerId = '',
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= MAX_CONTACTS_POST_TRIES; attempt++) {
    let res
    try {
      res = await _fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-pugs-sync-secret': secret,
          'x-pugs-scanner-id':  scannerId,
        },
        body: JSON.stringify(body),
      })
    } catch (e) {
      lastError = e
      if (attempt < MAX_CONTACTS_POST_TRIES) await _delay(500 * attempt)
      continue
    }
    if (res.ok) return res
    const errText = (await res.text()).slice(0, 500)
    const err = new Error(`contacts webhook ${res.status}: ${errText}`)
    if (res.status >= 400 && res.status < 500) throw err
    lastError = err
    if (attempt < MAX_CONTACTS_POST_TRIES) await _delay(500 * attempt)
  }
  throw lastError
}

/**
 * Sync Mac contacts to pugs-sales. Returns counts. Throws on hard errors.
 *
 * @param {object} opts
 * @param {string} opts.webhookBase - https://pugs-sales.vercel.app (no path)
 * @param {string} opts.secret      - PUGS_SYNC_SECRET
 * @param {string} [opts.scannerId] - PUGS_SCANNER_ID (sent as x-pugs-scanner-id)
 * @param {function} [opts._fetch]  - injectable fetch (tests)
 * @param {function} [opts._delay]  - injectable delay (tests)
 */
async function syncContacts({ webhookBase, secret, scannerId = '', _fetch = fetch, _delay = (ms) => new Promise(r => setTimeout(r, ms)), _findAddressBooks = findAddressBooks }) {
  const books = _findAddressBooks()
  if (!books.length) {
    // Still POST an empty payload so the server-side heartbeat records
    // "agent is alive, found no AddressBook sources at the expected path"
    // — otherwise we have zero visibility on whether the agent ran at all.
    try {
      const resp = await _fetch(`${webhookBase}/api/sync/contacts`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pugs-sync-secret': secret,
          'x-pugs-scanner-id': scannerId,
        },
        body: JSON.stringify({ phones: [], emails: [], agent_note: 'no_address_books_found' }),
      })
      const text = await resp.text()
      return { ok: resp.ok, skipped: 'no_address_books_found', server_status: resp.status, server: text.slice(0, 200) }
    } catch (e) {
      return { ok: false, skipped: 'no_address_books_found_and_post_failed', error: e?.message || String(e) }
    }
  }

  const rawPhones = []
  const rawEmails = []
  const snapshots = []
  try {
    for (const src of books) {
      const snap = snapshot(src)
      snapshots.push(snap)
      const { phones, emails } = extractFromDb(snap)
      rawPhones.push(...phones)
      rawEmails.push(...emails)
    }

    // Canonicalize + union across all sources (pure + unit-tested).
    const payload = dedupeContacts({ phones: rawPhones, emails: rawEmails })

    const resp = await postContactsPayload(
      `${webhookBase}/api/sync/contacts`,
      payload,
      { _fetch, _delay, secret, scannerId },
    )
    const text = await resp.text()
    return {
      ok: true,
      sent: { phones: payload.phones.length, emails: payload.emails.length },
      server: (() => { try { return JSON.parse(text) } catch { return text.slice(0, 200) } })(),
    }
  } finally {
    // cleanupSnapshot removes the main file AND its -wal/-shm sidecars (which
    // snapshot() now copies) — a plain unlink would leak the sidecars.
    for (const s of snapshots) {
      cleanupSnapshot(s)
    }
  }
}

module.exports = { syncContacts, postContactsPayload, findAddressBooks, snapshot, extractFromDb, buildName, dedupeContacts }
