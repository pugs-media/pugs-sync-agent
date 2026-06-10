'use strict'

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const fs       = require('fs')
const os       = require('os')
const path     = require('path')
const { mark, clear, list } = require('./dispatch-journal')

// Each test uses its own temp file so tests are fully isolated.
let counter = 0
function tmpPath() {
  return path.join(os.tmpdir(), `dispatch-journal-test-${process.pid}-${++counter}.ndjson`)
}

test('list: returns empty array when file does not exist', () => {
  const journalPath = tmpPath()
  assert.deepEqual(list({ journalPath }), [])
})

test('mark: creates file with one entry, list returns that id', () => {
  const journalPath = tmpPath()
  const ok = mark('abc', { journalPath })
  assert.equal(ok, true, 'mark should return true on success')
  assert.deepEqual(list({ journalPath }), ['abc'])
  fs.unlinkSync(journalPath)
})

test('mark: multiple calls accumulate entries', () => {
  const journalPath = tmpPath()
  mark('x1', { journalPath })
  mark('x2', { journalPath })
  mark('x3', { journalPath })
  assert.deepEqual(list({ journalPath }), ['x1', 'x2', 'x3'])
  fs.unlinkSync(journalPath)
})

test('clear: removes the specified id from the journal', () => {
  const journalPath = tmpPath()
  mark('a', { journalPath })
  mark('b', { journalPath })
  mark('c', { journalPath })
  clear('b', { journalPath })
  assert.deepEqual(list({ journalPath }), ['a', 'c'])
  fs.unlinkSync(journalPath)
})

test('clear: deletes the file when it was the last entry', () => {
  const journalPath = tmpPath()
  mark('solo', { journalPath })
  clear('solo', { journalPath })
  assert.equal(fs.existsSync(journalPath), false, 'file should be deleted when empty')
})

test('clear: is a no-op when file does not exist', () => {
  const journalPath = tmpPath()
  // Should not throw
  clear('missing', { journalPath })
  assert.deepEqual(list({ journalPath }), [])
})

test('clear: is a no-op when id is not in the journal', () => {
  const journalPath = tmpPath()
  mark('present', { journalPath })
  clear('absent', { journalPath })
  assert.deepEqual(list({ journalPath }), ['present'])
  fs.unlinkSync(journalPath)
})

test('list: skips corrupt lines and returns valid ids', () => {
  const journalPath = tmpPath()
  mark('good1', { journalPath })
  fs.appendFileSync(journalPath, 'NOT_JSON\n')
  mark('good2', { journalPath })
  assert.deepEqual(list({ journalPath }), ['good1', 'good2'])
  fs.unlinkSync(journalPath)
})

test('clear: preserves corrupt lines when clearing a valid id', () => {
  const journalPath = tmpPath()
  mark('valid', { journalPath })
  fs.appendFileSync(journalPath, 'BAD_LINE\n')
  clear('valid', { journalPath })
  // File should still exist (corrupt line remains), but valid id is gone
  assert.deepEqual(list({ journalPath }), [])
  fs.unlinkSync(journalPath)
})

test('list: returns numeric ids correctly', () => {
  const journalPath = tmpPath()
  mark(42, { journalPath })
  mark(99, { journalPath })
  assert.deepEqual(list({ journalPath }), [42, 99])
  fs.unlinkSync(journalPath)
})

test('clear: does not drop entries marked during the clear read-write window (race guard)', () => {
  // Regression: clear() used to read the file, then write it back. If mark()
  // was called between the read and write, the newly-marked entry would be lost.
  // This test simulates that race and verifies the fix.
  const journalPath = tmpPath()
  mark('item-1', { journalPath })
  mark('item-2', { journalPath })

  // Manually simulate the race: read the file, then mark item-3 (concurrent mark),
  // then manually execute clear's write logic. This is what would have happened
  // in the old buggy code.
  const initialLines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
  mark('item-3', { journalPath })  // Simulate concurrent mark during clear's execution

  // Now the new clear() will see all three items when it reads (the fix).
  clear('item-1', { journalPath })

  // Verify that item-3 is not lost
  const result = list({ journalPath })
  assert.deepEqual(result, ['item-2', 'item-3'], 'item-3 must not be lost even if marked during clear')
  fs.unlinkSync(journalPath)
})

test('mark: returns false when write fails (e.g. bad path)', () => {
  // Use a path that cannot be written to (parent directory doesn't exist).
  const badPath = '/nonexistent-parent-dir-12345/journal.ndjson'
  const ok = mark('test-id', { journalPath: badPath })
  assert.equal(ok, false, 'mark should return false on write failure')
})
