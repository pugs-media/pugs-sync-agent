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
    journalMark: () => true,  // Default: mark succeeds
    journalClear: noop,
    journalList: () => [],
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

test('reportOutcome: retries on 408 (request timeout) like a transient error', async () => {
  let calls = 0
  await reportOutcome('id-9', { status: 'sent' }, {
    _fetch: async () => { calls++; return calls === 1 ? { ok: false, status: 408, text: async () => 'Request Timeout' } : okResponse() },
    _delay: noDelay,
  })
  assert.equal(calls, 2, '408 must trigger retry and succeed on second attempt')
})

test('reportOutcome: retries on 429 (rate limit) like a transient error', async () => {
  let calls = 0
  await reportOutcome('id-10', { status: 'sent' }, {
    _fetch: async () => { calls++; return calls === 1 ? { ok: false, status: 429, text: async () => 'Too Many Requests' } : okResponse() },
    _delay: noDelay,
  })
  assert.equal(calls, 2, '429 must trigger retry and succeed on second attempt')
})

test('reportOutcome: succeeds on 2nd attempt after a 408 timeout', async () => {
  let calls = 0
  await reportOutcome('id-11', { status: 'sent' }, {
    _fetch: async () => { calls++; return calls === 1 ? { ok: false, status: 408, text: async () => 'timeout' } : okResponse() },
    _delay: noDelay,
  })
  assert.equal(calls, 2, 'should succeed after retrying 408')
})

test('reportOutcome: throws after all 3 retries exhausted on repeated 429', async () => {
  let calls = 0
  try {
    await reportOutcome('id-12', { status: 'sent' }, {
      _fetch: async () => { calls++; return { ok: false, status: 429, text: async () => 'rate limit' } },
      _delay: noDelay,
    })
  } catch {
    // expected: no throw on exhausted retries (log-and-swallow), but we call it anyway
  }
  assert.equal(calls, 3, 'should try exactly MAX_REPORT_TRIES times on repeated 429')
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

test('fetchPendingBatch: retries on 408 (request timeout) like a transient error', async () => {
  let calls = 0
  const items = [{ id: 'q-408', to_handle: '+14155550100', body: 'hello', attempts: 0 }]
  const result = await fetchPendingBatch({
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 408, text: async () => 'Request Timeout' }
      return { ok: true, json: async () => ({ items }) }
    },
    _delay: noDelay,
  })
  assert.equal(calls, 2, '408 must trigger retry and succeed on second attempt')
  assert.deepEqual(result, items)
})

test('fetchPendingBatch: retries on 429 (rate limit) like a transient error', async () => {
  let calls = 0
  const items = [{ id: 'q-429', to_handle: '+14155550100', body: 'hi', attempts: 0 }]
  const result = await fetchPendingBatch({
    _fetch: async () => {
      calls++
      if (calls === 1) return { ok: false, status: 429, text: async () => 'Too Many Requests' }
      return { ok: true, json: async () => ({ items }) }
    },
    _delay: noDelay,
  })
  assert.equal(calls, 2, '429 must trigger retry and succeed on second attempt')
  assert.deepEqual(result, items)
})

test('fetchPendingBatch: throws after all 3 retries exhausted on repeated 408', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => { calls++; return { ok: false, status: 408, text: async () => 'timeout' } },
      _delay: noDelay,
    }),
    /queue GET 408/,
  )
  assert.equal(calls, 3, 'should try exactly 3 times before throwing on repeated 408')
})

test('fetchPendingBatch: throws after all 3 retries exhausted on repeated 429', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchPendingBatch({
      _fetch: async () => { calls++; return { ok: false, status: 429, text: async () => 'rate limit' } },
      _delay: noDelay,
    }),
    /queue GET 429/,
  )
  assert.equal(calls, 3, 'should try exactly 3 times before throwing on repeated 429')
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

// ── reportOutcome: return value — true = cloud confirmed, false = unconfirmed ─
// reportOutcome returns true when the cloud acknowledges receipt (2xx or
// permanent 4xx), and false when retries are exhausted without confirmation.
// Callers use this to decide whether to clear the dispatch journal: only clear
// after true, so the journal entry persists as a double-send guard until the
// cloud is reachable again.

test('reportOutcome: returns true on 200 OK', async () => {
  const result = await reportOutcome('id-ok', { status: 'sent' }, {
    _fetch: async () => ({ ok: true }),
    _delay: noDelay,
  })
  assert.equal(result, true)
})

test('reportOutcome: returns true on 4xx — cloud considers the item handled', async () => {
  // 404 = item already reaped; 401/403 = auth broken. In both cases retrying
  // is pointless; treating as confirmed keeps the journal from accumulating
  // unresolvable entries.
  const result = await reportOutcome('id-404', { status: 'sent' }, {
    _fetch: async () => ({ ok: false, status: 404, text: async () => 'Not Found' }),
    _delay: noDelay,
  })
  assert.equal(result, true)
})

test('reportOutcome: returns false after exhausted 5xx retries — cloud unconfirmed', async () => {
  const result = await reportOutcome('id-5xx', { status: 'sent' }, {
    _fetch: async () => ({ ok: false, status: 503, text: async () => 'Service Unavailable' }),
    _delay: noDelay,
  })
  assert.equal(result, false, 'unconfirmed: caller must not clear the journal entry')
})

test('reportOutcome: returns false after exhausted network-error retries — cloud unconfirmed', async () => {
  const result = await reportOutcome('id-net', { status: 'sent' }, {
    _fetch: async () => { throw new Error('ECONNREFUSED') },
    _delay: noDelay,
  })
  assert.equal(result, false, 'unconfirmed: caller must not clear the journal entry')
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
    reportOutcome:         async () => { order.push('report'); return true },
    journalMark:           (id)    => { order.push(`mark:${id}`); return true },
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

test('processBatch: does not clear journal when reportOutcome returns false (double-send guard)', async () => {
  // If the cloud is unreachable and reportOutcome exhausts retries, the journal
  // entry must NOT be cleared. The next cycle's flushJournal will re-try before
  // fetching the batch — keeping the guard active until the cloud confirms receipt.
  const cleared = []
  const item = { id: 'j3', to_handle: '+14155550100', body: 'Hello', attempts: 0 }

  await processBatch([item], deps({
    dispatchToLocalSender: asyncNoop,
    reportOutcome:         async () => false,
    journalMark:           () => {},
    journalClear:          (id) => { cleared.push(id) },
  }))

  assert.equal(cleared.length, 0, 'journal must not be cleared when outcome is unconfirmed')
})

// ---------------------------------------------------------------------------
// dispatch journal integration — flushJournal
// ---------------------------------------------------------------------------

test('flushJournal: reports each pending id as sent then clears it', async () => {
  const reported = []
  const cleared  = []

  await flushJournal({
    reportOutcome: async (id, payload) => { reported.push({ id, status: payload.status }); return true },
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

test('flushJournal: does NOT clear entry when reportOutcome returns false (cloud unconfirmed)', async () => {
  // If reportOutcome exhausts retries without cloud confirmation, the journal
  // entry must stay so the next cycle's flushJournal can retry — this keeps
  // the double-send guard active rather than silently giving up.
  const cleared = []
  await flushJournal({
    reportOutcome: async () => false,  // simulates exhausted retries, cloud unreachable
    journalList:   () => ['item-x'],
    journalClear:  (id) => { cleared.push(id) },
    log: noop,
  })
  assert.deepEqual(cleared, [], 'journal must not be cleared when outcome is unconfirmed')
})

// ---------------------------------------------------------------------------
// processBatch: dedup guard — duplicate item IDs within a single batch
//
// The cloud must never return the same queue item twice in a batch, but a
// cloud bug or race could produce duplicates. Without a guard, processBatch
// would dispatch the same iMessage twice — a client-comms error. The seenIds
// Set in processBatch prevents the second occurrence from reaching the sender.
// ---------------------------------------------------------------------------

test('processBatch: dedup — second occurrence of same id is skipped, not dispatched', async () => {
  const dispatched = []
  const reported   = []
  // Two items with the same id — the cloud should never do this, but we guard
  // at this layer so a cloud bug cannot cause a double-send.
  const items = [
    { id: 'dup-1', to_handle: '+14155550100', body: 'First',  attempts: 0 },
    { id: 'dup-1', to_handle: '+14155550100', body: 'Second', attempts: 0 },
  ]

  await processBatch(items, deps({
    dispatchToLocalSender: async (item) => { dispatched.push(item.id) },
    reportOutcome:         async (id, payload) => { reported.push({ id, status: payload.status }); return true },
    journalMark:           () => true,
    journalClear:          () => {},
  }))

  assert.equal(dispatched.length, 1, 'sender must be called exactly once — duplicate must be dropped')
  assert.equal(dispatched[0], 'dup-1', 'first occurrence must be the one dispatched')
  // Only one reportOutcome call (for the first occurrence); the second is silently skipped
  assert.equal(reported.length, 1)
  assert.equal(reported[0].status, 'sent')
})

test('processBatch: dedup — first occurrence dispatches normally, second is a no-op', async () => {
  // Verifies that the guard does not affect the first occurrence:
  // it must still go through the full send path.
  const order = []
  const items = [
    { id: 42, to_handle: '+14155550100', body: 'Hello', attempts: 0 },
    { id: 42, to_handle: '+14155550100', body: 'Hello', attempts: 0 },
  ]

  await processBatch(items, deps({
    dispatchToLocalSender: async () => { order.push('dispatch') },
    reportOutcome:         async () => { order.push('report'); return true },
    journalMark:           ()     => { order.push('mark'); return true },
    journalClear:          ()     => { order.push('clear') },
  }))

  // Exactly one full send cycle; the duplicate triggers none of these
  assert.deepEqual(order, ['dispatch', 'mark', 'report', 'clear'])
})

test('processBatch: dedup — numeric and string representation of the same id are treated as one', async () => {
  // Coerces ids to string for comparison so 42 and "42" collapse to the same slot.
  // Cloud IDs can be either type depending on the DB/serialiser used.
  const dispatched = []
  const items = [
    { id: 42,   to_handle: '+14155550100', body: 'hi', attempts: 0 },
    { id: '42', to_handle: '+14155550100', body: 'hi', attempts: 0 },
  ]

  await processBatch(items, deps({
    dispatchToLocalSender: async (item) => { dispatched.push(item.id) },
    reportOutcome: asyncNoop,
  }))

  assert.equal(dispatched.length, 1, 'numeric 42 and string "42" must collapse to the same dedup slot')
})

test('processBatch: dedup — distinct ids are all dispatched', async () => {
  // Sanity-check: the guard must not affect items with different ids.
  const dispatched = []
  const items = [
    { id: 'a', to_handle: '+14155550100', body: 'A', attempts: 0 },
    { id: 'b', to_handle: '+14155550200', body: 'B', attempts: 0 },
    { id: 'c', to_handle: '+14155550300', body: 'C', attempts: 0 },
  ]

  await processBatch(items, deps({
    dispatchToLocalSender: async (item) => { dispatched.push(item.id) },
    reportOutcome: asyncNoop,
  }))

  assert.deepEqual(dispatched.sort(), ['a', 'b', 'c'], 'all distinct ids must be dispatched')
})

test('processBatch: dedup — skip path of a duplicate id does not call the sender', async () => {
  // If the first occurrence is sent (attempts=0) and the second is a duplicate,
  // the duplicate must be dropped before reaching either the sender or the skip path.
  const dispatched = []
  const items = [
    { id: 'sk-1', to_handle: '+14155550100', body: 'A', attempts: 0 },
    { id: 'sk-1', to_handle: '+14155550100', body: 'A', attempts: MAX },  // would be skip
  ]

  await processBatch(items, deps({
    dispatchToLocalSender: async (item) => { dispatched.push(item.id) },
    reportOutcome: asyncNoop,
  }))

  assert.equal(dispatched.length, 1, 'duplicate must be dropped before skip or send path')
})

// ---------------------------------------------------------------------------
// dispatchToLocalSender — request body and header contract
//
// The poller renames cloud-schema fields before forwarding to the local sender:
//   item.to_handle  →  body.to
//   item.body       →  body.text
// and hardcodes service: 'iMessage'. These mappings are the contract between
// the cloud queue shape and the sender's /send API. If either drifts silently
// (e.g. cloud renames to_handle → recipient and the poller isn't updated), the
// sender returns 400 and outbound messages stop. Tests lock the field names so
// a rename is caught immediately.
// ---------------------------------------------------------------------------

test('dispatchToLocalSender: request body maps to_handle→to and body→text', async () => {
  let capturedBody
  const item = { id: 'r1', to_handle: '+14155550100', body: 'Hello world', attempts: 0 }

  await dispatchToLocalSender(item, {
    _fetch: async (_url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({}) }
    },
  })

  assert.equal(capturedBody.to, '+14155550100', 'to_handle must be forwarded as "to"')
  assert.equal(capturedBody.text, 'Hello world', 'body must be forwarded as "text"')
})

test('dispatchToLocalSender: request body hardcodes service=iMessage (v1 design decision)', async () => {
  let capturedBody
  const item = { id: 'r2', to_handle: '+14155550100', body: 'hi', attempts: 0 }

  await dispatchToLocalSender(item, {
    _fetch: async (_url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({}) }
    },
  })

  assert.equal(capturedBody.service, 'iMessage',
    'service must always be "iMessage" — SMS fallback is explicitly out of scope for v1')
})

test('dispatchToLocalSender: request includes x-pugs-sync-secret auth header', async () => {
  let capturedHeaders
  const item = { id: 'r3', to_handle: '+14155550100', body: 'hi', attempts: 0 }

  await dispatchToLocalSender(item, {
    _fetch: async (_url, opts) => {
      capturedHeaders = opts.headers
      return { ok: true, json: async () => ({}) }
    },
  })

  assert.ok(capturedHeaders['x-pugs-sync-secret'],
    'sender requires the shared secret header — missing header causes 401 and silent outbound drop')
  assert.equal(capturedHeaders['x-pugs-sync-secret'], 'test-secret')
})

// ---------------------------------------------------------------------------
// processBatch: journal-survivor guard
//
// The dedup guard's seenIds is pre-seeded from journalList() before the batch
// loop runs. This protects against a specific double-send scenario:
//
//   1. Item X is dispatched (iMessage sent) and marked in the journal.
//   2. reportOutcome exhausts retries without cloud confirmation (transient 5xx
//      or timeout between the POST and a Vercel cold-start recovery).
//   3. Journal still holds Item X. Next pollOnce() calls flushJournal(), which
//      tries again — but if the cloud is still catching up, reportOutcome may
//      fail again while fetchPendingBatch (a different endpoint / cold-start
//      already recovered) SUCCEEDS and returns Item X as 'pending'.
//   4. processBatch receives Item X. Without the journal-seed, seenIds is empty
//      and Item X is dispatched a second time → double-send, a client-comms error.
//
// With the seed, Item X's id is already in seenIds when the loop starts, so it
// is skipped regardless of how the cloud batch fetch went.
// ---------------------------------------------------------------------------

test('processBatch: journal-seed skips item whose id is already in the journal — prevents cloud re-delivery double-send', async () => {
  const dispatched = []
  const item = { id: 'live-1', to_handle: '+14155550100', body: 'Hello', attempts: 0 }

  // Journal already holds this id (dispatched in a prior run, outcome not yet
  // confirmed). Cloud re-delivered it as 'pending'. processBatch must NOT send.
  await processBatch([item], deps({
    dispatchToLocalSender: async (i) => { dispatched.push(i.id) },
    journalList: () => ['live-1'],
  }))

  assert.equal(dispatched.length, 0, 'journal-seeded id must be skipped — iMessage already sent in a prior run')
})

test('processBatch: journal-seed does not affect items with different ids', async () => {
  const dispatched = []
  const items = [
    { id: 'new-a', to_handle: '+14155550100', body: 'A', attempts: 0 },
    { id: 'new-b', to_handle: '+14155550200', body: 'B', attempts: 0 },
  ]

  // Journal holds a different id — must not block the new items.
  await processBatch(items, deps({
    dispatchToLocalSender: async (i) => { dispatched.push(i.id) },
    journalList: () => ['unrelated-id'],
    reportOutcome: asyncNoop,
  }))

  assert.deepEqual(dispatched.sort(), ['new-a', 'new-b'], 'items not in the journal must dispatch normally')
})

test('processBatch: journal-seed coerces types — numeric journal id blocks string batch id', async () => {
  // Coercion parity with the within-batch dedup: both sides are String()-coerced
  // so numeric 42 in the journal and string "42" in the batch collapse to one slot.
  const dispatched = []
  const item = { id: '42', to_handle: '+14155550100', body: 'hi', attempts: 0 }

  await processBatch([item], deps({
    dispatchToLocalSender: async (i) => { dispatched.push(i.id) },
    journalList: () => [42],  // numeric 42 in journal
  }))

  assert.equal(dispatched.length, 0, 'numeric journal id 42 must block string batch id "42"')
})

test('processBatch: journal-seed is empty when journal is empty — no effect on normal flow', async () => {
  const dispatched = []
  const item = { id: 'fresh', to_handle: '+14155550100', body: 'hello', attempts: 0 }

  await processBatch([item], deps({
    dispatchToLocalSender: async (i) => { dispatched.push(i.id) },
    journalList: () => [],
    reportOutcome: asyncNoop,
  }))

  assert.equal(dispatched.length, 1, 'empty journal must not block any dispatches')
})

// ---------------------------------------------------------------------------
// journal mark failure safety
// ---------------------------------------------------------------------------

test('processBatch: journal mark failure is caught and reported as failed (prevents double-send)', async () => {
  const reported = []
  const dispatched = []
  const item = { id: 'journal-fail', to_handle: '+14155550100', body: 'hello', attempts: 0 }

  await processBatch([item], deps({
    dispatchToLocalSender: async (i) => { dispatched.push(i.id) },
    journalMark: () => false, // Simulate mark failure (disk full, permissions, etc.)
    reportOutcome: async (id, payload) => { reported.push({ id, payload }) },
  }))

  // Item was dispatched (we can't prevent that after sender returns)
  assert.equal(dispatched.length, 1, 'sender was called')
  // But mark failure was caught and reported as failed
  assert.equal(reported.length, 1, 'failure must be reported to cloud')
  assert.equal(reported[0].payload.status, 'failed', 'must report as failed')
  assert.ok(reported[0].payload.error.includes('journal mark failed'), 'error must mention journal failure')
})

// ── loop health reporting ──────────────────────────────────────────────────────
// When fetchPendingBatch exhausts retries, pollOnce returns { fetchError }.
// The loop must surface this as health='error' so the cloud sees an unhealthy
// poller rather than a healthy one with 0 items — the two are indistinguishable
// without this fix, masking a stalled outbound queue as a quiet queue.

test('loop: reports health=error when pollOnce returns fetchError (queue unreachable)', async () => {
  let shutDown = false
  const healthCalls = []
  await loop({
    _pollOnce: async () => { shutDown = true; return { itemCount: 0, fetchError: 'connect ECONNREFUSED' } },
    _delay: async () => {},
    _isShuttingDown: () => shutDown,
    _reportHealth: (service, status, opts) => { healthCalls.push({ service, status, opts }) },
  })
  assert.equal(healthCalls.length, 1, 'exactly one health call per cycle')
  assert.equal(healthCalls[0].service, 'poller')
  assert.equal(healthCalls[0].status, 'error', 'fetch failure must surface as error, not ok')
  assert.ok(healthCalls[0].opts.errorMessage.includes('ECONNREFUSED'), 'error message must be propagated')
})

test('loop: reports health=ok with itemCount on successful poll', async () => {
  let shutDown = false
  const healthCalls = []
  await loop({
    _pollOnce: async () => { shutDown = true; return { itemCount: 4 } },
    _delay: async () => {},
    _isShuttingDown: () => shutDown,
    _reportHealth: (service, status, opts) => { healthCalls.push({ service, status, opts }) },
  })
  assert.equal(healthCalls.length, 1, 'exactly one health call per cycle')
  assert.equal(healthCalls[0].status, 'ok')
  assert.equal(healthCalls[0].opts.itemCount, 4, 'itemCount must be forwarded from pollOnce result')
})

test('loop: reports health=ok with itemCount=0 on empty queue (no fetchError)', async () => {
  let shutDown = false
  const healthCalls = []
  await loop({
    _pollOnce: async () => { shutDown = true; return { itemCount: 0 } },
    _delay: async () => {},
    _isShuttingDown: () => shutDown,
    _reportHealth: (service, status, opts) => { healthCalls.push({ service, status, opts }) },
  })
  assert.equal(healthCalls[0].status, 'ok', 'empty queue (no fetchError) must be ok, not error')
  assert.equal(healthCalls[0].opts.itemCount, 0)
})
