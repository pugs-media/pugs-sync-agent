'use strict'

// Must be set before requiring poll.js — it validates env at module load.
process.env.PUGS_SYNC_WEBHOOK_URL = 'https://example.pugs.media/api/import/imessage'
process.env.PUGS_SYNC_SECRET      = 'test-secret'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { processBatch, reportOutcome } = require('./poll')

const noop = () => {}
const asyncNoop = async () => {}

const MAX = 5

function deps(overrides = {}) {
  return {
    reportOutcome: asyncNoop,
    dispatchToLocalSender: asyncNoop,
    maxAttempts: MAX,
    log: noop,
    ...overrides,
  }
}

test('processBatch: skip path reports skipped to cloud (prevents dead items clogging queue)', async () => {
  const reported = []
  const item = { id: 'abc', to_handle: '+14155550100', body: 'hi', attempts: MAX }

  await processBatch([item], deps({
    reportOutcome: async (id, payload) => { reported.push({ id, payload }) },
  }))

  assert.equal(reported.length, 1, 'skip must call reportOutcome')
  assert.equal(reported[0].id, 'abc')
  assert.equal(reported[0].payload.status, 'skipped')
})

test('processBatch: skip never calls the local sender', async () => {
  const dispatched = []
  const item = { id: 'abc', to_handle: '+14155550100', body: 'hi', attempts: MAX }

  await processBatch([item], deps({
    dispatchToLocalSender: async (i) => { dispatched.push(i) },
  }))

  assert.equal(dispatched.length, 0, 'skip must not call the iMessage sender')
})

test('processBatch: fail path reports failed without dispatching to sender', async () => {
  const reported = []
  const dispatched = []
  const item = { id: 'bad', to_handle: '', body: 'hi', attempts: 0 }

  await processBatch([item], deps({
    reportOutcome: async (id, payload) => { reported.push({ id, payload }) },
    dispatchToLocalSender: async (i) => { dispatched.push(i) },
  }))

  assert.equal(reported.length, 1)
  assert.equal(reported[0].payload.status, 'failed')
  assert.equal(dispatched.length, 0, 'sender must not be called for malformed rows')
})

test('processBatch: drop path skips without reporting (no id to reference)', async () => {
  const reported = []
  const item = { to_handle: '+14155550100', body: 'hi' } // no id

  await processBatch([item], deps({
    reportOutcome: async (id, payload) => { reported.push({ id, payload }) },
  }))

  assert.equal(reported.length, 0, 'drop items have no id and cannot be reported')
})

test('processBatch: send path dispatches and reports sent', async () => {
  const reported = []
  const dispatched = []
  const item = { id: 1, to_handle: '+14155550100', body: 'Hello', attempts: 0 }

  await processBatch([item], deps({
    reportOutcome: async (id, payload) => { reported.push({ id, payload }) },
    dispatchToLocalSender: async (i) => { dispatched.push(i); return {} },
  }))

  assert.equal(dispatched.length, 1)
  assert.equal(reported.length, 1)
  assert.equal(reported[0].payload.status, 'sent')
})

test('processBatch: send failure reports failed without rethrowing', async () => {
  const reported = []
  const item = { id: 2, to_handle: '+14155550100', body: 'Hello', attempts: 0 }

  await processBatch([item], deps({
    reportOutcome: async (id, payload) => { reported.push({ id, payload }) },
    dispatchToLocalSender: async () => { throw new Error('osascript timeout') },
  }))

  assert.equal(reported.length, 1)
  assert.equal(reported[0].payload.status, 'failed')
  assert.ok(reported[0].payload.error.includes('osascript timeout'))
})

test('processBatch: mixed batch processes all items in order', async () => {
  const outcomes = []
  const items = [
    { id: 'send-1',  to_handle: '+14155550100', body: 'A', attempts: 0 },
    { id: 'skip-1',  to_handle: '+14155550100', body: 'B', attempts: MAX },
    { id: 'fail-1',  to_handle: '',             body: 'C', attempts: 0 },
    { /* drop — no id */ to_handle: '+1415', body: 'D' },
  ]

  await processBatch(items, deps({
    reportOutcome: async (id, payload) => { outcomes.push({ id, status: payload.status }) },
    dispatchToLocalSender: asyncNoop,
  }))

  assert.deepEqual(outcomes, [
    { id: 'send-1', status: 'sent' },
    { id: 'skip-1', status: 'skipped' },
    { id: 'fail-1', status: 'failed' },
    // drop: no reportOutcome call
  ])
})

// ---------------------------------------------------------------------------
// reportOutcome retry behaviour
// ---------------------------------------------------------------------------

const noDelay = async () => {}

function okResponse() { return { ok: true, text: async () => '' } }
function errResponse(status = 503) { return { ok: false, text: async () => `error ${status}` } }

test('reportOutcome: succeeds on first attempt — single fetch call', async () => {
  let calls = 0
  await reportOutcome('id-1', { status: 'sent' }, {
    _fetch: async () => { calls++; return okResponse() },
    _delay: noDelay,
  })
  assert.equal(calls, 1)
})

test('reportOutcome: retries on HTTP error and succeeds on second attempt', async () => {
  let calls = 0
  await reportOutcome('id-2', { status: 'sent' }, {
    _fetch: async () => { calls++; return calls === 1 ? errResponse() : okResponse() },
    _delay: noDelay,
  })
  assert.equal(calls, 2, 'should retry once after HTTP error')
})

test('reportOutcome: retries on network throw and succeeds on second attempt', async () => {
  let calls = 0
  await reportOutcome('id-3', { status: 'sent' }, {
    _fetch: async () => {
      calls++
      if (calls === 1) throw new Error('network timeout')
      return okResponse()
    },
    _delay: noDelay,
  })
  assert.equal(calls, 2, 'should retry once after network throw')
})

test('reportOutcome: exhausts all retries and does not throw (log-and-swallow)', async () => {
  let calls = 0
  let threw = false
  try {
    await reportOutcome('id-4', { status: 'sent' }, {
      _fetch: async () => { calls++; return errResponse() },
      _delay: noDelay,
    })
  } catch {
    threw = true
  }
  assert.equal(threw, false, 'exhausted retries must not propagate an error')
  assert.equal(calls, 3, 'should try exactly MAX_REPORT_TRIES times')
})

test('reportOutcome: exhausts retries on repeated network throws without throwing', async () => {
  let calls = 0
  let threw = false
  try {
    await reportOutcome('id-5', { status: 'sent' }, {
      _fetch: async () => { calls++; throw new Error('ECONNREFUSED') },
      _delay: noDelay,
    })
  } catch {
    threw = true
  }
  assert.equal(threw, false, 'exhausted network errors must not propagate')
  assert.equal(calls, 3)
})
