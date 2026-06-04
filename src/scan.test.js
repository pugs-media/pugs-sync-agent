'use strict'

// Must be set before requiring scan.js — it validates env at module load.
process.env.PUGS_SYNC_WEBHOOK_URL = 'https://example.pugs.media/api/import/imessage'
process.env.PUGS_SYNC_SECRET      = 'test-secret'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { fetchProspectHandles } = require('./scan')

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
