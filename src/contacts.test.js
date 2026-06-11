'use strict'

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')

const { snapshot, extractFromDb, buildName, dedupeContacts, postContactsPayload, syncContacts } = require('./contacts')

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

test('extractFromDb: returns empty instead of throwing on a corrupt (non-SQLite) file', () => {
  const badFile = path.join(dir, 'bad.abcddb')
  fs.writeFileSync(badFile, 'not a sqlite database')
  const result = extractFromDb(badFile)
  assert.deepEqual(result, { phones: [], emails: [] })
})

test('syncContacts: still sends contacts from readable books when one book is corrupt', async () => {
  const goodFile = path.join(dir, 'AddressBook-v22.abcddb')
  const goodDb = makeAddressBook(goodFile)
  addContact(goodDb, 1, { first: 'Lead', last: 'Acme', phone: '+1 (415) 555-0100', email: 'lead@acme.com' })
  goodDb.close()

  const badFile = path.join(dir, 'bad.abcddb')
  fs.writeFileSync(badFile, 'not a sqlite database')

  let capturedBody
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _findAddressBooks: () => [badFile, goodFile],
    _fetch: async (_url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, text: async () => '{"ok":true}' }
    },
    _delay: async () => {},
  })

  assert.ok(result.ok, 'sync must succeed despite one corrupt book')
  assert.equal(result.sent.phones, 1, 'contact from the good book must be sent')
  assert.equal(result.sent.emails, 1, 'email from the good book must be sent')
  assert.equal(capturedBody.phones.length, 1)
  assert.equal(capturedBody.emails.length, 1)
})

// ── dedupeContacts (pure) ────────────────────────────────────────────────────

test('dedupeContacts: keys phones by last 10 digits and emails by lowercased form', () => {
  const out = dedupeContacts({
    phones: [{ name: 'Lead Acme', phone: '+1 (415) 555-0100' }],
    emails: [{ name: 'Lead Acme', email: '  Lead@Acme.COM ' }],
  })
  assert.deepEqual(out.phones, [{ name: 'Lead Acme', phone: '+1 (415) 555-0100' }])
  // Email is canonicalized (trimmed + lower-cased) in the shipped payload.
  assert.deepEqual(out.emails, [{ name: 'Lead Acme', email: 'lead@acme.com' }])
})

test('dedupeContacts: collapses the same number/email across sources, first write wins', () => {
  // Same person in two AddressBook sources, differently formatted + named.
  const out = dedupeContacts({
    phones: [
      { name: 'Connor iCloud', phone: '415-555-0100' },
      { name: 'Connor Local',  phone: '+1 (415) 555-0100' },   // same last-10 → dropped
    ],
    emails: [
      { name: 'Connor iCloud', email: 'c@pugs.media' },
      { name: 'Connor Local',  email: 'C@Pugs.Media' },         // same lowercased → dropped
    ],
  })
  assert.deepEqual(out.phones, [{ name: 'Connor iCloud', phone: '415-555-0100' }])
  assert.deepEqual(out.emails, [{ name: 'Connor iCloud', email: 'c@pugs.media' }])
})

test('dedupeContacts: distinct handles are all kept and order is preserved', () => {
  const out = dedupeContacts({
    phones: [
      { name: 'A', phone: '415-555-0100' },
      { name: 'B', phone: '202-555-0199' },
    ],
    emails: [
      { name: 'A', email: 'a@x.com' },
      { name: 'B', email: 'b@y.com' },
    ],
  })
  assert.deepEqual(out.phones.map(p => p.name), ['A', 'B'])
  assert.deepEqual(out.emails.map(e => e.email), ['a@x.com', 'b@y.com'])
})

test('dedupeContacts: drops handles that cannot be a usable phone/email', () => {
  const out = dedupeContacts({
    phones: [
      { name: 'Short Code', phone: '262966' },        // < 10 digits → dropped
      { name: 'Blank',      phone: '' },               // empty → dropped
      { name: 'Missing',    phone: null },             // null → dropped
      { name: 'Good',       phone: '14155550100' },    // 11 digits → last 10 kept
    ],
    emails: [
      { name: 'No At',  email: 'not-an-email' },        // no '@' → dropped
      { name: 'Blank',  email: '' },                    // empty → dropped
      { name: 'Good',   email: 'good@example.com' },
    ],
  })
  assert.deepEqual(out.phones, [{ name: 'Good', phone: '14155550100' }])
  assert.deepEqual(out.emails, [{ name: 'Good', email: 'good@example.com' }])
})

test('dedupeContacts: tolerates an empty / missing input', () => {
  assert.deepEqual(dedupeContacts({}), { phones: [], emails: [] })
  assert.deepEqual(dedupeContacts(), { phones: [], emails: [] })
})

test('dedupeContacts: phone canonical key matches the scanner allowlist key (filter.js)', () => {
  // Regression guard: a contact and its prospect-allowlist entry must collapse
  // to the SAME last-10-digit key, or enrichment silently never matches.
  const { makeHandleAllowed } = require('./filter')
  const out = dedupeContacts({ phones: [{ name: 'Lead', phone: '+1 (415) 555-0100' }], emails: [] })
  const keyDigits = out.phones[0].phone.replace(/\D/g, '').slice(-10)
  const allowed = makeHandleAllowed({ phones: new Set([keyDigits]), emails: new Set() })
  assert.ok(allowed('14155550100'), 'same number in a different format must match the canonical key')
})

// ── postContactsPayload: retry behaviour ──────────────────────────────────────
// These mirror the postToWebhook tests in scan.test.js — same 3-attempt /
// exponential-backoff / 4xx-no-retry contract, applied to the contacts POST.

const NOOP_DELAY = async () => {}
const CONTACTS_URL = 'https://example.pugs.media/api/sync/contacts'
const CONTACTS_OPTS = { secret: 'test-secret', scannerId: '' }

test('postContactsPayload: returns response on first successful POST', async () => {
  let calls = 0
  const res = await postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
    _fetch: async () => { calls++; return { ok: true, text: async () => '{"ok":true}' } },
    _delay: NOOP_DELAY,
    ...CONTACTS_OPTS,
  })
  assert.equal(calls, 1)
  assert.equal(res.ok, true)
})

test('postContactsPayload: retries on 503 and succeeds on second attempt', async () => {
  let calls = 0
  const res = await postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 503, text: async () => 'Service Unavailable' }
      return { ok: true, text: async () => '{"ok":true}' }
    },
    _delay: NOOP_DELAY,
    ...CONTACTS_OPTS,
  })
  assert.equal(calls, 2, 'should retry once on 5xx and succeed')
  assert.equal(res.ok, true)
})

test('postContactsPayload: retries on network error and succeeds on second attempt', async () => {
  let calls = 0
  await postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
    _fetch: async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return { ok: true, text: async () => '{"ok":true}' }
    },
    _delay: NOOP_DELAY,
    ...CONTACTS_OPTS,
  })
  assert.equal(calls, 2, 'should retry once on network error and succeed')
})

test('postContactsPayload: throws immediately on 401 — permanent, no retry', async () => {
  let calls = 0
  await assert.rejects(
    () => postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 401, text: async () => 'unauthorized' } },
      _delay: NOOP_DELAY,
      ...CONTACTS_OPTS,
    }),
    /contacts webhook 401/,
  )
  assert.equal(calls, 1, '4xx must not be retried')
})

test('postContactsPayload: throws immediately on 403 — permanent, no retry', async () => {
  let calls = 0
  await assert.rejects(
    () => postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 403, text: async () => 'forbidden' } },
      _delay: NOOP_DELAY,
      ...CONTACTS_OPTS,
    }),
    /contacts webhook 403/,
  )
  assert.equal(calls, 1, '4xx must not be retried')
})

test('postContactsPayload: retries on 408 (request timeout) like a transient error', async () => {
  let calls = 0
  await assert.rejects(
    () => postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 408, text: async () => 'request timeout' } },
      _delay: NOOP_DELAY,
      ...CONTACTS_OPTS,
    }),
    /contacts webhook 408/,
  )
  assert.equal(calls, 3, '408 should be retried like 503')
})

test('postContactsPayload: retries on 429 (rate limit) like a transient error', async () => {
  let calls = 0
  await assert.rejects(
    () => postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 429, text: async () => 'too many requests' } },
      _delay: NOOP_DELAY,
      ...CONTACTS_OPTS,
    }),
    /contacts webhook 429/,
  )
  assert.equal(calls, 3, '429 should be retried like 503')
})

test('postContactsPayload: succeeds on 2nd attempt after a 429 rate limit', async () => {
  let calls = 0
  const result = await postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 429, text: async () => 'too many requests' }
      return { ok: true, status: 200, text: async () => 'ok' }
    },
    _delay: NOOP_DELAY,
    ...CONTACTS_OPTS,
  })
  assert.equal(calls, 2, 'should retry once on 429 and succeed')
  assert.ok(result.ok)
})

test('postContactsPayload: throws after all 3 retries exhausted on 503', async () => {
  let calls = 0
  await assert.rejects(
    () => postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 503, text: async () => 'err' } },
      _delay: NOOP_DELAY,
      ...CONTACTS_OPTS,
    }),
    /contacts webhook 503/,
  )
  assert.equal(calls, 3, 'should try exactly 3 times before throwing')
})

test('postContactsPayload: throws after all 3 retries exhausted on network error', async () => {
  let calls = 0
  await assert.rejects(
    () => postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
      _fetch: async () => { calls++; throw new Error('ECONNRESET') },
      _delay: NOOP_DELAY,
      ...CONTACTS_OPTS,
    }),
    /ECONNRESET/,
  )
  assert.equal(calls, 3, 'should try exactly 3 times on repeated network errors')
})

test('postContactsPayload: uses increasing backoff between retries', async () => {
  const delays = []
  await assert.rejects(
    () => postContactsPayload(CONTACTS_URL, { phones: [], emails: [] }, {
      _fetch: async () => ({ ok: false, status: 503, text: async () => 'err' }),
      _delay: async (ms) => { delays.push(ms) },
      ...CONTACTS_OPTS,
    }),
  )
  assert.deepEqual(delays, [500, 1000], 'delays should be 500ms then 1000ms (500 * attempt)')
})

// ── syncContacts: no-address-books branch ────────────────────────────────────
// These tests use _findAddressBooks injection to deterministically drive the
// no-books path on any host — no longer reliant on CI lacking AddressBook.

const NO_BOOKS = { _findAddressBooks: () => [], _delay: async () => {} }

test('syncContacts: posts empty payload with agent_note when no address books found', async () => {
  let capturedUrl, capturedBody, capturedHeaders
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: 'test-scanner',
    _fetch: async (url, opts) => {
      capturedUrl = url
      capturedBody = JSON.parse(opts.body)
      capturedHeaders = opts.headers
      return { ok: true, text: async () => '{"ok":true}' }
    },
    ...NO_BOOKS,
  })
  assert.equal(capturedUrl, 'https://example.pugs.media/api/sync/contacts')
  assert.equal(capturedBody.agent_note, 'no_address_books_found')
  assert.deepEqual(capturedBody.phones, [])
  assert.deepEqual(capturedBody.emails, [])
  assert.equal(capturedHeaders['x-pugs-sync-secret'], 'test-secret')
  assert.equal(capturedHeaders['x-pugs-scanner-id'], 'test-scanner')
  assert.ok(result.ok)
  assert.equal(result.skipped, 'no_address_books_found')
})

test('syncContacts no-address-books: returns ok:false when POST throws (non-fatal)', async () => {
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _fetch: async () => { throw new Error('ECONNRESET') },
    ...NO_BOOKS,
  })
  assert.equal(result.ok, false)
  assert.ok(result.error, 'error message must be present')
  assert.ok(result.error.includes('ECONNRESET'))
  assert.equal(result.skipped, 'no_address_books_found_and_post_failed')
})

test('syncContacts no-address-books: returns ok result on POST success', async () => {
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _fetch: async () => ({ ok: true, status: 200, text: async () => '{"enriched":5}' }),
    ...NO_BOOKS,
  })
  assert.ok(result.ok)
  assert.equal(result.skipped, 'no_address_books_found')
  assert.equal(result.server_status, 200)
})

test('syncContacts no-address-books: uses _fetch not bare global fetch', async () => {
  let fetchCalled = false
  await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _fetch: async () => { fetchCalled = true; return { ok: true, text: async () => '{}' } },
    ...NO_BOOKS,
  })
  assert.ok(fetchCalled, '_fetch injection must be called (not bare global fetch)')
})

test('syncContacts no-address-books: retries on 503 and succeeds on second attempt', async () => {
  // Before the fix, the no-books heartbeat used a bare fetchWithTimeout with no
  // retry. A transient Vercel cold-start would silently drop it. Now it goes
  // through postContactsPayload and gets the same 3-retry contract.
  let calls = 0
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 503, text: async () => 'Service Unavailable' }
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    },
    _delay: async () => {},
    ...NO_BOOKS,
  })
  assert.equal(calls, 2, 'should retry once on 503 and succeed')
  assert.ok(result.ok)
  assert.equal(result.skipped, 'no_address_books_found')
})

test('syncContacts no-address-books: fails after all retries exhausted on persistent 5xx', async () => {
  let calls = 0
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _fetch: async () => {
      calls++
      return { ok: false, status: 503, text: async () => 'Service Unavailable' }
    },
    _delay: async () => {},
    ...NO_BOOKS,
  })
  assert.equal(calls, 3, 'should exhaust 3 attempts before giving up')
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no_address_books_found_and_post_failed')
  assert.ok(result.error, 'error message must be present')
})

test('syncContacts no-address-books: does not retry on 401 (permanent auth failure)', async () => {
  let calls = 0
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'bad-secret',
    scannerId: '',
    _fetch: async () => {
      calls++
      return { ok: false, status: 401, text: async () => 'Unauthorized' }
    },
    _delay: async () => {},
    ...NO_BOOKS,
  })
  assert.equal(calls, 1, '4xx must not be retried')
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no_address_books_found_and_post_failed')
})

// ── syncContacts: _findAddressBooks throws (e.g. EACCES) ─────────────────────
// If the AddressBook Sources directory exists but is not readable, findAddressBooks
// throws EACCES. syncContacts must not propagate that — it should degrade to the
// no-books path so the server still receives a heartbeat and the scan loop continues.

test('syncContacts: does not throw when _findAddressBooks throws EACCES', async () => {
  const eaccesError = Object.assign(new Error('EACCES: permission denied, scandir \'/Users/test/Library/Application Support/AddressBook/Sources\''), { code: 'EACCES' })
  let postCalled = false
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _findAddressBooks: () => { throw eaccesError },
    _fetch: async (_url, opts) => {
      postCalled = true
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    },
    _delay: async () => {},
  })
  assert.ok(postCalled, 'should still POST a no-books heartbeat after the error')
  assert.ok(result.skipped, 'should return a skipped result, not throw')
})

test('syncContacts: falls back to no-books POST when _findAddressBooks throws any error', async () => {
  let capturedBody
  await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _findAddressBooks: () => { throw new Error('unexpected FS error') },
    _fetch: async (_url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, text: async () => '{}' }
    },
    _delay: async () => {},
  })
  assert.deepEqual(capturedBody.phones, [], 'fallback POST must have empty phones')
  assert.deepEqual(capturedBody.emails, [], 'fallback POST must have empty emails')
  assert.equal(capturedBody.agent_note, 'no_address_books_found')
})

// ── fetch timeout: postContactsPayload / syncContacts ─────────────────────────
// A slow or hung cloud must not stall the contacts-sync path indefinitely.

function hangingFetch(url, opts) {
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
}

test('postContactsPayload: aborts after _timeoutMs when cloud hangs', async () => {
  await assert.rejects(
    () => postContactsPayload(
      'https://example.pugs.media/api/sync/contacts',
      { phones: [], emails: [] },
      { _fetch: hangingFetch, _delay: NOOP_DELAY, _timeoutMs: 20, secret: 'test-secret' },
    ),
    { name: 'AbortError' },
  )
})

test('syncContacts no-books: aborts the bare no-books POST after _timeoutMs', async () => {
  // The no-books path has its own fetch call (not via postContactsPayload).
  // Verify it also times out rather than hanging.
  const result = await syncContacts({
    webhookBase: 'https://example.pugs.media',
    secret: 'test-secret',
    scannerId: '',
    _fetch: hangingFetch,
    _delay: NOOP_DELAY,
    _timeoutMs: 20,
    ...NO_BOOKS,
  })
  // syncContacts catches errors in the no-books path and returns ok:false — not a throw.
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no_address_books_found_and_post_failed')
  assert.ok(result.error, 'error message should be set')
})

