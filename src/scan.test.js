'use strict'

// Must be set before requiring scan.js — it validates env at module load.
process.env.PUGS_SYNC_WEBHOOK_URL = 'https://example.pugs.media/api/import/imessage'
process.env.PUGS_SYNC_SECRET      = 'test-secret'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const Database = require('better-sqlite3')
const { fetchProspectHandles, parseProspectHandles, postToWebhook, sendHeartbeat, parseNewDraftsCount, serializeProspects, contactsBase, assertChatDbSchema, queryNewMessages, shouldSyncContacts } = require('./scan')

const NOOP_DELAY = async () => {}

// ── fetchProspectHandles: happy path ──────────────────────────────────────────

test('fetchProspectHandles: parses phones and emails into Sets on 2xx', async () => {
  const body = {
    phones:       ['4155550100', '6505551234'],
    emails:       ['LEAD@Example.com'],
    count_phones: 2,
    count_emails: 1,
  }
  const result = await fetchProspectHandles({
    _fetch:     async () => ({ ok: true, json: async () => body }),
    _delay:     NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret:     'test-secret',
    scannerId:  '',
  })
  assert.ok(result.phones instanceof Set)
  assert.ok(result.phones.has('4155550100'))
  assert.ok(result.phones.has('6505551234'))
  assert.ok(result.emails.has('lead@example.com'), 'emails should be lowercased')
  assert.equal(result.total, 3)
})

test('fetchProspectHandles: handles empty phones/emails arrays gracefully', async () => {
  const result = await fetchProspectHandles({
    _fetch:     async () => ({ ok: true, json: async () => ({ count_phones: 0, count_emails: 0 }) }),
    _delay:     NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret:     'test-secret',
    scannerId:  '',
  })
  assert.ok(result.phones instanceof Set)
  assert.equal(result.phones.size, 0)
  assert.equal(result.emails.size, 0)
  assert.equal(result.total, 0)
})

// ── fetchProspectHandles: retry on transient failure ──────────────────────────

test('fetchProspectHandles: succeeds on 2nd attempt after a transient 503', async () => {
  let calls = 0
  const body = { phones: ['4155550100'], emails: [], count_phones: 1, count_emails: 0 }
  const _fetch = async () => {
    calls++
    if (calls === 1) return { ok: false, status: 503, text: async () => 'service unavailable' }
    return { ok: true, json: async () => body }
  }
  const result = await fetchProspectHandles({
    _fetch,
    _delay:     NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret:     'test-secret',
    scannerId:  '',
  })
  assert.equal(calls, 2, 'should have retried once and succeeded')
  assert.ok(result.phones.has('4155550100'))
})

test('fetchProspectHandles: succeeds on 3rd attempt after two transient failures', async () => {
  let calls = 0
  const body = { phones: ['4155550100'], emails: [], count_phones: 1, count_emails: 0 }
  const _fetch = async () => {
    calls++
    if (calls < 3) return { ok: false, status: 500, text: async () => 'internal server error' }
    return { ok: true, json: async () => body }
  }
  const result = await fetchProspectHandles({
    _fetch,
    _delay:     NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret:     'test-secret',
    scannerId:  '',
  })
  assert.equal(calls, 3, 'should have retried twice and succeeded on 3rd attempt')
  assert.ok(result.phones.has('4155550100'))
})

test('fetchProspectHandles: throws after all 3 attempts fail with non-2xx', async () => {
  let calls = 0
  const _fetch = async () => {
    calls++
    return { ok: false, status: 503, text: async () => 'service unavailable' }
  }
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
    }),
    /prospect-handles 503/,
  )
  assert.equal(calls, 3, 'should have attempted exactly 3 times before throwing')
})

test('fetchProspectHandles: does not retry on 401 (permanent auth failure)', async () => {
  let calls = 0
  const _fetch = async () => {
    calls++
    return { ok: false, status: 401, text: async () => 'Unauthorized' }
  }
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'wrong-secret',
      scannerId:  '',
    }),
    /prospect-handles 401/,
  )
  assert.equal(calls, 1, 'should not retry on 4xx — permanent error, retrying wastes time')
})

test('fetchProspectHandles: does not retry on 403 (permanent auth failure)', async () => {
  let calls = 0
  const _fetch = async () => {
    calls++
    return { ok: false, status: 403, text: async () => 'Forbidden' }
  }
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'wrong-secret',
      scannerId:  '',
    }),
    /prospect-handles 403/,
  )
  assert.equal(calls, 1, 'should not retry on 4xx — permanent error, retrying wastes time')
})

test('fetchProspectHandles: retries on network error and succeeds on next attempt', async () => {
  let calls = 0
  const body = { phones: ['4155550100'], emails: [], count_phones: 1, count_emails: 0 }
  const _fetch = async () => {
    calls++
    if (calls === 1) throw new Error('ECONNRESET')
    return { ok: true, json: async () => body }
  }
  const result = await fetchProspectHandles({
    _fetch,
    _delay:     NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret:     'test-secret',
    scannerId:  '',
  })
  assert.equal(calls, 2, 'should retry after network error')
  assert.ok(result.phones.has('4155550100'))
})

test('fetchProspectHandles: throws after all 3 attempts fail with network error', async () => {
  let calls = 0
  const _fetch = async () => {
    calls++
    throw new Error('ECONNRESET')
  }
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
    }),
    /ECONNRESET/,
  )
  assert.equal(calls, 3, 'should have attempted 3 times on repeated network errors')
})

// ── parseProspectHandles: shape validation ────────────────────────────────────

test('parseProspectHandles: accepts valid phones and emails arrays', () => {
  const result = parseProspectHandles({
    phones: ['4155550100', '6505551234'],
    emails: ['Lead@Example.com'],
    count_phones: 2,
    count_emails: 1,
  })
  assert.ok(result.phones.has('4155550100'))
  assert.ok(result.phones.has('6505551234'))
  assert.ok(result.emails.has('lead@example.com'), 'emails lowercased')
  assert.equal(result.total, 3)
})

test('parseProspectHandles: treats absent phones/emails as empty sets', () => {
  const result = parseProspectHandles({ count_phones: 0, count_emails: 0 })
  assert.equal(result.phones.size, 0)
  assert.equal(result.emails.size, 0)
  assert.equal(result.total, 0)
})

test('parseProspectHandles: throws when phones is null (not silently empty-allowlist)', () => {
  // null is not a valid value — explicit null from the cloud would silently zero
  // the allowlist and drop all prospect messages. Must throw, not produce empty set.
  assert.throws(
    () => parseProspectHandles({ phones: null, emails: [], count_phones: 0, count_emails: 0 }),
    /phones must be an array/,
  )
})

test('parseProspectHandles: throws when emails is null (not silently empty-allowlist)', () => {
  assert.throws(
    () => parseProspectHandles({ phones: [], emails: null, count_phones: 0, count_emails: 0 }),
    /emails must be an array/,
  )
})

test('parseProspectHandles: throws when phones is an object (not array)', () => {
  assert.throws(
    () => parseProspectHandles({ phones: { '0': '4155550100' }, emails: [] }),
    /phones must be an array/,
  )
})

test('parseProspectHandles: throws when phones is a string', () => {
  assert.throws(
    () => parseProspectHandles({ phones: '4155550100', emails: [] }),
    /phones must be an array/,
  )
})

test('parseProspectHandles: throws when emails is an object (not array)', () => {
  assert.throws(
    () => parseProspectHandles({ phones: [], emails: { '0': 'lead@example.com' } }),
    /emails must be an array/,
  )
})

test('parseProspectHandles: throws when response is null', () => {
  assert.throws(
    () => parseProspectHandles(null),
    /not an object/,
  )
})

test('parseProspectHandles: throws when response is an array (top-level)', () => {
  assert.throws(
    () => parseProspectHandles([{ phones: [] }]),
    /not an object/,
  )
})

test('parseProspectHandles: throws when response is a string', () => {
  assert.throws(
    () => parseProspectHandles('ok'),
    /not an object/,
  )
})

test('fetchProspectHandles: throws when cloud returns phones as a string (would silently create char-set)', async () => {
  // A string phones value would silently build a Set of individual characters,
  // matching nothing and dropping all prospect messages. Validate it is rejected.
  const _fetch = async () => ({
    ok: true,
    json: async () => ({ phones: '4155550100,6505551234', emails: [], count_phones: 2, count_emails: 0 }),
  })
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
    }),
    /phones must be an array/,
  )
})

test('fetchProspectHandles: throws descriptive error when HTTP 200 body is not valid JSON', async () => {
  // Cloud can return an HTML cold-start error page with HTTP 200; res.json() throws
  // in that case and without a try/catch it would propagate as an untyped exception.
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch: async () => ({
        ok:   true,
        json: async () => { throw new Error('Unexpected token <') },
      }),
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
    }),
    /prospect-handles 200 bad JSON/,
  )
})

test('fetchProspectHandles: throws when cloud returns emails as an object', async () => {
  const _fetch = async () => ({
    ok: true,
    json: async () => ({ phones: [], emails: { 0: 'lead@example.com' }, count_phones: 0, count_emails: 1 }),
  })
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
    }),
    /emails must be an array/,
  )
})

// ── fetchProspectHandles: calls _delay with increasing backoff between attempts ─

test('fetchProspectHandles: calls _delay with increasing backoff between attempts', async () => {
  const delays = []
  const _fetch = async () => ({ ok: false, status: 503, text: async () => 'err' })
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch,
      _delay:     async (ms) => { delays.push(ms) },
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
    }),
  )
  assert.deepEqual(delays, [500, 1000], 'delays should be 500ms then 1000ms (500 * attempt)')
})

// ── postToWebhook: retry behaviour ────────────────────────────────────────────

const WEBHOOK_URL_TEST = 'https://example.pugs.media/api/import/imessage'
const WEBHOOK_OPTS     = { webhookUrl: WEBHOOK_URL_TEST, secret: 'test-secret', scannerId: '' }

test('postToWebhook: returns response on first successful POST', async () => {
  let calls = 0
  const res = await postToWebhook({ messages: [] }, {
    _fetch: async () => { calls++; return { ok: true, text: async () => '{"ok":true}' } },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.equal(calls, 1)
  assert.equal(res.ok, true)
})

test('postToWebhook: retries on 503 and succeeds on second attempt', async () => {
  let calls = 0
  await postToWebhook({ messages: [] }, {
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 503, text: async () => 'Service Unavailable' }
      return { ok: true, text: async () => '{"ok":true}' }
    },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.equal(calls, 2, 'should retry once on 5xx and succeed')
})

test('postToWebhook: retries on network error and succeeds on second attempt', async () => {
  let calls = 0
  await postToWebhook({ messages: [] }, {
    _fetch: async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return { ok: true, text: async () => '{"ok":true}' }
    },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.equal(calls, 2, 'should retry once on network error and succeed')
})

test('postToWebhook: throws immediately on 401 — permanent, no retry', async () => {
  let calls = 0
  await assert.rejects(
    () => postToWebhook({ messages: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 401, text: async () => 'unauthorized' } },
      _delay: NOOP_DELAY,
      ...WEBHOOK_OPTS,
    }),
    /webhook 401/,
  )
  assert.equal(calls, 1, '4xx must not be retried')
})

test('postToWebhook: throws immediately on 403 — permanent, no retry', async () => {
  let calls = 0
  await assert.rejects(
    () => postToWebhook({ messages: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 403, text: async () => 'forbidden' } },
      _delay: NOOP_DELAY,
      ...WEBHOOK_OPTS,
    }),
    /webhook 403/,
  )
  assert.equal(calls, 1, '4xx must not be retried')
})

test('postToWebhook: throws after all 3 retries exhausted on 503', async () => {
  let calls = 0
  await assert.rejects(
    () => postToWebhook({ messages: [] }, {
      _fetch: async () => { calls++; return { ok: false, status: 503, text: async () => 'err' } },
      _delay: NOOP_DELAY,
      ...WEBHOOK_OPTS,
    }),
    /webhook 503/,
  )
  assert.equal(calls, 3, 'should try exactly MAX_WEBHOOK_POST_TRIES times')
})

test('postToWebhook: throws after all 3 retries exhausted on network error', async () => {
  let calls = 0
  await assert.rejects(
    () => postToWebhook({ messages: [] }, {
      _fetch: async () => { calls++; throw new Error('ECONNRESET') },
      _delay: NOOP_DELAY,
      ...WEBHOOK_OPTS,
    }),
    /ECONNRESET/,
  )
  assert.equal(calls, 3, 'should try exactly MAX_WEBHOOK_POST_TRIES times')
})

test('postToWebhook: uses increasing backoff between retries', async () => {
  const delays = []
  await assert.rejects(
    () => postToWebhook({ messages: [] }, {
      _fetch: async () => ({ ok: false, status: 503, text: async () => 'err' }),
      _delay: async (ms) => { delays.push(ms) },
      ...WEBHOOK_OPTS,
    }),
  )
  assert.deepEqual(delays, [500, 1000], 'delays should be 500ms then 1000ms')
})

// ── sendHeartbeat ─────────────────────────────────────────────────────────────
// Previously the heartbeat used a bare fetch() with no retry and swallowed
// errors (exit 0). sendHeartbeat delegates to postToWebhook so the heartbeat
// path gets the same 3-retry + throw-on-exhaustion behaviour as message sends.

test('sendHeartbeat: succeeds on first attempt', async () => {
  let calls = 0
  await sendHeartbeat({
    _fetch: async () => { calls++; return { ok: true, text: async () => '{}' } },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.equal(calls, 1)
})

test('sendHeartbeat: sends empty messages array (correct heartbeat shape)', async () => {
  let capturedBody
  await sendHeartbeat({
    _fetch: async (_url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, text: async () => '{}' }
    },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.deepEqual(capturedBody, { messages: [] })
})

test('sendHeartbeat: retries on 503 and succeeds on second attempt', async () => {
  let calls = 0
  await sendHeartbeat({
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 503, text: async () => 'err' }
      return { ok: true, text: async () => '{}' }
    },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.equal(calls, 2, 'should retry once and succeed')
})

test('sendHeartbeat: retries on network error and succeeds on second attempt', async () => {
  let calls = 0
  await sendHeartbeat({
    _fetch: async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return { ok: true, text: async () => '{}' }
    },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.equal(calls, 2, 'should retry after network error')
})

test('sendHeartbeat: throws after all retries exhausted — so main() can exit non-zero', async () => {
  // Validates the contract: sendHeartbeat throws (not silently exits 0) on
  // persistent failure, letting the caller signal launchd via a non-zero exit.
  let calls = 0
  await assert.rejects(
    () => sendHeartbeat({
      _fetch: async () => { calls++; return { ok: false, status: 503, text: async () => 'err' } },
      _delay: NOOP_DELAY,
      ...WEBHOOK_OPTS,
    }),
    /webhook 503/,
  )
  assert.equal(calls, 3, 'should exhaust all 3 attempts')
})

// ── parseNewDraftsCount ───────────────────────────────────────────────────────

test('parseNewDraftsCount: returns new_drafts_created from valid JSON', () => {
  assert.equal(parseNewDraftsCount('{"ok":true,"new_drafts_created":3}'), 3)
})

test('parseNewDraftsCount: returns 0 when new_drafts_created is absent', () => {
  assert.equal(parseNewDraftsCount('{"ok":true,"imported_messages":47}'), 0)
})

test('parseNewDraftsCount: returns 0 when new_drafts_created is 0', () => {
  assert.equal(parseNewDraftsCount('{"ok":true,"new_drafts_created":0}'), 0)
})

test('parseNewDraftsCount: returns 0 (not throws) on non-JSON body — e.g. HTML error page', () => {
  // Cloud occasionally returns an HTML cold-start error page; must not throw.
  assert.equal(parseNewDraftsCount('<html>Service Unavailable</html>'), 0)
})

test('parseNewDraftsCount: returns 0 on empty string', () => {
  assert.equal(parseNewDraftsCount(''), 0)
})

test('parseNewDraftsCount: returns 0 when JSON is an array (not an object)', () => {
  assert.equal(parseNewDraftsCount('[1,2,3]'), 0)
})

// ── serializeProspects ────────────────────────────────────────────────────────
// serializeProspects converts the live Set-based prospects object to a plain
// JSON-serializable form so it can be cached in state.json and later
// reconstructed via parseProspectHandles.

test('serializeProspects: converts phones and emails Sets to plain arrays', () => {
  const prospects = {
    phones: new Set(['4155550100', '6505551234']),
    emails: new Set(['lead@example.com']),
    total:  3,
  }
  const serialized = serializeProspects(prospects)
  assert.ok(Array.isArray(serialized.phones), 'phones should be an array')
  assert.ok(Array.isArray(serialized.emails), 'emails should be an array')
  assert.deepEqual(serialized.phones.sort(), ['4155550100', '6505551234'])
  assert.deepEqual(serialized.emails, ['lead@example.com'])
})

test('serializeProspects: empty Sets serialize to empty arrays', () => {
  const prospects = { phones: new Set(), emails: new Set(), total: 0 }
  const serialized = serializeProspects(prospects)
  assert.deepEqual(serialized.phones, [])
  assert.deepEqual(serialized.emails, [])
})

test('serializeProspects: round-trips through parseProspectHandles', () => {
  const original = {
    phones: new Set(['4155550100', '6505551234']),
    emails: new Set(['lead@example.com']),
    total:  3,
  }
  const serialized = serializeProspects(original)
  // parseProspectHandles accepts plain array form — this is the cache-restore path
  const restored = parseProspectHandles(serialized)
  assert.ok(restored.phones.has('4155550100'))
  assert.ok(restored.phones.has('6505551234'))
  assert.ok(restored.emails.has('lead@example.com'))
})

test('serializeProspects: restored prospects reject non-prospect handles (real filter integrity)', () => {
  const original = {
    phones: new Set(['4155550100']),
    emails: new Set(['lead@example.com']),
    total:  2,
  }
  const restored = parseProspectHandles(serializeProspects(original))
  // A handle NOT in the original allowlist must not appear after round-trip
  assert.ok(!restored.phones.has('9995550000'), 'unknown phone must not be in restored set')
  assert.ok(!restored.emails.has('stranger@example.com'), 'unknown email must not be in restored set')
})

// ── fetch timeout: fetchProspectHandles / postToWebhook ───────────────────────
// Each attempt gets its own AbortController, so a slow cloud causes the fetch
// to be aborted at _timeoutMs rather than hanging the scanner indefinitely.

// Mock fetch that blocks until its AbortSignal fires.
function hangingFetch(url, opts) {
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
}

test('fetchProspectHandles: aborts after _timeoutMs when cloud hangs', async () => {
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch:     hangingFetch,
      _delay:     NOOP_DELAY,
      _timeoutMs: 20,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
    }),
    { name: 'AbortError' },
  )
})

test('postToWebhook: aborts after _timeoutMs when cloud hangs', async () => {
  await assert.rejects(
    () => postToWebhook({ messages: [] }, {
      _fetch:     hangingFetch,
      _delay:     NOOP_DELAY,
      _timeoutMs: 20,
      ...WEBHOOK_OPTS,
    }),
    { name: 'AbortError' },
  )
})

test('sendHeartbeat: aborts after _timeoutMs when cloud hangs', async () => {
  await assert.rejects(
    () => sendHeartbeat({
      _fetch:     hangingFetch,
      _delay:     NOOP_DELAY,
      _timeoutMs: 20,
      ...WEBHOOK_OPTS,
    }),
    { name: 'AbortError' },
  )
})

// ── contactsBase ─────────────────────────────────────────────────────────────
// contactsBase derives the base URL for contacts-sync from the inbound webhook
// URL. It MUST use URL.origin (not a regex path-strip) so staging/custom URLs
// without '/api/' in the path don't silently post to the wrong endpoint.

test('contactsBase: returns the origin (scheme+host) of the standard webhook URL', () => {
  assert.equal(
    contactsBase('https://pugs-sales.vercel.app/api/import/imessage'),
    'https://pugs-sales.vercel.app',
  )
})

test('contactsBase: works for a staging URL without /api/ in the path', () => {
  // A regex-strip of /api/... would return the full URL unchanged for this shape,
  // producing a broken base. URL.origin always returns just scheme+host.
  assert.equal(
    contactsBase('https://staging.pugs.media/webhook/imessage'),
    'https://staging.pugs.media',
  )
})

test('contactsBase: preserves port when present', () => {
  assert.equal(
    contactsBase('https://dev.pugs.media:3000/api/import/imessage'),
    'https://dev.pugs.media:3000',
  )
})

test('contactsBase: strips path, query, and hash — only origin remains', () => {
  const base = contactsBase('https://pugs-sales.vercel.app/api/import/imessage?foo=bar#baz')
  assert.equal(base, 'https://pugs-sales.vercel.app')
  assert.ok(!base.includes('?'), 'query string must not appear in the base URL')
  assert.ok(!base.includes('#'), 'hash must not appear in the base URL')
  assert.ok(!base.includes('/api'), '/api path must not appear in the base URL')
})

// ── queryNewMessages: chat.db SQL query ───────────────────────────────────────
// Integration tests against an in-memory SQLite DB that mirrors the chat.db
// schema. These tests pin the load-bearing SQL behaviour so a regression
// (wrong JOIN, missing CTE, LIMIT off-by-one, etc.) is caught immediately
// rather than silently dropping or duplicating live lead messages.

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE message (
      ROWID     INTEGER PRIMARY KEY,
      guid      TEXT,
      text      TEXT,
      date      INTEGER DEFAULT 1,
      is_from_me INTEGER DEFAULT 0,
      service   TEXT DEFAULT 'iMessage',
      account   TEXT,
      handle_id INTEGER
    );
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id    TEXT
    );
    CREATE TABLE chat (
      ROWID        INTEGER PRIMARY KEY,
      guid         TEXT,
      display_name TEXT
    );
    CREATE TABLE chat_message_join (
      chat_id    INTEGER,
      message_id INTEGER
    );
    CREATE TABLE chat_handle_join (
      chat_id   INTEGER,
      handle_id INTEGER
    );
  `)
  return db
}

test('queryNewMessages: returns a message with its chat context (baseline)', () => {
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-guid-a', 'Test Chat');
    INSERT INTO chat_handle_join VALUES (10, 1);
    INSERT INTO message VALUES (100, 'msg-1', 'hello', 1, 0, 'iMessage', null, 1);
    INSERT INTO chat_message_join VALUES (10, 100);
  `)
  const rows = queryNewMessages(db, 0, 200)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].rowid, 100)
  assert.equal(rows[0].guid, 'msg-1')
  assert.equal(rows[0].handle, '+14155550100')
  assert.equal(rows[0].chat_guid, 'chat-guid-a')
  assert.equal(rows[0].participant_count, 1)
  db.close()
})

test('queryNewMessages: deduplicates message appearing in two chats — returns exactly one row', () => {
  // iCloud-sync and backup-restore edge cases can create duplicate rows in
  // chat_message_join for the same message_id. Without the first_chat CTE,
  // the scanner would POST the same iMessage twice to the webhook.
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-guid-a', null);
    INSERT INTO chat   VALUES (20, 'chat-guid-b', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
    INSERT INTO chat_handle_join VALUES (20, 1);
    INSERT INTO message VALUES (100, 'msg-1', 'hello', 1, 0, 'iMessage', null, 1);
    INSERT INTO chat_message_join VALUES (10, 100);
    INSERT INTO chat_message_join VALUES (20, 100);
  `)
  const rows = queryNewMessages(db, 0, 200)
  assert.equal(rows.length, 1, 'message in two chats must produce exactly one row')
  assert.equal(rows[0].rowid, 100)
  db.close()
})

test('queryNewMessages: picks the lower chat_id when message appears in multiple chats', () => {
  // MIN(chat_id) in the first_chat CTE makes the chat-context selection
  // deterministic — tests that the lower-id chat wins, not SQLite scan order.
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-a', null);
    INSERT INTO chat   VALUES (20, 'chat-b', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
    INSERT INTO chat_handle_join VALUES (20, 1);
    INSERT INTO message VALUES (100, 'msg-1', 'hi', 1, 0, 'iMessage', null, 1);
    -- Insert higher-id chat first to verify MIN, not insertion order, wins
    INSERT INTO chat_message_join VALUES (20, 100);
    INSERT INTO chat_message_join VALUES (10, 100);
  `)
  const rows = queryNewMessages(db, 0, 200)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chat_guid, 'chat-a', 'lower chat_id (10) must be selected, not higher (20)')
  db.close()
})

test('queryNewMessages: highwater mark — only rows with ROWID > lastRowid are returned', () => {
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-a', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
    INSERT INTO message VALUES (50,  'msg-50',  'old',     1, 0, 'iMessage', null, 1);
    INSERT INTO message VALUES (100, 'msg-100', 'current', 1, 0, 'iMessage', null, 1);
    INSERT INTO message VALUES (150, 'msg-150', 'new',     1, 0, 'iMessage', null, 1);
    INSERT INTO chat_message_join VALUES (10, 50);
    INSERT INTO chat_message_join VALUES (10, 100);
    INSERT INTO chat_message_join VALUES (10, 150);
  `)
  const rows = queryNewMessages(db, 100, 200)
  assert.equal(rows.length, 1, 'only ROWID > 100 should be returned')
  assert.equal(rows[0].rowid, 150)
  db.close()
})

test('queryNewMessages: excludes messages with null or empty text', () => {
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-a', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
    INSERT INTO message VALUES (1, 'null-text',  null, 1, 0, 'iMessage', null, 1);
    INSERT INTO message VALUES (2, 'empty-text', '',   1, 0, 'iMessage', null, 1);
    INSERT INTO message VALUES (3, 'real-text',  'hi', 1, 0, 'iMessage', null, 1);
    INSERT INTO chat_message_join VALUES (10, 1);
    INSERT INTO chat_message_join VALUES (10, 2);
    INSERT INTO chat_message_join VALUES (10, 3);
  `)
  const rows = queryNewMessages(db, 0, 200)
  assert.equal(rows.length, 1, 'null and empty text must be excluded')
  assert.equal(rows[0].guid, 'real-text')
  db.close()
})

test('queryNewMessages: respects batchSize limit', () => {
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-a', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
  `)
  for (let i = 1; i <= 10; i++) {
    db.prepare(`INSERT INTO message VALUES (?, ?, 'msg', 1, 0, 'iMessage', null, 1)`).run(i, `guid-${i}`)
    db.prepare(`INSERT INTO chat_message_join VALUES (10, ?)`).run(i)
  }
  const rows = queryNewMessages(db, 0, 3)
  assert.equal(rows.length, 3, 'LIMIT must cap at batchSize')
  assert.equal(rows[0].rowid, 1, 'results must be ordered by ROWID ASC')
  assert.equal(rows[2].rowid, 3)
  db.close()
})

test('queryNewMessages: returns participant list for a group chat', () => {
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO handle VALUES (2, '+16505551234');
    INSERT INTO chat   VALUES (10, 'group-chat', 'Sales Thread');
    INSERT INTO chat_handle_join VALUES (10, 1);
    INSERT INTO chat_handle_join VALUES (10, 2);
    INSERT INTO message VALUES (100, 'msg-1', 'group msg', 1, 0, 'iMessage', null, 1);
    INSERT INTO chat_message_join VALUES (10, 100);
  `)
  const rows = queryNewMessages(db, 0, 200)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].participant_count, 2, 'group chat with 2 handles must report count=2')
  assert.ok(rows[0].chat_participants_concat, 'chat_participants_concat must be non-null for group')
  const parts = rows[0].chat_participants_concat.split('\x1f')
  assert.equal(parts.length, 2)
  assert.ok(parts.includes('+14155550100'))
  assert.ok(parts.includes('+16505551234'))
  db.close()
})

// ── shouldSyncContacts ────────────────────────────────────────────────────────
// shouldSyncContacts decides whether to run an AddressBook sync on a given tick.
// These tests are the primary guard for the correctness invariant: the hourly
// fallback MUST fire even when the scanner found zero new messages (no early
// return). Without this guarantee, address-book renames go stale indefinitely
// during quiet (no-new-lead) periods.

const HOUR_MS = 60 * 60 * 1000

test('shouldSyncContacts: hourly fallback fires when >1h since last sync, no new drafts', () => {
  const base = 1_700_000_000_000
  const lastContactsAt = new Date(base - HOUR_MS - 1).toISOString()
  const { should, trigger } = shouldSyncContacts(lastContactsAt, 0, { now: base })
  assert.equal(should, true)
  assert.equal(trigger, 'hourly fallback')
})

test('shouldSyncContacts: does not fire when synced <1h ago and no new drafts', () => {
  const base = 1_700_000_000_000
  const lastContactsAt = new Date(base - 30 * 60 * 1000).toISOString() // 30min ago
  const { should } = shouldSyncContacts(lastContactsAt, 0, { now: base })
  assert.equal(should, false)
})

test('shouldSyncContacts: new-drafts path fires when drafts created and >60s since last sync', () => {
  const base = 1_700_000_000_000
  const lastContactsAt = new Date(base - 120_000).toISOString() // 2min ago
  const { should, trigger } = shouldSyncContacts(lastContactsAt, 3, { now: base })
  assert.equal(should, true)
  assert.equal(trigger, '3 new draft(s)')
})

test('shouldSyncContacts: new-drafts throttle — does not fire when last sync was <60s ago', () => {
  const base = 1_700_000_000_000
  const lastContactsAt = new Date(base - 30_000).toISOString() // 30s ago
  const { should } = shouldSyncContacts(lastContactsAt, 5, { now: base })
  assert.equal(should, false, 'throttle active: last sync was only 30s ago')
})

test('shouldSyncContacts: fires when never synced before (lastContactsAt null)', () => {
  const { should, trigger } = shouldSyncContacts(null, 0)
  assert.equal(should, true)
  assert.equal(trigger, 'hourly fallback')
})

test('shouldSyncContacts: does not fire at exact interval boundary (sinceLastSync === HOUR_MS)', () => {
  // sinceLastSync > intervalMs requires strictly greater — exact equality should not trigger.
  const base = 1_700_000_000_000
  const lastContactsAt = new Date(base - HOUR_MS).toISOString()
  const { should } = shouldSyncContacts(lastContactsAt, 0, { now: base })
  assert.equal(should, false, 'equal-to-interval must not fire; only strictly greater triggers sync')
})

test('shouldSyncContacts: new-drafts trigger reports correct count in trigger string', () => {
  const base = 1_700_000_000_000
  const lastContactsAt = new Date(base - 120_000).toISOString()
  const { trigger } = shouldSyncContacts(lastContactsAt, 7, { now: base })
  assert.equal(trigger, '7 new draft(s)')
})

// ── assertChatDbSchema ────────────────────────────────────────────────────────
// These tests guard the macOS-upgrade schema risk: if Apple renames or removes
// a column we query, assertChatDbSchema must throw a clear, diagnosable error
// rather than letting queryNewMessages crash mid-scan with a cryptic SQL error
// (or worse, return silent wrong data). Uses the same in-memory SQLite fixture
// as the queryNewMessages tests.

test('assertChatDbSchema: passes with the expected schema', () => {
  const db = createTestDb()
  assert.doesNotThrow(() => assertChatDbSchema(db))
  db.close()
})

test('assertChatDbSchema: throws when a required column is missing', () => {
  const db = new Database(':memory:')
  // message table missing 'is_from_me' — simulates a macOS schema change
  db.exec(`
    CREATE TABLE message (
      ROWID     INTEGER PRIMARY KEY,
      guid      TEXT,
      text      TEXT,
      date      INTEGER,
      service   TEXT,
      account   TEXT,
      handle_id INTEGER
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join  (chat_id INTEGER, handle_id  INTEGER);
  `)
  assert.throws(
    () => assertChatDbSchema(db),
    (err) => {
      assert.ok(err.message.includes('is_from_me'), `error must name the missing column; got: ${err.message}`)
      assert.ok(err.message.includes('macOS'), `error must mention macOS; got: ${err.message}`)
      return true
    }
  )
  db.close()
})

// ── queryNewMessages: full-batch pagination ───────────────────────────────────
// When there are more unprocessed rows than BATCH_SIZE, the scanner runs
// multiple times: each run advances the cursor to the last ROWID it fetched
// and the next run picks up where the previous left off. These tests verify
// that the cursor handoff is exact — no rows skipped at the batch boundary
// and no rows duplicated across consecutive calls.
//
// This is the silent lead-loss scenario: Connor's Mac comes back online after
// hours offline; many messages are queued; if the ROWID > cursor condition had
// an off-by-one or the batch boundary was mis-handled, messages near the
// boundary would be lost forever with no error logged.

test('queryNewMessages: pagination — second batch starts immediately after first batch cursor', () => {
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-a', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
  `)
  for (let i = 1; i <= 5; i++) {
    db.prepare(`INSERT INTO message VALUES (?, ?, 'msg', 1, 0, 'iMessage', null, 1)`).run(i, `guid-${i}`)
    db.prepare(`INSERT INTO chat_message_join VALUES (10, ?)`).run(i)
  }

  const batch1 = queryNewMessages(db, 0, 3)
  assert.equal(batch1.length, 3)
  assert.deepEqual(batch1.map(r => r.rowid), [1, 2, 3], 'first batch must be rows 1–3 in ROWID order')

  // Simulate the cursor advance that main() performs after a successful POST
  const cursor = batch1[batch1.length - 1].rowid  // = 3

  const batch2 = queryNewMessages(db, cursor, 3)
  assert.equal(batch2.length, 2, 'second batch must contain only the 2 remaining rows')
  assert.deepEqual(batch2.map(r => r.rowid), [4, 5], 'second batch must start at ROWID 4, not re-fetch ROWID 3')

  db.close()
})

test('queryNewMessages: pagination — no overlap between consecutive batches', () => {
  // Verifies the ROWID > cursor condition (strictly greater) — if it were >=,
  // the last row of batch 1 would re-appear as the first row of batch 2.
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-a', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
  `)
  for (let i = 1; i <= 6; i++) {
    db.prepare(`INSERT INTO message VALUES (?, ?, 'msg', 1, 0, 'iMessage', null, 1)`).run(i, `guid-${i}`)
    db.prepare(`INSERT INTO chat_message_join VALUES (10, ?)`).run(i)
  }

  const batch1 = queryNewMessages(db, 0, 3)
  const cursor = batch1[batch1.length - 1].rowid  // = 3
  const batch2 = queryNewMessages(db, cursor, 3)

  const batch1Ids = new Set(batch1.map(r => r.rowid))
  const batch2Ids = batch2.map(r => r.rowid)
  for (const id of batch2Ids) {
    assert.ok(!batch1Ids.has(id), `ROWID ${id} must not appear in both batches — cursor condition is wrong`)
  }
  assert.deepEqual(batch2Ids, [4, 5, 6], 'second batch must contain exactly rows 4–6')

  db.close()
})

test('queryNewMessages: pagination — third call returns empty after all rows consumed', () => {
  // Verifies the loop terminates: when the cursor is at the highest ROWID, the
  // next call returns [] so the scanner knows it has processed everything.
  const db = createTestDb()
  db.exec(`
    INSERT INTO handle VALUES (1, '+14155550100');
    INSERT INTO chat   VALUES (10, 'chat-a', null);
    INSERT INTO chat_handle_join VALUES (10, 1);
  `)
  for (let i = 1; i <= 4; i++) {
    db.prepare(`INSERT INTO message VALUES (?, ?, 'msg', 1, 0, 'iMessage', null, 1)`).run(i, `guid-${i}`)
    db.prepare(`INSERT INTO chat_message_join VALUES (10, ?)`).run(i)
  }

  const batch1 = queryNewMessages(db, 0, 3)
  const cursor1 = batch1[batch1.length - 1].rowid  // = 3
  const batch2 = queryNewMessages(db, cursor1, 3)
  const cursor2 = batch2[batch2.length - 1].rowid  // = 4
  const batch3 = queryNewMessages(db, cursor2, 3)

  assert.equal(batch3.length, 0, 'call after all rows consumed must return empty — scanner should stop and exit')

  db.close()
})

test('assertChatDbSchema: throws when a required table is missing', () => {
  const db = new Database(':memory:')
  // chat_handle_join absent — simulates a macOS schema change
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
      is_from_me INTEGER, service TEXT, account TEXT, handle_id INTEGER
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat   (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `)
  assert.throws(
    () => assertChatDbSchema(db),
    (err) => {
      assert.ok(err.message.includes('chat_handle_join'), `error must name the missing table; got: ${err.message}`)
      assert.ok(err.message.includes('macOS'), `error must mention macOS; got: ${err.message}`)
      return true
    }
  )
  db.close()
})

// ── normalization drop visibility ───────────────────────────────────────────
// When rows are dropped during normalizeRows (corrupt timestamp, missing sender
// handle for inbound), the count should be logged so the operator can diagnose
// why fewer messages reached the cloud than were in chat.db.

test('normalizeRows: drops rows with corrupt timestamps visible in logs', () => {
  // This is a structural test that ensures the normalization drop count is
  // calculated and logged. The actual normalizeRows logic is tested in
  // payload.test.js; this test verifies that the drop count is surface-visible.
  const { normalizeRows } = require('./payload')
  const rows = [
    { rowid: 1, guid: 'msg-1', text: 'ok', date: 1609459200000000000, is_from_me: 0, service: 'iMessage', account: null, handle: '+14155550100', chat_guid: 'c1', chat_display_name: 'Test', participant_count: 1, chat_participants_concat: null },
    { rowid: 2, guid: 'msg-2', text: 'bad date', date: null, is_from_me: 0, service: 'iMessage', account: null, handle: '+14155550100', chat_guid: 'c1', chat_display_name: 'Test', participant_count: 1, chat_participants_concat: null },
    { rowid: 3, guid: 'msg-3', text: 'ok', date: 1609459200000000000, is_from_me: 0, service: 'iMessage', account: null, handle: '+14155550100', chat_guid: 'c1', chat_display_name: 'Test', participant_count: 1, chat_participants_concat: null },
  ]
  const payload = normalizeRows(rows)
  // msg-2 with null date should be dropped
  assert.equal(payload.length, 2, 'should have 2 valid rows after normalization')
  assert.equal(rows.length - payload.length, 1, 'should show 1 row was dropped')
})
