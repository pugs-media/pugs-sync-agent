'use strict'

// set env before requiring send.js so the module-level SECRET read doesn't fail
process.env.PUGS_SYNC_SECRET = 'test-secret'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createApp } = require('./send')

const TEST_SECRET = 'test-secret'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpRequest(server, { method = 'POST', path = '/send', secret = TEST_SECRET, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address()
    const payload = body != null ? JSON.stringify(body) : null
    const headers = {
      'Content-Type': 'application/json',
      ...(secret != null ? { 'x-pugs-sync-secret': secret } : {}),
      ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function withServer(deps, fn) {
  const app = createApp({ secret: TEST_SECRET, ...deps })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  try {
    await fn(server)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

// Minimal mock dependencies
function okExecFile(_cmd, _args, _opts, cb) { cb(null, 'ok', '') }
function errExecFile(_cmd, _args, _opts, cb) { cb(new Error('osascript timeout'), '', 'timeout') }
function okParse() { return { ok: true } }
function failParse() { return { ok: false, detail: 'AppleScript error -1728: no buddy' } }
function stubScript() { return 'tell application "Messages" to ...' }

function defaultDeps(overrides = {}) {
  return { execFile: okExecFile, buildSendScript: stubScript, parseOsascriptResult: okParse, ...overrides }
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

test('/health: returns { ok: true }', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { method: 'GET', path: '/health' })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
  })
})

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

test('auth: missing secret header returns 401', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { secret: null, body: { to: '+1415', text: 'hi' } })
    assert.equal(res.status, 401)
    assert.match(res.body.error, /unauthorized/)
  })
})

test('auth: wrong secret returns 401', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { secret: 'wrong-secret', body: { to: '+1415', text: 'hi' } })
    assert.equal(res.status, 401)
    assert.match(res.body.error, /unauthorized/)
  })
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('POST /send: missing "to" field returns 400', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { body: { text: 'hi' } })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /to and text required/)
  })
})

test('POST /send: missing "text" field returns 400', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { body: { to: '+1415' } })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /to and text required/)
  })
})

test('POST /send: empty body returns 400', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { body: {} })
    assert.equal(res.status, 400)
  })
})

test('POST /send: numeric "to" returns 400 (must be string)', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { body: { to: 14155550100, text: 'hi' } })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /strings/)
  })
})

test('POST /send: numeric "text" returns 400 (must be string)', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { body: { to: '+1415', text: 42 } })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /strings/)
  })
})

// ---------------------------------------------------------------------------
// Successful send
// ---------------------------------------------------------------------------

test('POST /send: successful send returns { ok, to, service }', async () => {
  await withServer(defaultDeps(), async server => {
    const res = await httpRequest(server, { body: { to: '+14155550100', text: 'Hello!' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.to, '+14155550100')
    assert.equal(res.body.service, 'iMessage')
  })
})

test('POST /send: service defaults to iMessage when omitted', async () => {
  let capturedService
  await withServer(defaultDeps({
    buildSendScript: ({ service }) => { capturedService = service; return 'script' },
  }), async server => {
    await httpRequest(server, { body: { to: '+1415', text: 'hi' } })
    assert.equal(capturedService, 'iMessage')
  })
})

test('POST /send: service=SMS is forwarded to buildSendScript and response', async () => {
  let capturedService
  await withServer(defaultDeps({
    buildSendScript: ({ service }) => { capturedService = service; return 'script' },
  }), async server => {
    const res = await httpRequest(server, { body: { to: '+1415', text: 'hi', service: 'SMS' } })
    assert.equal(capturedService, 'SMS')
    assert.equal(res.body.service, 'SMS')
  })
})

test('POST /send: unknown service is coerced to iMessage', async () => {
  let capturedService
  await withServer(defaultDeps({
    buildSendScript: ({ service }) => { capturedService = service; return 'script' },
  }), async server => {
    await httpRequest(server, { body: { to: '+1415', text: 'hi', service: 'Carrier Pigeon' } })
    assert.equal(capturedService, 'iMessage')
  })
})

test('POST /send: buildSendScript receives correct to, text, service', async () => {
  const captured = {}
  await withServer(defaultDeps({
    buildSendScript: (args) => { Object.assign(captured, args); return 'script' },
  }), async server => {
    await httpRequest(server, { body: { to: '+14155550100', text: 'Test msg', service: 'iMessage' } })
    assert.equal(captured.to, '+14155550100')
    assert.equal(captured.text, 'Test msg')
    assert.equal(captured.service, 'iMessage')
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('POST /send: osascript process error returns 500 with detail', async () => {
  await withServer(defaultDeps({ execFile: errExecFile }), async server => {
    const res = await httpRequest(server, { body: { to: '+1415', text: 'hi' } })
    assert.equal(res.status, 500)
    assert.equal(res.body.error, 'send failed')
    assert.match(res.body.detail, /timeout/)
  })
})

test('POST /send: osascript parse failure returns 500 with AppleScript detail', async () => {
  await withServer(defaultDeps({ parseOsascriptResult: failParse }), async server => {
    const res = await httpRequest(server, { body: { to: '+1415', text: 'hi' } })
    assert.equal(res.status, 500)
    assert.equal(res.body.error, 'send failed')
    assert.match(res.body.detail, /-1728/)
  })
})
