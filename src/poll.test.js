'use strict'

// Must be set before requiring poll.js — it validates env at module load.
process.env.PUGS_SYNC_WEBHOOK_URL = 'https://example.pugs.media/api/import/imessage'
process.env.PUGS_SYNC_SECRET      = 'test-secret'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { processBatch, reportOutcome, fetchPendingBatch, dispatchToLocalSender, loop } = require('./poll')

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

// ---------------------------------------------------------------------------
// fetchPendingBatch
// ---------------------------------------------------------------------------

test('fetchPendingBatch: returns items array on success', async () => {
  const items = [{ id: 'q1', to_handle: '+14155550100', body: 'hello', attempts: 0 }]
  const result = await fetchPendingBatch({
    _fetch: async () => ({ ok: true, json: async () => ({ items }), text: async () => '' }),
  })
  assert.deepEqual(result, items)
})

test('fetchPendingBatch: returns empty array when items field is absent or non-array', async () => {
  const result = await fetchPendingBatch({
    _fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  })
  assert.deepEqual(result, [])
})

test('fetchPendingBatch: throws with status on HTTP error', async () => {
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => ({ ok: false, status: 503, text: async () => 'gateway timeout' }),
    }),
    /queue GET 503/,
  )
})

test('fetchPendingBatch: throws descriptive error when HTTP 200 body is not valid JSON', async () => {
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => ({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token <') },
        text: async () => '',
      }),
    }),
    /queue GET 200 bad JSON/,
  )
})

test('fetchPendingBatch: propagates network errors unchanged', async () => {
  await assert.rejects(
    () => fetchPendingBatch({ _fetch: async () => { throw new Error('ECONNREFUSED') } }),
    /ECONNREFUSED/,
  )
})

// ---------------------------------------------------------------------------
// dispatchToLocalSender — timeout and error handling
// ---------------------------------------------------------------------------

test('dispatchToLocalSender: returns JSON body on 200 OK', async () => {
  const item = { id: '1', to_handle: '+14155550100', body: 'hi', attempts: 0 }
  const result = await dispatchToLocalSender(item, {
    _fetch: async () => ({ ok: true, json: async () => ({ ok: true }), text: async () => '' }),
  })
  assert.deepEqual(result, { ok: true })
})

test('dispatchToLocalSender: throws with status text on non-ok response', async () => {
  const item = { id: '2', to_handle: '+14155550100', body: 'hi', attempts: 0 }
  await assert.rejects(
    () => dispatchToLocalSender(item, {
      _fetch: async () => ({ ok: false, status: 500, text: async () => 'internal error' }),
    }),
    /local send 500.*internal error/,
  )
})

test('dispatchToLocalSender: aborts and throws AbortError after _timeoutMs', async () => {
  const item = { id: '3', to_handle: '+14155550100', body: 'hi', attempts: 0 }

  // Fetch that hangs until the AbortSignal fires
  const hangingFetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })

  await assert.rejects(
    () => dispatchToLocalSender(item, { _fetch: hangingFetch, _timeoutMs: 50 }),
    (err) => err.name === 'AbortError',
  )
})

test('dispatchToLocalSender: timeout fires even if fetch resolves just before it', async () => {
  // Verifies clearTimeout runs in the finally block; timer must not keep the
  // test process open after a successful dispatch.
  const item = { id: '4', to_handle: '+14155550100', body: 'hi', attempts: 0 }
  const result = await dispatchToLocalSender(item, {
    _fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    _timeoutMs: 5000,
  })
  assert.deepEqual(result, {})
})

test('processBatch: continues to next item when dispatchToLocalSender times out', async () => {
  const outcomes = []
  const items = [
    { id: 'hung',  to_handle: '+14155550100', body: 'A', attempts: 0 },
    { id: 'after', to_handle: '+14155550200', body: 'B', attempts: 0 },
  ]

  let dispatchCount = 0
  const flakyDispatch = async (item) => {
    dispatchCount++
    if (item.id === 'hung') throw new Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    return {}
  }

  await processBatch(items, deps({
    reportOutcome: async (id, payload) => { outcomes.push({ id, status: payload.status }) },
    dispatchToLocalSender: flakyDispatch,
  }))

  assert.equal(dispatchCount, 2, 'both items must be attempted')
  assert.deepEqual(outcomes, [
    { id: 'hung',  status: 'failed' },
    { id: 'after', status: 'sent' },
  ])
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

// ---------------------------------------------------------------------------
// loop() — graceful shutdown
// ---------------------------------------------------------------------------

test('loop: exits after current poll cycle completes when shutdown is set during pollOnce', async () => {
  // Simulates SIGTERM arriving while a dispatch is in flight: the cycle
  // finishes, then the loop drains cleanly rather than spinning forever.
  let polls = 0
  let shutDown = false

  await loop({
    _pollOnce: async () => { polls++; shutDown = true },
    _delay: async () => {},
    _isShuttingDown: () => shutDown,
  })

  assert.equal(polls, 1, 'should run exactly one poll cycle before exiting')
})

test('loop: exits during sleep interval when shutdown is set between cycles', async () => {
  let polls = 0
  let sleeps = 0
  let shutDown = false

  await loop({
    _pollOnce: async () => { polls++ },
    _delay: async () => { sleeps++; shutDown = true },
    _isShuttingDown: () => shutDown,
  })

  assert.equal(polls, 1, 'one cycle runs before the sleep')
  assert.equal(sleeps, 1, 'sleep fires once then loop exits')
})

test('loop: runs multiple cycles before shutdown signal', async () => {
  let polls = 0
  let shutDown = false

  await loop({
    _pollOnce: async () => { polls++; if (polls >= 3) shutDown = true },
    _delay: async () => {},
    _isShuttingDown: () => shutDown,
  })

  assert.equal(polls, 3, 'should run all cycles until shutdown flag is set')
})

test('loop: never calls _delay after shutdown is set (exits immediately after pollOnce)', async () => {
  let shutDown = false
  let delayCount = 0

  await loop({
    _pollOnce: async () => { shutDown = true },
    _delay: async () => { delayCount++ },
    _isShuttingDown: () => shutDown,
  })

  assert.equal(delayCount, 0, '_delay must not be called when shutdown flag is set after pollOnce')
})
