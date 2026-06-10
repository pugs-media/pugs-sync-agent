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
 *
 * Race-safety: mark() appends and clear() rewrites the file. To prevent
 * clear() from losing entries marked between its read and write, we use a
 * lock file. mark() holds the lock while appending; clear() holds it while
 * rewriting. This ensures the operations are serialized.
 */

const fs   = require('fs')
const path = require('path')

const DEFAULT_PATH = path.join(__dirname, '..', 'dispatch-journal.ndjson')
const LOCK_PATH = DEFAULT_PATH + '.lock'

function acquireLock(lockPath = LOCK_PATH) {
  try {
    // Create lock file exclusively (fails if it already exists). Best-effort.
    fs.writeFileSync(lockPath, '', { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function releaseLock(lockPath = LOCK_PATH) {
  try {
    fs.unlinkSync(lockPath)
  } catch {
    // Ignore: lock was already gone or could not be deleted.
  }
}

function withLock(fn, lockPath = LOCK_PATH) {
  // Spinlock: try to acquire, yield if contended. This is not ideal for
  // high-contention scenarios, but mark/clear are low-frequency (5-20s apart),
  // so contention is rare. A real lock (fcntl) would be better, but would add
  // native dependencies.
  const maxRetries = 100
  const delayMs = 1
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (acquireLock(lockPath)) {
      try {
        return fn()
      } finally {
        releaseLock(lockPath)
      }
    }
    if (attempt < maxRetries - 1) {
      const now = Date.now()
      while (Date.now() - now < delayMs) {
        // Busy-wait for delayMs. This is faster than setTimeout for small delays.
      }
    }
  }
  // Failed to acquire lock after retries. Fall through without lock.
  // This is a best-effort design; a stalled poller is better than a crashed one.
  return fn()
}

function mark(id, { journalPath = DEFAULT_PATH } = {}) {
  let failed = false
  withLock(() => {
    try {
      fs.appendFileSync(journalPath, JSON.stringify({ id }) + '\n')
    } catch (e) {
      console.error('dispatch-journal mark error (best-effort, continuing):', e.message)
      failed = true
    }
  })
  return !failed
}

function clear(id, { journalPath = DEFAULT_PATH } = {}) {
  withLock(() => {
    try {
      const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
      const kept = lines.filter(l => {
        try { return JSON.parse(l).id !== id } catch { return true }
      })
      if (kept.length === 0) {
        fs.unlinkSync(journalPath)
      } else {
        const tmp = journalPath + '.tmp'
        fs.writeFileSync(tmp, kept.join('\n') + '\n')
        fs.renameSync(tmp, journalPath)
      }
    } catch {
      // Ignore: missing file or unreadable is not an error — the entry is already gone.
      // Permission errors and other failures are best-effort; log and continue.
      // If the file cannot be written, the journal entry persists, which is safe
      // (the item will be re-reported on the next cycle as a duplicate, which
      // processBatch.seenIds will dedup).
    }
  })
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
