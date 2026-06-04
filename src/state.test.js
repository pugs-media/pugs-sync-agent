'use strict'

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs   = require('fs')
const os   = require('os')
const path = require('path')

const { loadState, saveState } = require('./state')

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pugs-state-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function statePath() { return path.join(dir, 'state.json') }

// ── loadState ────────────────────────────────────────────────────────────────

test('loadState: returns { last_rowid: 0 } when file does not exist', () => {
  assert.deepEqual(loadState(statePath()), { last_rowid: 0 })
})

test('loadState: returns parsed content of a valid state file', () => {
  const p = statePath()
  fs.writeFileSync(p, JSON.stringify({ last_rowid: 42, last_run_at: '2026-01-01T00:00:00.000Z' }))
  assert.deepEqual(loadState(p), { last_rowid: 42, last_run_at: '2026-01-01T00:00:00.000Z' })
})

test('loadState: returns { last_rowid: 0 } when file contains corrupt JSON (crash-partial-write)', () => {
  const p = statePath()
  fs.writeFileSync(p, '{"last_rowid": 99, "last_run_')  // truncated — simulates partial write
  assert.deepEqual(loadState(p), { last_rowid: 0 })
})

test('loadState: returns { last_rowid: 0 } when file is empty', () => {
  const p = statePath()
  fs.writeFileSync(p, '')
  assert.deepEqual(loadState(p), { last_rowid: 0 })
})

// ── saveState ────────────────────────────────────────────────────────────────

test('saveState: writes valid JSON that loadState can round-trip', () => {
  const p = statePath()
  const state = { last_rowid: 123, last_run_at: '2026-06-01T12:00:00.000Z' }
  saveState(p, state)
  assert.deepEqual(loadState(p), state)
})

test('saveState: leaves no .tmp file after a successful write', () => {
  const p = statePath()
  saveState(p, { last_rowid: 7 })
  assert.equal(fs.existsSync(p + '.tmp'), false, '.tmp file should not remain after save')
})

test('saveState: overwrites an existing state file', () => {
  const p = statePath()
  saveState(p, { last_rowid: 1 })
  saveState(p, { last_rowid: 99 })
  assert.deepEqual(loadState(p), { last_rowid: 99 })
})

// ── atomicity guarantee ──────────────────────────────────────────────────────

test('saveState: a corrupt .tmp left by a prior crash does not affect loadState', () => {
  // Simulate what happens when saveState crashes between writeFileSync and renameSync:
  // the .tmp file exists but state.json was never overwritten.
  const p = statePath()
  const good = { last_rowid: 55, last_run_at: '2026-05-01T00:00:00.000Z' }
  fs.writeFileSync(p, JSON.stringify(good))
  fs.writeFileSync(p + '.tmp', '{"last_rowid": 55, "half-wri')  // corrupt leftover

  // loadState reads state.json, not the .tmp — good state is preserved
  assert.deepEqual(loadState(p), good)

  // A subsequent successful saveState clears the .tmp and writes correctly
  saveState(p, { last_rowid: 56 })
  assert.equal(fs.existsSync(p + '.tmp'), false)
  assert.deepEqual(loadState(p), { last_rowid: 56 })
})

test('saveState: state.json is valid JSON immediately after write even if .tmp existed', () => {
  const p = statePath()
  // Pre-seed a stale .tmp from a previous crash
  fs.writeFileSync(p + '.tmp', 'NOT-JSON')
  saveState(p, { last_rowid: 77 })
  const raw = fs.readFileSync(p, 'utf8')
  assert.doesNotThrow(() => JSON.parse(raw), 'state.json must be valid JSON after saveState')
  assert.equal(fs.existsSync(p + '.tmp'), false)
})
