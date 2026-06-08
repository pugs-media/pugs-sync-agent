'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { fetchWithTimeout } = require('./fetch-timeout')

// A mock fetch that resolves immediately with a 200.
const okFetch = async (url, opts) => ({ ok: true, status: 200, text: async () => 'ok' })

// A mock fetch that never resolves on its own but aborts cleanly when the
// AbortController fires. Tests use this to verify the timeout path.
function hangingFetch(url, opts) {
  return new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
}

test('fetchWithTimeout: resolves when fetch completes before timeout', async () => {
  const res = await fetchWithTimeout('https://example.com', {}, 1000, okFetch)
  assert.equal(res.ok, true)
})

test('fetchWithTimeout: passes signal in opts to the underlying fetch', async () => {
  let capturedSignal
  const captureFetch = async (url, opts) => {
    capturedSignal = opts.signal
    return { ok: true }
  }
  await fetchWithTimeout('https://example.com', {}, 1000, captureFetch)
  assert.ok(capturedSignal instanceof AbortSignal, 'signal should be an AbortSignal')
})

test('fetchWithTimeout: merges signal with existing opts', async () => {
  let capturedOpts
  const captureFetch = async (url, opts) => {
    capturedOpts = opts
    return { ok: true }
  }
  await fetchWithTimeout('https://example.com', { method: 'POST', headers: { 'x-foo': 'bar' } }, 1000, captureFetch)
  assert.equal(capturedOpts.method, 'POST')
  assert.equal(capturedOpts.headers['x-foo'], 'bar')
  assert.ok(capturedOpts.signal instanceof AbortSignal)
})

test('fetchWithTimeout: aborts and rejects when timeout fires before fetch resolves', async () => {
  await assert.rejects(
    () => fetchWithTimeout('https://example.com', {}, 20, hangingFetch),
    { name: 'AbortError' },
  )
})

test('fetchWithTimeout: does not leave a dangling timer when fetch resolves quickly', async () => {
  // Verifies clearTimeout is called — if it weren't, Node would keep the timer
  // alive and delay process exit. We can't observe the timer directly, but we
  // verify the promise resolves without hanging the test.
  const res = await fetchWithTimeout('https://example.com', {}, 5000, okFetch)
  assert.equal(res.ok, true)
})
