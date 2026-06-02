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
  } finally {
    if (db) db.close()
  }
  return out
}

/**
 * Sync Mac contacts to pugs-sales. Returns counts. Throws on hard errors.
 *
 * @param {object} opts
 * @param {string} opts.webhookBase - https://pugs-sales.vercel.app (no path)
 * @param {string} opts.secret      - PUGS_SYNC_SECRET
 * @param {string} [opts.scannerId] - PUGS_SCANNER_ID (sent as x-pugs-scanner-id)
 */
async function syncContacts({ webhookBase, secret, scannerId = '' }) {
  const books = findAddressBooks()
  if (!books.length) {
    // Still POST an empty payload so the server-side heartbeat records
    // "agent is alive, found no AddressBook sources at the expected path"
    // — otherwise we have zero visibility on whether the agent ran at all.
    try {
      const resp = await fetch(`${webhookBase}/api/sync/contacts`, {
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

  const phoneMap = new Map()
  const emailMap = new Map()
  const snapshots = []
  try {
    for (const src of books) {
      const snap = snapshot(src)
      snapshots.push(snap)
      const { phones, emails } = extractFromDb(snap)

      for (const { name, phone } of phones) {
        const digits = (phone || '').replace(/\D/g, '').slice(-10)
        if (digits.length !== 10) continue
        if (!phoneMap.has(digits)) phoneMap.set(digits, { name, phone })
      }
      for (const { name, email } of emails) {
        const lower = (email || '').trim().toLowerCase()
        if (!lower.includes('@')) continue
        if (!emailMap.has(lower)) emailMap.set(lower, { name, email: lower })
      }
    }

    const payload = {
      phones: [...phoneMap.values()],
      emails: [...emailMap.values()],
    }

    const resp = await fetch(`${webhookBase}/api/sync/contacts`, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-pugs-sync-secret': secret,
        'x-pugs-scanner-id':  scannerId,
      },
      body: JSON.stringify(payload),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`contacts webhook failed ${resp.status}: ${text.slice(0, 500)}`)
    }
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

module.exports = { syncContacts, findAddressBooks, snapshot, extractFromDb, buildName }
