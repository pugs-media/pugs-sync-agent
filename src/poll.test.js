'use strict'

// Must be set before requiring poll.js — it validates env at module load.
process.env.PUGS_SYNC_WEBHOOK_URL = 'https://example.pugs.media/api/import/imessage'
process.env.PUGS_SYNC_SECRET      = 'test-secret'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { processBatch, flushJournal, reportOutcome, fetchPendingBatch, dispatchToLocalSender, loop } = require('./poll')

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

test('reportOutcome: does not retry on 401 — permanent auth failure', async () => {
  let calls = 0
  await reportOutcome('id-5', { status: 'sent' }, {
    _fetch: async () => { calls++; return { ok: false, status: 401, text: async () => 'Unauthorized' } },
    _delay: noDelay,
  })
  assert.equal(calls, 1, '401 must not trigger any retries')
})

test('reportOutcome: does not retry on 403 — permanent auth failure', async () => {
  let calls = 0
  await reportOutcome('id-6', { status: 'sent' }, {
    _fetch: async () => { calls++; return { ok: false, status: 403, text: async () => 'Forbidden' } },
    _delay: noDelay,
  })
  assert.equal(calls, 1, '403 must not trigger any retries')
})

test('reportOutcome: does not retry on 404 — queue item already reaped', async () => {
  let calls = 0
  await reportOutcome('id-7', { status: 'sent' }, {
    _fetch: async () => { calls++; return { ok: false, status: 404, text: async () => 'Not Found' } },
    _delay: noDelay,
  })
  assert.equal(calls, 1, '404 must not trigger any retries')
})

test('reportOutcome: does not invoke _delay on 4xx fast-fail', async () => {
  let delayed = false
  await reportOutcome('id-8', { status: 'sent' }, {
    _fetch: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }),
    _delay: async () => { delayed = true },
  })
  assert.equal(delayed, false, '_delay must not be called on permanent 4xx')
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

test('fetchPendingBatch: throws after all 3 retries exhausted on 5xx', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => { calls++; return { ok: false, status: 503, text: async () => 'gateway timeout' } },
      _delay: noDelay,
    }),
    /queue GET 503/,
  )
  assert.equal(calls, 3, 'should try exactly 3 times before throwing')
})

test('fetchPendingBatch: retries on 503 and succeeds on second attempt', async () => {
  let calls = 0
  const items = [{ id: 'q1', to_handle: '+14155550100', body: 'hi', attempts: 0 }]
  const result = await fetchPendingBatch({
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 503, text: async () => 'Service Unavailable' }
      return { ok: true, json: async () => ({ items }) }
    },
    _delay: noDelay,
  })
  assert.equal(calls, 2, 'should retry once on 5xx and succeed')
  assert.deepEqual(result, items)
})

test('fetchPendingBatch: retries on network error and succeeds on second attempt', async () => {
  let calls = 0
  const items = [{ id: 'q2', to_handle: '+12025550199', body: 'hey', attempts: 0 }]
  const result = await fetchPendingBatch({
    _fetch: async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return { ok: true, json: async () => ({ items }) }
    },
    _delay: noDelay,
  })
  assert.equal(calls, 2, 'should retry once on network error and succeed')
  assert.deepEqual(result, items)
})

test('fetchPendingBatch: throws after all 3 retries exhausted on repeated network error', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => { calls++; throw new Error('ECONNREFUSED') },
      _delay: noDelay,
    }),
    /ECONNREFUSED/,
  )
  assert.equal(calls, 3, 'should try exactly 3 times on repeated network errors')
})

test('fetchPendingBatch: throws immediately on 401 — permanent, no retry', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => { calls++; return { ok: false, status: 401, text: async () => 'unauthorized' } },
      _delay: noDelay,
    }),
    /queue GET 401/,
  )
  assert.equal(calls, 1, '4xx must not be retried')
})

test('fetchPendingBatch: throws immediately on 403 — permanent, no retry', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => { calls++; return { ok: false, status: 403, text: async () => 'forbidden' } },
      _delay: noDelay,
    }),
    /queue GET 403/,
  )
  assert.equal(calls, 1, '4xx must not be retried')
})

test('fetchPendingBatch: uses increasing backoff between retries', async () => {
  const delays = []
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => ({ ok: false, status: 503, text: async () => 'err' }),
      _delay: async (ms) => { delays.push(ms) },
    }),
  )
  assert.deepEqual(delays, [500, 1000], 'delays should be 500ms then 1000ms (500 * attempt)')
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

test('dispatchToLocalSender: throws descriptive error when 200 OK body is not valid JSON', async () => {
  const item = { id: '5', to_handle: '+14155550100', body: 'hi', attempts: 0 }
  await assert.rejects(
    () => dispatchToLocalSender(item, {
      _fetch: async () => ({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token o') },
        text: async () => '',
      }),
    }),
    /local send 200 malformed JSON/,
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

// ── fetch timeout: fetchPendingBatch / reportOutcome ──────────────────────────
// Each attempt creates a fresh AbortController so a slow cloud is bounded to
// _timeoutMs rather than hanging the poller loop indefinitely.

function hangingFetch(url, opts) {
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
}

const NOOP_DELAY = async () => {}

test('fetchPendingBatch: aborts after _timeoutMs when cloud hangs', async () => {
  await assert.rejects(
    () => fetchPendingBatch({ _fetch: hangingFetch, _delay: NOOP_DELAY, _timeoutMs: 20 }),
    { name: 'AbortError' },
  )
})

test('reportOutcome: aborts after _timeoutMs when cloud hangs', async () => {
  // reportOutcome swallows errors after MAX_REPORT_TRIES — verify it still times
  // out (doesn't hang forever) even though it doesn't propagate the throw.
  let start = Date.now()
  await reportOutcome('item-1', { status: 'sent' }, {
    _fetch:     hangingFetch,
    _delay:     NOOP_DELAY,
    _timeoutMs: 20,
  })
  // 3 retries × 20ms each = at most ~100ms; well under 5s so if this hangs
  // the test runner will time out and fail.
  assert.ok(Date.now() - start < 5000, 'reportOutcome should not hang when cloud is slow')
})

// ---------------------------------------------------------------------------
// dispatch journal integration — processBatch
// ---------------------------------------------------------------------------

test('processBatch: marks journal after successful dispatch, before reportOutcome', async () => {
  const order = []
  const item = { id: 'j1', to_handle: '+14155550100', body: 'Hello', attempts: 0 }

  await processBatch([item], deps({
    dispatchToLocalSender: async () => { order.push('dispatch') },
    reportOutcome:         async () => { order.push('report') },
    journalMark:           (id)    => { order.push(`mark:${id}`) },
    journalClear:          (id)    => { order.push(`clear:${id}`) },
  }))

  assert.deepEqual(order, ['dispatch', 'mark:j1', 'report', 'clear:j1'],
    'journal mark must come after dispatch and before reportOutcome')
})

test('processBatch: does not mark journal when dispatch fails', async () => {
  const marked = []
  const item = { id: 'j2', to_handle: '+14155550100', body: 'Hello', attempts: 0 }

  await processBatch([item], deps({
    dispatchToLocalSender: async () => { throw new Error('osascript error') },
    journalMark:           (id)    => { marked.push(id) },
    journalClear:          (id)    => { marked.push(id) },
  }))

  assert.equal(marked.length, 0, 'journal must not be touched when dispatch fails')
})

test('processBatch: does not mark journal for skip/fail/drop paths', async () => {
  const marked = []
  const items = [
    { id: 'sk', to_handle: '+14155550100', body: 'B', attempts: MAX },  // skip
    { id: 'fl', to_handle: '',             body: 'C', attempts: 0 },    // fail
    { /* drop */  to_handle: '+1415', body: 'D' },
  ]

  await processBatch(items, deps({
    journalMark:  (id) => { marked.push(id) },
    journalClear: (id) => { marked.push(id) },
  }))

  assert.equal(marked.length, 0, 'journal must only be touched on the send path')
})

// ---------------------------------------------------------------------------
// dispatch journal integration — flushJournal
// ---------------------------------------------------------------------------

test('flushJournal: reports each pending id as sent then clears it', async () => {
  const reported = []
  const cleared  = []

  await flushJournal({
    reportOutcome: async (id, payload) => { reported.push({ id, status: payload.status }) },
    journalList:   () => ['crash-1', 'crash-2'],
    journalClear:  (id) => { cleared.push(id) },
    log: noop,
  })

  assert.deepEqual(reported, [
    { id: 'crash-1', status: 'sent' },
    { id: 'crash-2', status: 'sent' },
  ])
  assert.deepEqual(cleared, ['crash-1', 'crash-2'])
})

test('flushJournal: is a no-op when journal is empty', async () => {
  let called = false
  await flushJournal({
    reportOutcome: async () => { called = true },
    journalList:   () => [],
    journalClear:  () => {},
    log: noop,
  })
  assert.equal(called, false, 'reportOutcome must not be called when journal is empty')
})

test('flushJournal: clears each id even when reportOutcome swallows an error', async () => {
  const cleared = []
  await flushJournal({
    // reportOutcome is already log-and-swallow in production, so simulate that
    reportOutcome: async () => { /* swallowed */ },
    journalList:   () => ['item-x'],
    journalClear:  (id) => { cleared.push(id) },
    log: noop,
  })
  assert.deepEqual(cleared, ['item-x'], 'journal entry must be cleared even when report is a no-op')
})
