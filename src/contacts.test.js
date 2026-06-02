'use strict'

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')

const { snapshot, extractFromDb, buildName } = require('./contacts')

// Each test gets its own scratch dir so parallel runs don't collide.
let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pugs-contacts-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// Build a minimal AddressBook-v22.abcddb with just the columns extractFromDb
// reads. Returns the open writer connection (caller closes) so the test can
// control WAL checkpointing.
function makeAddressBook(file) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT
    );
    CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
  `)
  return db
}

function addContact(db, pk, { first, last, org, phone, email }) {
  db.prepare(
    'INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION) VALUES (?, ?, ?, ?)'
  ).run(pk, first ?? null, last ?? null, org ?? null)
  if (phone) db.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)').run(pk, phone)
  if (email) db.prepare('INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)').run(pk, email)
}

// ── buildName (pure) ─────────────────────────────────────────────────────────

test('buildName: joins first + last, trims, falls back to org, then empty', () => {
  assert.equal(buildName('Ada', 'Lovelace', 'Acme'), 'Ada Lovelace')
  assert.equal(buildName('  Ada ', '', 'Acme'), 'Ada')
  assert.equal(buildName('', '', 'Acme Corp'), 'Acme Corp')
  assert.equal(buildName(null, null, null), '')
})

// ── extractFromDb ──────────────────────────────────────────────────────────

test('extractFromDb: pulls named phone + email pairs and skips nameless records', () => {
  const file = path.join(dir, 'AddressBook-v22.abcddb')
  const db = makeAddressBook(file)
  addContact(db, 1, { first: 'Lead', last: 'Acme', phone: '+1 (415) 555-0100', email: 'Lead@Acme.com' })
  addContact(db, 2, { org: 'BigCo', phone: '202-555-0199' })            // org-only name kept
  addContact(db, 3, { phone: '+1 999 000 1111' })                       // no name → dropped
  db.close()

  const { phones, emails } = extractFromDb(file)

  assert.deepEqual(
    phones.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'BigCo', phone: '202-555-0199' }, { name: 'Lead Acme', phone: '+1 (415) 555-0100' }]
  )
  assert.deepEqual(emails, [{ name: 'Lead Acme', email: 'Lead@Acme.com' }])
})

// ── the WAL-sidecar bug fix (parity with chat.db / PR #10) ───────────────────

test('snapshot: a contact still in the un-checkpointed WAL is seen via the snapshot but missed by a plain copy', () => {
  const src = path.join(dir, 'AddressBook-v22.abcddb')
  const db = makeAddressBook(src)

  // Fold the schema + an existing contact into the main file, then stop
  // auto-checkpointing so the NEXT write stays in the -wal sidecar — exactly
  // the state Contacts.app leaves the DB in between checkpoints.
  addContact(db, 1, { first: 'Old', last: 'Contact', phone: '111-222-3333' })
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.pragma('wal_autocheckpoint = 0')

  // Connor just saved a new prospect — this insert lives only in the WAL.
  addContact(db, 2, { first: 'Fresh', last: 'Prospect', phone: '415-555-0100' })
  // Keep the writer connection open (do NOT close) so the WAL is not checkpointed.

  // The WAL sidecar must actually exist and hold the un-checkpointed write.
  assert.ok(fs.existsSync(src + '-wal'), 'precondition: -wal sidecar should exist')

  // Control: a plain copy of only the main file misses the WAL-resident contact.
  const plain = path.join(dir, 'plain-copy.abcddb')
  fs.copyFileSync(src, plain)
  const plainNames = extractFromDb(plain).phones.map(p => p.name)
  assert.ok(plainNames.includes('Old Contact'), 'control should still see the checkpointed contact')
  assert.ok(
    !plainNames.includes('Fresh Prospect'),
    'control (plain copy) should MISS the WAL-resident contact — this is the bug'
  )

  // Fix: snapshot() copies the WAL sidecars, so the fresh contact is visible.
  const snap = snapshot(src)
  try {
    const snapNames = extractFromDb(snap).phones.map(p => p.name)
    assert.ok(snapNames.includes('Old Contact'), 'snapshot should see the checkpointed contact')
    assert.ok(
      snapNames.includes('Fresh Prospect'),
      'snapshot should see the WAL-resident contact — the sidecars were copied'
    )
  } finally {
    // snapshot() writes to os.tmpdir(); clean up its files + sidecars.
    const { cleanupSnapshot } = require('./snapshot')
    cleanupSnapshot(snap)
    db.close()
  }
})
