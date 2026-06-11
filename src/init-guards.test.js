'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execSync } = require('child_process')
const path = require('path')

const SEND_JS = path.join(__dirname, 'send.js')
const POLL_JS = path.join(__dirname, 'poll.js')
const SCAN_JS = path.join(__dirname, 'scan.js')

// ── send.js: missing PUGS_SYNC_SECRET ────────────────────────────────────

test('send.js: exits with code 2 when PUGS_SYNC_SECRET is missing', () => {
  const env = { ...process.env }
  delete env.PUGS_SYNC_SECRET

  try {
    execSync(`node ${SEND_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected send.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `send.js must exit with code 2 on missing PUGS_SYNC_SECRET, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Missing PUGS_SYNC_SECRET'),
      'stderr must mention missing PUGS_SYNC_SECRET'
    )
  }
})

// ── poll.js: missing PUGS_SYNC_WEBHOOK_URL ──────────────────────────────

test('poll.js: exits with code 2 when PUGS_SYNC_WEBHOOK_URL is missing', () => {
  const env = { ...process.env }
  delete env.PUGS_SYNC_WEBHOOK_URL

  try {
    execSync(`node ${POLL_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected poll.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `poll.js must exit with code 2 on missing PUGS_SYNC_WEBHOOK_URL, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Missing PUGS_SYNC_WEBHOOK_URL'),
      'stderr must mention missing PUGS_SYNC_WEBHOOK_URL'
    )
  }
})

test('poll.js: exits with code 2 when PUGS_SYNC_SECRET is missing', () => {
  const env = { ...process.env }
  delete env.PUGS_SYNC_SECRET

  try {
    execSync(`node ${POLL_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected poll.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `poll.js must exit with code 2 on missing PUGS_SYNC_SECRET, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Missing PUGS_SYNC_WEBHOOK_URL'),
      'stderr must mention missing secret (or webhook URL if secret check comes after)'
    )
  }
})

// ── scan.js: missing PUGS_SYNC_WEBHOOK_URL ──────────────────────────────

test('scan.js: exits with code 2 when PUGS_SYNC_WEBHOOK_URL is missing', () => {
  const env = { ...process.env }
  delete env.PUGS_SYNC_WEBHOOK_URL

  try {
    execSync(`node ${SCAN_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected scan.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `scan.js must exit with code 2 on missing PUGS_SYNC_WEBHOOK_URL, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Missing PUGS_SYNC_WEBHOOK_URL'),
      'stderr must mention missing PUGS_SYNC_WEBHOOK_URL'
    )
  }
})

test('scan.js: exits with code 2 when PUGS_SYNC_SECRET is missing', () => {
  const env = { ...process.env }
  delete env.PUGS_SYNC_SECRET

  try {
    execSync(`node ${SCAN_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected scan.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `scan.js must exit with code 2 on missing PUGS_SYNC_SECRET, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Missing PUGS_SYNC_WEBHOOK_URL'),
      'stderr must mention missing secret (or webhook URL if secret check comes after)'
    )
  }
})

// ── poll.js: malformed PUGS_SYNC_WEBHOOK_URL ────────────────────────────

test('poll.js: exits with code 2 when PUGS_SYNC_WEBHOOK_URL is malformed', () => {
  const env = { ...process.env }
  env.PUGS_SYNC_WEBHOOK_URL = 'not a valid url'
  env.PUGS_SYNC_SECRET = 'test-secret'

  try {
    execSync(`node ${POLL_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected poll.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `poll.js must exit with code 2 on malformed PUGS_SYNC_WEBHOOK_URL, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Invalid PUGS_SYNC_WEBHOOK_URL'),
      'stderr must mention invalid webhook URL'
    )
  }
})

test('scan.js: exits with code 2 when PUGS_SYNC_WEBHOOK_URL is malformed', () => {
  const env = { ...process.env }
  env.PUGS_SYNC_WEBHOOK_URL = 'not a valid url'
  env.PUGS_SYNC_SECRET = 'test-secret'

  try {
    execSync(`node ${SCAN_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected scan.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `scan.js must exit with code 2 on malformed PUGS_SYNC_WEBHOOK_URL, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Invalid PUGS_SYNC_WEBHOOK_URL'),
      'stderr must mention invalid webhook URL'
    )
  }
})

// ── send.js: invalid SENDER_PORT ────────────────────────────────────────

test('send.js: exits with code 2 when SENDER_PORT is not a valid port number', () => {
  const env = { ...process.env }
  env.SENDER_PORT = 'not-a-port'
  env.PUGS_SYNC_SECRET = 'test-secret'

  try {
    execSync(`node ${SEND_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected send.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `send.js must exit with code 2 on invalid SENDER_PORT, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Invalid SENDER_PORT'),
      'stderr must mention invalid SENDER_PORT'
    )
  }
})

test('send.js: exits with code 2 when SENDER_PORT is out of range (0)', () => {
  const env = { ...process.env }
  env.SENDER_PORT = '0'
  env.PUGS_SYNC_SECRET = 'test-secret'

  try {
    execSync(`node ${SEND_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected send.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `send.js must exit with code 2 on port 0, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Invalid SENDER_PORT'),
      'stderr must mention invalid SENDER_PORT'
    )
  }
})

test('send.js: exits with code 2 when SENDER_PORT is out of range (>65535)', () => {
  const env = { ...process.env }
  env.SENDER_PORT = '99999'
  env.PUGS_SYNC_SECRET = 'test-secret'

  try {
    execSync(`node ${SEND_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected send.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `send.js must exit with code 2 on port >65535, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Invalid SENDER_PORT'),
      'stderr must mention invalid SENDER_PORT'
    )
  }
})

// ── poll.js: invalid SENDER_PORT ────────────────────────────────────────

test('poll.js: exits with code 2 when SENDER_PORT is not a valid port number', () => {
  const env = { ...process.env }
  env.SENDER_PORT = 'not-a-port'
  env.PUGS_SYNC_WEBHOOK_URL = 'https://example.com/api/import/imessage'
  env.PUGS_SYNC_SECRET = 'test-secret'

  try {
    execSync(`node ${POLL_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected poll.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `poll.js must exit with code 2 on invalid SENDER_PORT, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Invalid SENDER_PORT'),
      'stderr must mention invalid SENDER_PORT'
    )
  }
})

test('poll.js: exits with code 2 when SENDER_PORT is out of range (65536)', () => {
  const env = { ...process.env }
  env.SENDER_PORT = '65536'
  env.PUGS_SYNC_WEBHOOK_URL = 'https://example.com/api/import/imessage'
  env.PUGS_SYNC_SECRET = 'test-secret'

  try {
    execSync(`node ${POLL_JS}`, { env, timeout: 5000, stdio: 'pipe' })
    assert.fail('Expected poll.js to exit with code 2, but it did not exit with error')
  } catch (e) {
    assert.equal(
      e.status, 2,
      `poll.js must exit with code 2 on port >65535, got code ${e.status}`
    )
    assert.ok(
      e.stderr?.toString().includes('Invalid SENDER_PORT'),
      'stderr must mention invalid SENDER_PORT'
    )
  }
})
