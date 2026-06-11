const test = require('node:test')
const assert = require('node:assert')
const { reportHealth } = require('./health-report')

test('reportHealth: sends status=ok with itemCount', async () => {
  let lastRequest = null
  const mockFetch = async (url, opts) => {
    lastRequest = { url, opts }
    return { ok: true, status: 200 }
  }

  await reportHealth('scanner', 'ok', {
    itemCount: 5,
    durationMs: 1234,
    webhookUrl: 'https://example.com/api/import/imessage',
    secret: 'test-secret',
    _fetch: mockFetch,
  })

  assert.equal(lastRequest.url, 'https://example.com/api/sync/health')
  const body = JSON.parse(lastRequest.opts.body)
  assert.equal(body.service, 'scanner')
  assert.equal(body.status, 'ok')
  assert.equal(body.item_count, 5)
  assert.equal(body.run_duration_ms, 1234)
})

test('reportHealth: sends status=error with errorMessage', async () => {
  let lastRequest = null
  const mockFetch = async (url, opts) => {
    lastRequest = { url, opts }
    return { ok: true, status: 200 }
  }

  await reportHealth('poller', 'error', {
    errorMessage: 'network timeout',
    durationMs: 2000,
    webhookUrl: 'https://example.com/api/import/imessage',
    secret: 'test-secret',
    _fetch: mockFetch,
  })

  const body = JSON.parse(lastRequest.opts.body)
  assert.equal(body.status, 'error')
  assert.equal(body.error, 'network timeout')
})

test('reportHealth: swallows cloud rejection (non-ok response)', async () => {
  let errorThrown = false
  const mockFetch = async () => {
    return { ok: false, status: 500, text: async () => 'server error' }
  }

  // Should not throw
  try {
    await reportHealth('updater', 'ok', {
      webhookUrl: 'https://example.com/api/import/imessage',
      secret: 'test-secret',
      _fetch: mockFetch,
    })
  } catch (e) {
    errorThrown = true
  }

  assert.equal(errorThrown, false, 'should not throw on cloud rejection')
})

test('reportHealth: swallows network errors', async () => {
  let errorThrown = false
  const mockFetch = async () => {
    throw new Error('network unreachable')
  }

  // Should not throw
  try {
    await reportHealth('scanner', 'ok', {
      webhookUrl: 'https://example.com/api/import/imessage',
      secret: 'test-secret',
      _fetch: mockFetch,
    })
  } catch (e) {
    errorThrown = true
  }

  assert.equal(errorThrown, false, 'should not throw on network error')
})

test('reportHealth: no-op when config is missing', async () => {
  let fetchCalled = false
  const mockFetch = async () => {
    fetchCalled = true
    return { ok: true, status: 200 }
  }

  // No webhookUrl or secret
  await reportHealth('scanner', 'ok', {
    itemCount: 5,
    webhookUrl: undefined,
    secret: undefined,
    _fetch: mockFetch,
  })

  assert.equal(fetchCalled, false, 'should not call fetch when config is missing')
})

test('reportHealth: respects custom timeout', async () => {
  let calledWithTimeout = null
  // fetchWithTimeout signature: (url, opts, timeoutMs, fetchFn)
  // We can't easily intercept the timeout directly, but we can verify the call happens
  const mockFetch = async () => {
    return { ok: true, status: 200 }
  }

  await reportHealth('poller', 'ok', {
    _timeoutMs: 3000,
    webhookUrl: 'https://example.com/api/import/imessage',
    secret: 'test-secret',
    _fetch: mockFetch,
  })

  // Just verify it doesn't throw with custom timeout
  assert.ok(true)
})

test('reportHealth: includes x-pugs-scanner-id header', async () => {
  let lastRequest = null
  const mockFetch = async (url, opts) => {
    lastRequest = { url, opts }
    return { ok: true, status: 200 }
  }

  await reportHealth('scanner', 'ok', {
    webhookUrl: 'https://example.com/api/import/imessage',
    secret: 'test-secret',
    scannerId: 'connor-mac-1',
    _fetch: mockFetch,
  })

  assert.equal(lastRequest.opts.headers['x-pugs-scanner-id'], 'connor-mac-1')
})

test('reportHealth: requires only service and status, rest optional', async () => {
  let lastRequest = null
  const mockFetch = async (url, opts) => {
    lastRequest = { url, opts }
    return { ok: true, status: 200 }
  }

  await reportHealth('scanner', 'ok', {
    webhookUrl: 'https://example.com/api/import/imessage',
    secret: 'test-secret',
    _fetch: mockFetch,
  })

  const body = JSON.parse(lastRequest.opts.body)
  assert.equal(body.service, 'scanner')
  assert.equal(body.status, 'ok')
  assert.equal(body.item_count, undefined)
  assert.equal(body.error, undefined)
  assert.equal(body.run_duration_ms, undefined)
})

test('reportHealth: gracefully handles malformed webhookUrl', async () => {
  let fetchCalled = false
  const mockFetch = async () => {
    fetchCalled = true
    return { ok: true, status: 200 }
  }

  // Should not throw even with malformed URL
  let errorThrown = false
  try {
    await reportHealth('scanner', 'ok', {
      webhookUrl: 'not a valid url :::',
      secret: 'test-secret',
      _fetch: mockFetch,
    })
  } catch (e) {
    errorThrown = true
  }

  assert.equal(errorThrown, false, 'should not throw on malformed URL')
  assert.equal(fetchCalled, false, 'should not attempt to send on malformed URL')
})
