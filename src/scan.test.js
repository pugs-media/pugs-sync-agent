'use strict'

// Must be set before requiring scan.js — it validates env at module load.
process.env.PUGS_SYNC_WEBHOOK_URL = 'https://example.pugs.media/api/import/imessage'
process.env.PUGS_SYNC_SECRET      = 'test-secret'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { fetchProspectHandles, parseProspectHandles, postToWebhook } = require('./scan')

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

test('parseProspectHandles: treats null phones as empty set', () => {
  const result = parseProspectHandles({ phones: null, emails: [], count_phones: 0, count_emails: 0 })
  assert.equal(result.phones.size, 0)
})

test('parseProspectHandles: treats null emails as empty set', () => {
  const result = parseProspectHandles({ phones: [], emails: null, count_phones: 0, count_emails: 0 })
  assert.equal(result.emails.size, 0)
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
