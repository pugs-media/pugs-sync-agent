'use strict'

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { WAL_SUFFIXES, snapshotSqlite, cleanupSnapshot } = require('./snapshot')

// Each test gets its own scratch dir under tmp so runs don't collide.
let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pugs-snap-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(name, contents) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, contents)
  return p
}

// ── snapshotSqlite ───────────────────────────────────────────────────────────

test('snapshotSqlite: copies the WAL sidecars so un-checkpointed rows are visible', () => {
  const src = write('chat.db', 'MAIN')
  write('chat.db-wal', 'WAL-newest-messages')
  write('chat.db-shm', 'SHM-index')
  const dest = path.join(dir, 'snap.db')

  const written = snapshotSqlite(src, dest)

  // Main + both sidecars copied, with the basename SQLite expects (dest + suffix).
  assert.equal(fs.readFileSync(dest, 'utf8'), 'MAIN')
  assert.equal(fs.readFileSync(dest + '-wal', 'utf8'), 'WAL-newest-messages')
  assert.equal(fs.readFileSync(dest + '-shm', 'utf8'), 'SHM-index')
  assert.deepEqual(written, [dest, dest + '-wal', dest + '-shm'])
})

test('snapshotSqlite: copies just the main file when no sidecars exist (DELETE-mode DB)', () => {
  const src = write('chat.db', 'MAIN-ONLY')
  const dest = path.join(dir, 'snap.db')

  const written = snapshotSqlite(src, dest)

  assert.equal(fs.readFileSync(dest, 'utf8'), 'MAIN-ONLY')
  assert.deepEqual(written, [dest])
  for (const suffix of WAL_SUFFIXES) {
    assert.equal(fs.existsSync(dest + suffix), false, `should not create ${suffix}`)
  }
})

test('snapshotSqlite: copies the -wal even if -shm is absent (independent sidecars)', () => {
  const src = write('chat.db', 'MAIN')
  write('chat.db-wal', 'WAL')
  const dest = path.join(dir, 'snap.db')

  const written = snapshotSqlite(src, dest)

  assert.deepEqual(written, [dest, dest + '-wal'])
  assert.equal(fs.existsSync(dest + '-shm'), false)
})

// ── cleanupSnapshot ───────────────────────────────────────────────────────────

test('cleanupSnapshot: removes the snapshot and every sidecar', () => {
  const dest = path.join(dir, 'snap.db')
  fs.writeFileSync(dest, 'MAIN')
  fs.writeFileSync(dest + '-wal', 'WAL')
  fs.writeFileSync(dest + '-shm', 'SHM')

  cleanupSnapshot(dest)

  assert.equal(fs.existsSync(dest), false)
  assert.equal(fs.existsSync(dest + '-wal'), false)
  assert.equal(fs.existsSync(dest + '-shm'), false)
})

test('cleanupSnapshot: never throws when files are already gone', () => {
  const dest = path.join(dir, 'does-not-exist.db')
  assert.doesNotThrow(() => cleanupSnapshot(dest))
})

test('cleanupSnapshot: removes a partial snapshot (main present, sidecars absent)', () => {
  const dest = path.join(dir, 'snap.db')
  fs.writeFileSync(dest, 'MAIN')
  assert.doesNotThrow(() => cleanupSnapshot(dest))
  assert.equal(fs.existsSync(dest), false)
})
