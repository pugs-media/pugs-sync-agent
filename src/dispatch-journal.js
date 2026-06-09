'use strict'

/**
 * Dispatch journal — crash-safe record that an iMessage was sent but its
 * outcome has not yet been confirmed to the cloud.
 *
 * The poller marks an item ID AFTER dispatchToLocalSender succeeds and clears
 * it AFTER reportOutcome completes. On startup, pollOnce flushes any IDs left
 * in the journal (they were dispatched in a prior run that crashed before the
 * cloud could be notified) so the cloud outcome is reported without re-sending.
 *
 * File format: newline-delimited JSON, one { id } object per line.
 * Writes are best-effort — errors are logged but never propagate so a disk-full
 * or permissions error cannot crash the poller.
 */

const fs   = require('fs')
const path = require('path')

const DEFAULT_PATH = path.join(__dirname, '..', 'dispatch-journal.ndjson')

function mark(id, { journalPath = DEFAULT_PATH } = {}) {
  try {
    fs.appendFileSync(journalPath, JSON.stringify({ id }) + '\n')
  } catch (e) {
    console.error('dispatch-journal mark error (best-effort, continuing):', e.message)
  }
}

function clear(id, { journalPath = DEFAULT_PATH } = {}) {
  let lines
  try {
    lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return
  }
  const kept = lines.filter(l => {
    try { return JSON.parse(l).id !== id } catch { return true }
  })
  try {
    if (kept.length === 0) {
      fs.unlinkSync(journalPath)
    } else {
      const tmp = journalPath + '.tmp'
      fs.writeFileSync(tmp, kept.join('\n') + '\n')
      fs.renameSync(tmp, journalPath)
    }
  } catch (e) {
    console.error('dispatch-journal clear error (best-effort, continuing):', e.message)
  }
}

function list({ journalPath = DEFAULT_PATH } = {}) {
  try {
    return fs.readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l).id } catch { return null } })
      .filter(id => id !== null)
  } catch {
    return []
  }
}

module.exports = { mark, clear, list, DEFAULT_PATH }
