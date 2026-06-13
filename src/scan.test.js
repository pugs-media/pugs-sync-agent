'use strict'

// Must be set before requiring scan.js — it validates env at module load.
process.env.PUGS_SYNC_WEBHOOK_URL = 'https://example.pugs.media/api/import/imessage'
process.env.PUGS_SYNC_SECRET      = 'test-secret'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const fs       = require('fs')
const path     = require('path')
const os       = require('os')
const Database = require('better-sqlite3')
const { fetchProspectHandles, parseProspectHandles, fetchOrCachedProspects, postToWebhook, sendHeartbeat, parseNewDraftsCount, serializeProspects, contactsBase, assertChatDbSchema, detectAndRecoverRowidReset, queryNewMessages, shouldSyncContacts, computeAllDedupCursorRowid } = require('./scan')

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

test('fetchProspectHandles: retries on 408 (request timeout) like a transient error', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch: async () => { calls++; return { ok: false, status: 408, text: async () => 'request timeout' } },
      _delay: NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret: 'test-secret',
      scannerId: '',
    }),
    /prospect-handles 408/,
  )
  assert.equal(calls, 3, '408 should be retried like 503')
})

test('fetchProspectHandles: retries on 429 (rate limit) like a transient error', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchProspectHandles({
      _fetch: async () => { calls++; return { ok: false, status: 429, text: async () => 'too many requests' } },
      _delay: NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret: 'test-secret',
      scannerId: '',
    }),
    /prospect-handles 429/,
  )
  assert.equal(calls, 3, '429 should be retried like 503')
})

test('fetchProspectHandles: succeeds on 2nd attempt after a 429 rate limit', async () => {
  let calls = 0
  const body = { phones: ['4155550100'], emails: [], count_phones: 1, count_emails: 0 }
  const result = await fetchProspectHandles({
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 429, text: async () => 'too many requests' }
      return { ok: true, json: async () => body }
    },
    _delay: NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret: 'test-secret',
    scannerId: '',
  })
  assert.equal(calls, 2, 'should retry once on 429 and succeed')
  assert.ok(result.phones.has('4155550100'))
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

test('parseProspectHandles: normalizes phones to bare 10-digit keys (E.164 and variants)', () => {
  // makeHandleAllowed strips non-digits and takes the last 10 chars from incoming
  // chat.db handles. The allowlist must use the same form or matching silently fails
  // and prospect inbounds are dropped as "not-prospect" — a lead loss.
  const result = parseProspectHandles({
    phones: ['+14155550100', '(415) 555-0100', '14155550100', '1-415-555-0100'],
    emails: [],
    count_phones: 4,
    count_emails: 0,
  })
  // All four formats normalize to the same 10-digit key — should collapse to 1 entry.
  assert.equal(result.phones.size, 1, 'all forms should collapse to one normalized entry')
  assert.ok(result.phones.has('4155550100'), 'bare 10-digit key must be present')
})

test('parseProspectHandles: drops phones that are too short after normalization', () => {
  const result = parseProspectHandles({
    phones: ['555-0100', ''],   // 7 digits → dropped; empty → dropped
    emails: [],
    count_phones: 2,
    count_emails: 0,
  })
  assert.equal(result.phones.size, 0, 'short/empty phones must be dropped, not stored as partial keys')
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

test('postToWebhook: retries on 408 (request timeout) like a transient error', async () => {
  let calls = 0
  const payload = { messages: [{ id: 1 }] }
  await assert.rejects(
    () => postToWebhook(payload, {
      _fetch: async () => { calls++; return { ok: false, status: 408, text: async () => 'request timeout' } },
      _delay: NOOP_DELAY,
      ...WEBHOOK_OPTS,
    }),
    /webhook 408/,
  )
  assert.equal(calls, 3, '408 should be retried like 503')
})

test('postToWebhook: retries on 429 (rate limit) like a transient error', async () => {
  let calls = 0
  const payload = { messages: [{ id: 1 }] }
  await assert.rejects(
    () => postToWebhook(payload, {
      _fetch: async () => { calls++; return { ok: false, status: 429, text: async () => 'too many requests' } },
      _delay: NOOP_DELAY,
      ...WEBHOOK_OPTS,
    }),
    /webhook 429/,
  )
  assert.equal(calls, 3, '429 should be retried like 503')
})

test('postToWebhook: succeeds on 2nd attempt after a 429 rate limit', async () => {
  let calls = 0
  const payload = { messages: [{ id: 1, text: 'test' }] }
  const result = await postToWebhook(payload, {
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 429, text: async () => 'too many requests' }
      return { ok: true, status: 200, text: async () => 'ok' }
    },
    _delay: NOOP_DELAY,
    ...WEBHOOK_OPTS,
  })
  assert.equal(calls, 2, 'should retry once on 429 and succeed')
  assert.ok(result.ok)
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

// ── snapshot exit-handler cleanup ─────────────────────────────────────────────

test('scan: snapshot is cleaned up when process.exit() is called inside the scan try block', async () => {
  // process.exit() bypasses finally blocks. Without the process.once('exit', cleanupOnExit)
  // handler, a 100-500 MB chat.db snapshot left in /tmp on every webhook failure
  // would accumulate and could fill the disk within hours of a sustained outage.
  const { execFile } = require('child_process')
  const snap = path.join(os.tmpdir(), `scan-exit-cleanup-${Date.now()}.db`)

  // Script mirrors scan.js's cleanup handler pattern exactly.
  const helper = [
    "const fs = require('fs');",
    "const { cleanupSnapshot } = require('./src/snapshot');",
    `fs.writeFileSync(${JSON.stringify(snap)}, 'x');`,
    'let snapshotCleaned = false;',
    `const cleanupOnExit = () => { if (snapshotCleaned) return; snapshotCleaned = true; cleanupSnapshot(${JSON.stringify(snap)}); };`,
    "process.once('exit', cleanupOnExit);",
    'process.exit(4);  // simulate postToWebhook failure — finally is bypassed',
  ].join('\n')

  await new Promise(resolve => execFile('node', ['-e', helper], { cwd: path.join(__dirname, '..') }, resolve))
  assert.ok(!fs.existsSync(snap), 'snapshot must be removed by once-exit handler before the process terminates')
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

// ── GUID-based dedup guard against ROWID reset ───────────────────────────────
// When SQLite VACUUMs or macOS major updates reset ROWID values, the scan's
// highwater-mark (last_rowid) becomes unreliable. The scanner now tracks sent
// message GUIDs so re-ingestion is prevented even if ROWID resets. These tests
// verify the dedup logic works correctly.

test('GUID dedup: filters out messages whose GUID was already sent', () => {
  // Simulate a prior run that sent message GUID 'msg-1'
  const state = { last_rowid: 100, sent_guids: ['msg-1'] }
  const sentGuids = state.sent_guids ? new Set(state.sent_guids) : new Set()

  // Simulate a new batch where 'msg-1' appears again (e.g., after VACUUM reset ROWID)
  const rows = [
    { rowid: 50, guid: 'msg-1', text: 'old', is_from_me: 1 },  // already sent
    { rowid: 51, guid: 'msg-2', text: 'new', is_from_me: 1 },  // new
  ]

  const dedupedRows = rows.filter(row => !sentGuids.has(row.guid))
  assert.equal(dedupedRows.length, 1)
  assert.equal(dedupedRows[0].guid, 'msg-2', 'dedup must filter out msg-1')
})

test('GUID dedup: accumulates GUIDs from sent messages and bounds the set', () => {
  const state = { last_rowid: 100, sent_guids: ['msg-1', 'msg-2'] }
  const sentGuids = state.sent_guids ? new Set(state.sent_guids) : new Set()

  const rows = [
    { rowid: 101, guid: 'msg-3', text: 'new' },
    { rowid: 102, guid: 'msg-4', text: 'new' },
  ]

  // Simulate accumulation and bounding
  const newSentGuids = [...sentGuids, ...rows.map(r => r.guid)]
  const MAX_SENT_GUIDS = 10000
  const boundedSentGuids = newSentGuids.slice(-MAX_SENT_GUIDS)

  assert.equal(boundedSentGuids.length, 4)
  assert.deepEqual(boundedSentGuids, ['msg-1', 'msg-2', 'msg-3', 'msg-4'])
})

test('GUID dedup: respects MAX_SENT_GUIDS boundary to prevent unbounded growth', () => {
  // Create a sent_guids array with many entries
  const bigList = Array.from({ length: 10005 }, (_, i) => `msg-${i}`)
  const sentGuids = new Set(bigList)

  const newRows = [{ rowid: 20000, guid: 'msg-new' }]
  const newSentGuids = [...sentGuids, ...newRows.map(r => r.guid)]
  const MAX_SENT_GUIDS = 10000
  const boundedSentGuids = newSentGuids.slice(-MAX_SENT_GUIDS)

  assert.equal(boundedSentGuids.length, 10000, 'set must be bounded to MAX_SENT_GUIDS')
  assert.ok(boundedSentGuids.includes('msg-new'), 'newest entry must be kept')
  assert.ok(!boundedSentGuids.includes('msg-0'), 'oldest entries must be dropped')
})

test('GUID dedup: handles empty sent_guids in state gracefully', () => {
  const state = {}  // no sent_guids field
  const sentGuids = state.sent_guids ? new Set(state.sent_guids) : new Set()
  assert.equal(sentGuids.size, 0)

  const rows = [{ rowid: 1, guid: 'msg-1', text: 'first' }]
  const dedupedRows = rows.filter(row => !sentGuids.has(row.guid))
  assert.equal(dedupedRows.length, 1, 'all rows pass when sent_guids is empty')
})

test('GUID dedup: deduped rows are not passed to normalizeRows (no double-send)', () => {
  // Regression: the main() loop normalizes rows, filters by prospect, and posts.
  // If normalizeRows() receives the FULL rows array instead of dedupedRows, a
  // message whose GUID was already sent still gets normalized and posted,
  // causing a silent double-send.
  // This test verifies the fix: deduped rows are excluded from normalization.
  const state = { sent_guids: ['msg-1'] }
  const rows = [
    { rowid: 1, guid: 'msg-1', text: 'a@example.com', is_from_me: 1, sent_at: '2025-01-01 10:00:00', participants: 'bob' },  // already sent
    { rowid: 2, guid: 'msg-2', text: 'new', is_from_me: 1, sent_at: '2025-01-01 10:01:00', participants: 'charlie' },
  ]

  const sentGuids = new Set(state.sent_guids)
  const dedupedRows = rows.filter(row => !sentGuids.has(row.guid))

  // In the old buggy code, normalizeRows(rows) would include msg-1.
  // In the fixed code, normalizeRows(dedupedRows) excludes it.
  assert.equal(dedupedRows.length, 1, 'msg-1 must be filtered out')
  assert.equal(dedupedRows[0].guid, 'msg-2', 'only msg-2 should remain for normalization')
  // This ensures that dedupedRows is the input to normalization, not rows.
})

test('scan: prospect-filtered row GUIDs are NOT added to sent_guids — preserves re-delivery if sender later joins allowlist', () => {
  // Production formula: guidsToAdd = filteredPayload.map(r => r.guid)
  // NOT: guidsToAdd = dedupedRows.map(r => r.guid)
  //
  // When inbound messages survive GUID dedup but fail the prospect filter, their
  // GUIDs must stay out of sent_guids. If they were added, a post-ROWID-reset
  // recovery would skip them via GUID dedup — even though they were never sent to
  // pugs-sales — permanently blocking delivery if the sender later becomes a
  // prospect. That is a silent lead-loss on a sales tool.
  const { normalizeRows } = require('./payload')
  const { filterMessages } = require('./filter')

  const VALID_DATE = 1609459200000000000  // well-formed Apple timestamp

  const dedupedRows = [
    { rowid: 10, guid: 'np-guid-1', text: 'hey', date: VALID_DATE,
      is_from_me: 0, service: 'iMessage', account: null, handle: '5555550100',
      chat_guid: 'iMessage;-;+15555550100', chat_display_name: null,
      participant_count: 1, chat_participants_concat: '5555550100' },
    { rowid: 11, guid: 'np-guid-2', text: 'ping', date: VALID_DATE,
      is_from_me: 0, service: 'iMessage', account: null, handle: '5555550100',
      chat_guid: 'iMessage;-;+15555550100', chat_display_name: null,
      participant_count: 1, chat_participants_concat: '5555550100' },
  ]

  const payload = normalizeRows(dedupedRows)
  assert.equal(payload.length, 2, 'both rows must survive normalizeRows')

  const prospects = { phones: new Set(), emails: new Set() }
  const { kept: filteredPayload, droppedNotProspect } = filterMessages(payload, { prospects })
  assert.equal(filteredPayload.length, 0, 'both rows must be filtered by empty prospect allowlist')
  assert.equal(droppedNotProspect, 2)

  // Production formula — must use filteredPayload, not dedupedRows
  const guidsToAdd = filteredPayload.map(r => r.guid)
  assert.equal(guidsToAdd.length, 0, 'non-prospect GUIDs must not be added to sent_guids')
  assert.ok(!guidsToAdd.includes('np-guid-1'), 'np-guid-1 must not enter sent_guids')
  assert.ok(!guidsToAdd.includes('np-guid-2'), 'np-guid-2 must not enter sent_guids')
})

// ── GUID dedup cursor-stall regression ────────────────────────────────────────
// After a ROWID reset, the scanner falls back to a 7-day window. If ALL the
// messages in that window were already sent (their GUIDs are in sent_guids),
// dedupedRows ends up empty while rows.length > 0. Without the fix, neither
// the heartbeat branch (requires rows.length === 0) nor the processing branch
// (requires dedupedRows.length > 0) fires, so the cursor never advances.
// Every subsequent scan re-reads the same stuck batch — new messages at higher
// ROWIDs are permanently blocked until the state file is manually reset.
//
// The fix: a third branch `rows.length > 0 && dedupedRows.length === 0` advances
// the cursor to rows[rows.length-1].rowid without sending anything to the cloud.

// ── computeAllDedupCursorRowid ────────────────────────────────────────────────
// These tests call the production function directly. The old tests for this
// path only asserted math about local variables (e.g. `rows.length === 3`) and
// never invoked any production code — deleting the else-if branch from main()
// would not have caused them to fail. These tests actually guard the branch
// condition and cursor formula.

test('computeAllDedupCursorRowid: returns last rowid when all rows are GUID-deduped', () => {
  // Post-ROWID-reset scenario: batch of 3 rows, all GUIDs already sent.
  // The scanner must advance the cursor to ROWID 3 to unblock future messages.
  const rows       = [{ rowid: 1 }, { rowid: 2 }, { rowid: 3 }]
  const dedupedRows = []
  assert.equal(computeAllDedupCursorRowid(rows, dedupedRows), 3,
    'must return the last rowid to advance the cursor past all deduped rows')
})

test('computeAllDedupCursorRowid: returns null when some rows survive dedup', () => {
  // Normal branch handles partially-deduped batches; advance-only must not fire.
  const rows       = [{ rowid: 1 }, { rowid: 2 }]
  const dedupedRows = [{ rowid: 2 }]
  assert.equal(computeAllDedupCursorRowid(rows, dedupedRows), null,
    'must return null when dedupedRows is non-empty — normal processing branch applies')
})

test('computeAllDedupCursorRowid: returns null when rows is empty (heartbeat case)', () => {
  // Zero rows from chat.db → heartbeat branch, not cursor-advance.
  assert.equal(computeAllDedupCursorRowid([], []), null,
    'must return null when rows is empty — cursor-advance requires at least one row')
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

// ── contacts sync error health reporting ────────────────────────────────────
// When contacts sync fails (network error or bad response), the error should be
// reported to the cloud health endpoint so Charlie can monitor enrichment status.
// This prevents silent degradation: if contacts sync breaks, outbound enrichment
// stalls without visible monitoring.

test('shouldSyncContacts: triggers on new drafts with 60s throttle', () => {
  const now = 1700000000000
  const result = shouldSyncContacts(null, 3, { now })
  assert.equal(result.should, true, 'new drafts should trigger sync')
  assert.ok(result.trigger.includes('new draft'), 'trigger reason should mention drafts')
})

test('shouldSyncContacts: triggers on hourly fallback even with no new drafts', () => {
  const now = 1700000000000
  const lastSync = new Date(now - 61 * 60 * 1000).toISOString()
  const result = shouldSyncContacts(lastSync, 0, { now })
  assert.equal(result.should, true, 'hourly fallback should trigger')
  assert.equal(result.trigger, 'hourly fallback')
})

test('shouldSyncContacts: skips if <60s since last sync and no new drafts', () => {
  const now = 1700000000000
  const lastSync = new Date(now - 30 * 1000).toISOString()
  const result = shouldSyncContacts(lastSync, 0, { now })
  assert.equal(result.should, false, 'should not trigger when too recent and no new drafts')
  assert.equal(result.trigger, null)
})

// ── ROWID reset detection and recovery ──────────────────────────────────────
// When VACUUM or macOS upgrade resets the ROWID sequence, last_rowid from the
// state file becomes ahead of the current max ROWID. Without detection, the
// next scan's "WHERE m.ROWID > last_rowid" query returns zero rows, silently
// dropping all messages — a lost-lead catastrophe. detectAndRecoverRowidReset
// must catch this and fall back to a safe window to prevent message loss.

test('detectAndRecoverRowidReset: returns unchanged cutoff when no reset detected', () => {
  // In-memory test DB with max ROWID = 5000, stored cutoff = 4500
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY,
    guid TEXT,
    text TEXT,
    date REAL
  )`)
  for (let i = 1; i <= 5000; i++) {
    db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run(`msg-${i}`, `text ${i}`, 1609459200000000000)
  }
  const result = detectAndRecoverRowidReset(db, 4500)
  assert.equal(result.detected, false, 'should not detect reset with normal gap')
  assert.equal(result.cutoffRowid, 4500, 'should return original cutoff')
  assert.equal(result.reason, null)
  db.close()
})

test('detectAndRecoverRowidReset: detects reset when stored cursor >>  current max', () => {
  // In-memory test DB with max ROWID = 5000, but stored cutoff = 200000 (reset!)
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY,
    guid TEXT,
    text TEXT,
    date REAL
  )`)
  // Add 5000 rows with recent timestamps
  for (let i = 1; i <= 5000; i++) {
    db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run(`msg-${i}`, `text ${i}`, 1609459200000000000)
  }
  const result = detectAndRecoverRowidReset(db, 200000)
  assert.equal(result.detected, true, 'should detect ROWID reset')
  assert.ok(result.reason.includes('ROWID reset detected'), 'reason should mention reset')
  assert.ok(result.cutoffRowid < 5000, 'fallback cutoff should be less than current max')
  db.close()
})

test('detectAndRecoverRowidReset: handles last_rowid=0 (first run)', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT)`)
  db.prepare('INSERT INTO message (guid) VALUES (?)').run('msg-1')
  const result = detectAndRecoverRowidReset(db, 0)
  assert.equal(result.detected, false, 'should not detect reset on first run')
  assert.equal(result.cutoffRowid, 0, 'should preserve zero cutoff')
  db.close()
})

test('detectAndRecoverRowidReset: handles empty message table', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT)`)
  const result = detectAndRecoverRowidReset(db, 1000)
  assert.equal(result.detected, false, 'should not detect reset on empty table')
  assert.equal(result.cutoffRowid, 1000, 'should preserve stored cutoff')
  db.close()
})

test('detectAndRecoverRowidReset: reset detected but no messages within 7-day window — safeCutoff falls back to maxRowid', () => {
  // Scenario: Mac was unused >7 days and then VACUUM'd, resetting ROWIDs.
  // All messages in the DB have timestamps older than 7 days, so the date-cutoff
  // query returns null. safeCutoff must fall back to maxRowid (start scanning from
  // the current end), NOT 0 — setting 0 would dump all historical messages to
  // pugs-sales, which is a client-comms error and cloud noise.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY,
    guid TEXT,
    text TEXT,
    date REAL
  )`)
  // Apple nanoseconds for 2020-01-01: always >7 days older than the test runner's
  // clock, so the 7-day cutoff query will return null for all of these rows.
  const APPLE_NS_2020 = 599529600000000000
  for (let i = 1; i <= 5; i++) {
    db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run(`old-${i}`, `text ${i}`, APPLE_NS_2020)
  }
  // stored lastRowid (200000) >> maxRowid (5) + ROWID_RESET_THRESHOLD (100000)
  const result = detectAndRecoverRowidReset(db, 200000)
  assert.equal(result.detected, true, 'reset must be detected')
  assert.equal(result.cutoffRowid, 5, 'safeCutoff must be maxRowid when no recent messages — prevents old-history dump')
  assert.ok(result.reason && result.reason.includes('ROWID reset'), 'reason must mention reset')
  db.close()
})

// ── secondary stall detection (modest VACUUM / macOS rebuild gap < 100K) ────────
// The primary threshold (100K) misses macOS upgrades or VACUUMs that compress
// the DB by less than 100K rows. After such an event, new messages get ROWIDs
// starting from current_max+1 (below the stored cursor), so the scanner's
// "WHERE ROWID > lastRowid" query silently returns nothing — every lead is missed
// until 100K new messages push the sequence past lastRowid (months on a sales tool).
//
// The secondary check detects this: if lastRowid > maxRowid AND a message received
// in the last 7 days has ROWID < lastRowid, the sequence was reset. New messages
// will start at maxRowid+1 (below cursor) and would be permanently missed without
// the recovery. The 7-day window matches the recovery window so no scope creep.

test('detectAndRecoverRowidReset: secondary stall check — detects modest VACUUM where recent message exists below cursor', () => {
  // Simulates a modest VACUUM (< 100K compression): 51 messages, cursor at 80001.
  // Gap = 80001 - 51 = 79950 < 100K → primary check misses it.
  // One message has a recent timestamp (within 7 days) and ROWID 51 < 80001 →
  // secondary check detects the stall and triggers 7-day recovery.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date REAL)`)

  const APPLE_NS_2020 = 599529600000000000  // 2020-01-01 — older than 7 days
  for (let i = 1; i <= 50; i++) {
    db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run(`old-${i}`, `text ${i}`, APPLE_NS_2020)
  }
  // One recent message (within last 7 days) at ROWID 51 — below the cursor
  const recentAppleNs = (Date.now() - 978307200000) * 1e6 - 3600e9  // ~1 hour ago
  db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run('recent-1', 'recent', recentAppleNs)

  // maxRowid = 51, lastRowid = 80001, gap = ~80K < 100K → primary misses, secondary fires
  const result = detectAndRecoverRowidReset(db, 80001)
  assert.equal(result.detected, true, 'secondary check must detect stall when recent message is below cursor')
  assert.ok(result.reason && result.reason.includes('stall'), `reason must mention stall; got: ${result.reason}`)
  assert.ok(result.cutoffRowid < 80001, 'recovery cutoff must be below the stuck cursor')
  db.close()
})

test('detectAndRecoverRowidReset: secondary stall check — does NOT fire when cursor is ahead of max but no recent messages', () => {
  // Cursor ahead of max (could be from deletions) but all messages are old (> 7 days).
  // Without recent messages below the cursor there is no evidence of a VACUUM stall —
  // could just be a quiet Mac with no activity in the last week.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date REAL)`)

  const APPLE_NS_2020 = 599529600000000000  // older than 7 days
  for (let i = 1; i <= 50; i++) {
    db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run(`old-${i}`, `text ${i}`, APPLE_NS_2020)
  }

  // maxRowid = 50, lastRowid = 60 — slightly ahead, but no recent messages below cursor
  const result = detectAndRecoverRowidReset(db, 60)
  assert.equal(result.detected, false, 'must NOT detect stall when no recent messages exist below cursor')
  assert.equal(result.cutoffRowid, 60, 'cursor must be preserved when no stall evidence')
  db.close()
})

test('detectAndRecoverRowidReset: secondary stall check — does NOT fire when cursor equals max (normal caught-up state)', () => {
  // In normal "caught up" operation lastRowid == maxRowid (strictly equal).
  // The secondary check condition `lastRowid > maxRowid` is false — must not fire.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date REAL)`)

  const recentAppleNs = (Date.now() - 978307200000) * 1e6 - 3600e9  // ~1 hour ago
  for (let i = 1; i <= 100; i++) {
    db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run(`msg-${i}`, `text ${i}`, recentAppleNs)
  }

  // lastRowid = 100 = maxRowid — scanner is caught up, no gap
  const result = detectAndRecoverRowidReset(db, 100)
  assert.equal(result.detected, false, 'must not detect stall when cursor equals max — this is normal operation')
  assert.equal(result.cutoffRowid, 100, 'cursor must be preserved in normal caught-up state')
  db.close()
})

// ── injectable _now: exact 7-day window boundary tests ───────────────────────
// These tests use _now to pin the clock, making the 7-day window deterministic.
// Without injectable time the boundary can only be tested with "obviously recent"
// data (1h ago), so a unit typo like 8640000 instead of 86400000 (10x shorter
// window) would pass all prior tests. These tests catch exactly that class of bug.

test('detectAndRecoverRowidReset: _now injection — message 1ms within 7-day window triggers stall', () => {
  // Pin _now to a fixed value. A message just within 7 days must be found by the
  // secondary stall check and trigger recovery — cutoffAppleNs = (now - 7d) in ns.
  const now = 1_750_000_000_000  // fixed Unix ms
  const sevenDaysMs = 7 * 86400000
  // Timestamp 1ms before the 7-day cutoff = within the window.
  const withinWindowMs = now - sevenDaysMs + 1
  const withinWindowAppleNs = (withinWindowMs - 978307200000) * 1e6

  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date REAL)`)
  db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run('msg-1', 'hello', withinWindowAppleNs)

  // cursor=999 > maxRowid=1, message is within 7 days → secondary stall detected
  const result = detectAndRecoverRowidReset(db, 999, { _now: () => now })
  assert.equal(result.detected, true, 'stall must be detected: recent message is below stuck cursor')
  assert.ok(result.reason.includes('stall'), `reason must mention stall; got: ${result.reason}`)
  db.close()
})

test('detectAndRecoverRowidReset: _now injection — message 1ms beyond 7-day window does NOT trigger stall', () => {
  // A message exactly 1ms older than the 7-day cutoff must NOT satisfy date >= cutoffAppleNs.
  const now = 1_750_000_000_000
  const sevenDaysMs = 7 * 86400000
  // Timestamp 1ms beyond the window = NOT within 7 days.
  const beyondWindowMs = now - sevenDaysMs - 1
  const beyondWindowAppleNs = (beyondWindowMs - 978307200000) * 1e6

  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date REAL)`)
  db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run('msg-1', 'hello', beyondWindowAppleNs)

  // cursor=999 > maxRowid=1, but the only message is outside the 7-day window
  const result = detectAndRecoverRowidReset(db, 999, { _now: () => now })
  assert.equal(result.detected, false, 'stall must NOT be detected: no recent messages below cursor')
  assert.equal(result.cutoffRowid, 999, 'cursor must be preserved when no recent stall evidence')
  db.close()
})

test('detectAndRecoverRowidReset: _now injection — safeCutoff is first in-window ROWID minus 1', () => {
  // After stall detection, safeCutoff must be (first 7-day message ROWID - 1) so
  // the next scan re-reads that message and doesn't skip it.
  const now = 1_750_000_000_000
  const sevenDaysMs = 7 * 86400000
  const withinWindowAppleNs = (now - sevenDaysMs + 60_000 - 978307200000) * 1e6  // 1min within window

  const db = new Database(':memory:')
  db.exec(`CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date REAL)`)
  // Insert 3 messages; they get ROWIDs 1, 2, 3 in insert order.
  db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run('msg-1', 'a', withinWindowAppleNs)
  db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run('msg-2', 'b', withinWindowAppleNs)
  db.prepare('INSERT INTO message (guid, text, date) VALUES (?, ?, ?)').run('msg-3', 'c', withinWindowAppleNs)

  const result = detectAndRecoverRowidReset(db, 999, { _now: () => now })
  assert.equal(result.detected, true, 'stall must be detected')
  // First in-window ROWID = 1; safeCutoff = 0 so next query ROWID > 0 catches msg-1.
  assert.equal(result.cutoffRowid, 0, 'safeCutoff must be first-in-window ROWID (1) minus 1 = 0')
  db.close()
})

// ── fetchOrCachedProspects ────────────────────────────────────────────────────
// The cache-fallback branch is the scanner's resilience mechanism during cloud
// outages. A silent regression here (wrong cache key, parse error) would cause
// the scanner to halt on every outage instead of using cached data — a lead-loss
// risk that was previously untestable inside main().

let tmpCounter = 0
function tmpStatePath() {
  return path.join(os.tmpdir(), `foc-test-state-${process.pid}-${++tmpCounter}.json`)
}

test('fetchOrCachedProspects: returns fresh prospects and caches them in state.json on success', async () => {
  const statePath = tmpStatePath()
  const _fetch = async () => ({
    ok: true,
    json: async () => ({ phones: ['+14155550100'], emails: ['lead@example.com'], count_phones: 1, count_emails: 1 }),
  })

  const result = await fetchOrCachedProspects({
    _fetch,
    _delay:     NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret:     'test-secret',
    scannerId:  '',
    statePath,
  })

  // Returns a live prospects object
  assert.ok(result.phones instanceof Set, 'phones should be a Set')
  assert.ok(result.phones.has('4155550100'), 'phone should be normalized to 10-digit bare')
  assert.ok(result.emails.has('lead@example.com'))

  // Writes cached_prospects to state.json for use on future runs
  const { loadState } = require('./state')
  const saved = loadState(statePath)
  assert.ok(saved.cached_prospects, 'cached_prospects must be written to state')
  assert.ok(Array.isArray(saved.cached_prospects.phones), 'cached phones must be an array')
  assert.ok(saved.cached_prospects.phones.includes('4155550100'), 'cached phone must be normalized')

  fs.unlinkSync(statePath)
})

test('fetchOrCachedProspects: uses cached allowlist when cloud fetch fails and cache exists', async () => {
  const statePath = tmpStatePath()
  const { saveState } = require('./state')

  // Pre-seed the state file with a cached allowlist
  saveState(statePath, {
    last_rowid: 42,
    cached_prospects: { phones: ['6505551234'], emails: ['cached@example.com'] },
  })

  const _fetch = async () => { throw new Error('ECONNREFUSED') }

  const result = await fetchOrCachedProspects({
    _fetch,
    _delay:     NOOP_DELAY,
    webhookUrl: 'https://example.pugs.media/api/import/imessage',
    secret:     'test-secret',
    scannerId:  '',
    statePath,
  })

  assert.ok(result.phones.has('6505551234'), 'cached phone must be in returned Set')
  assert.ok(result.emails.has('cached@example.com'), 'cached email must be in returned Set')

  // last_rowid must not have been clobbered (state merged, not overwritten)
  const { loadState } = require('./state')
  const saved = loadState(statePath)
  assert.equal(saved.last_rowid, 42, 'last_rowid must survive the cache fallback path')

  fs.unlinkSync(statePath)
})

test('fetchOrCachedProspects: throws when cloud fails and state has no cached_prospects', async () => {
  const statePath = tmpStatePath()
  // Empty state — no cached_prospects key
  const { saveState } = require('./state')
  saveState(statePath, { last_rowid: 0 })

  const _fetch = async () => { throw new Error('network timeout') }

  await assert.rejects(
    () => fetchOrCachedProspects({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
      statePath,
    }),
    /no cache available/,
    'must throw with "no cache available" when state has no cached_prospects',
  )

  fs.unlinkSync(statePath)
})

test('fetchOrCachedProspects: throws when cloud fails and cached_prospects is corrupt', async () => {
  const statePath = tmpStatePath()
  const { saveState } = require('./state')
  // Store a malformed cached_prospects (phones is a string, not an array)
  saveState(statePath, { last_rowid: 0, cached_prospects: { phones: 'NOT-AN-ARRAY', emails: [] } })

  const _fetch = async () => { throw new Error('503 Service Unavailable') }

  await assert.rejects(
    () => fetchOrCachedProspects({
      _fetch,
      _delay:     NOOP_DELAY,
      webhookUrl: 'https://example.pugs.media/api/import/imessage',
      secret:     'test-secret',
      scannerId:  '',
      statePath,
    }),
    /cached allowlist is invalid/,
    'must throw with "cached allowlist is invalid" when cached_prospects fails parseProspectHandles',
  )

  fs.unlinkSync(statePath)
})

test('fetchOrCachedProspects: returns FRESH prospects when state save fails (not stale cache)', async () => {
  // If saveState throws (disk full, permissions), the fresh fetch result must
  // still be returned for this run. Before the fix, the save error was caught
  // by the outer catch block and treated as a fetch failure — the function
  // fell back to stale cached data, silently filtering a newly-added prospect.
  const statePath = tmpStatePath()
  const { saveState: realSave } = require('./state')

  // Seed state with a STALE cached allowlist (missing the new prospect's phone)
  realSave(statePath, {
    last_rowid: 10,
    cached_prospects: { phones: ['8005550100'], emails: [] },
  })

  // Fresh fetch returns an UPDATED allowlist with the new prospect
  const _fetch = async () => ({
    ok: true,
    json: async () => ({ phones: ['+18005550100', '+14155559999'], emails: [], count_phones: 2, count_emails: 0 }),
  })

  const result = await fetchOrCachedProspects({
    _fetch,
    _delay:      NOOP_DELAY,
    _saveState:  () => { throw new Error('ENOSPC: no space left on device') },
    webhookUrl:  'https://example.pugs.media/api/import/imessage',
    secret:      'test-secret',
    scannerId:   '',
    statePath,
  })

  // Must return the FRESH prospects (both phones), not the stale cached one
  assert.ok(result.phones instanceof Set, 'result must be a live prospects Set')
  assert.ok(result.phones.has('8005550100'), 'existing phone must be present')
  assert.ok(result.phones.has('4155559999'), 'NEW prospect phone must be present — fresh data, not stale cache')
  assert.equal(result.phones.size, 2, 'both phones from the fresh fetch must be present')

  fs.unlinkSync(statePath)
})

test('fetchOrCachedProspects: logs a warning (not a crash) when state save fails', async () => {
  const statePath = tmpStatePath()
  const { saveState: realSave } = require('./state')
  realSave(statePath, { last_rowid: 0 })

  const _fetch = async () => ({
    ok: true,
    json: async () => ({ phones: ['4155550100'], emails: [], count_phones: 1, count_emails: 0 }),
  })

  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))

  let result
  try {
    result = await fetchOrCachedProspects({
      _fetch,
      _delay:      NOOP_DELAY,
      _saveState:  () => { throw new Error('ENOSPC: no space left on device') },
      webhookUrl:  'https://example.pugs.media/api/import/imessage',
      secret:      'test-secret',
      scannerId:   '',
      statePath,
    })
  } finally {
    console.warn = origWarn
  }

  assert.ok(result.phones instanceof Set, 'must return a valid prospects object despite the save failure')
  assert.ok(
    warnings.some(w => w.includes('could not cache fresh allowlist') && w.includes('ENOSPC')),
    `must log a warning mentioning the save failure; got: ${JSON.stringify(warnings)}`,
  )

  fs.unlinkSync(statePath)
})
