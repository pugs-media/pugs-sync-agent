/**
 * Pugs Sync Agent — SQLite snapshot helper (filesystem only, no DB engine).
 *
 * The scanner can't query ~/Library/Messages/chat.db in place — Messages.app
 * holds it open — so it copies the file to a temp path and opens the copy
 * read-only. The catch: Messages.app runs chat.db in WAL journal mode, which
 * means the most recent messages are written to the `chat.db-wal` sidecar and
 * are NOT folded into the main chat.db file until a checkpoint happens. A
 * checkpoint can lag minutes-to-hours behind while the app keeps the database
 * open, so copying ONLY chat.db gives a snapshot that is missing exactly the
 * newest rows — the ones a 5-minute scan exists to catch.
 *
 * The fix is to copy the WAL sidecars (`-wal` and its shared-memory index
 * `-shm`) alongside the main file. SQLite derives a sidecar's name by appending
 * the suffix to the database path, so writing them next to the snapshot (same
 * basename) lets the read-only open replay the WAL and see those rows.
 *
 * Kept pure (only fs) so the copy/cleanup boundary is unit-testable without the
 * native better-sqlite3 dependency.
 */

'use strict'

const fs = require('fs')

// SQLite WAL sidecar suffixes, relative to the main database path.
const WAL_SUFFIXES = ['-wal', '-shm']

/**
 * Copy a SQLite database file and any present WAL sidecars to a snapshot
 * location. The main file is copied first, then each sidecar that exists, so
 * the read-only open of `destPath` sees un-checkpointed rows still in the WAL.
 *
 * If a sidecar copy fails (disk full, permission denied), throws AFTER recording
 * what was successfully written. This allows the caller to clean up any partial
 * snapshot (main + partial sidecars) without temp-file leaks.
 *
 * @param {string} srcPath  source database path (e.g. .../chat.db)
 * @param {string} destPath snapshot database path to write
 * @returns {string[]} the paths written (main file first, then any sidecars)
 * @throws error with `.writtenPath` property set to paths written before failure
 */
function snapshotSqlite(srcPath, destPath) {
  fs.copyFileSync(srcPath, destPath)
  const written = [destPath]
  for (const suffix of WAL_SUFFIXES) {
    const srcSidecar = srcPath + suffix
    if (fs.existsSync(srcSidecar)) {
      const destSidecar = destPath + suffix
      try {
        fs.copyFileSync(srcSidecar, destSidecar)
        written.push(destSidecar)
      } catch (e) {
        // Create a new error so we can attach writtenPath without worrying
        // about the original error object's structure.
        const err = new Error(`snapshot sidecar copy failed: ${e.message}`)
        err.writtenPath = written
        err.cause = e
        throw err
      }
    }
  }
  return written
}

/**
 * Best-effort removal of a snapshot and its WAL sidecars. Never throws — a
 * missing sidecar (the common case) or an already-cleaned file is fine.
 *
 * @param {string} destPath snapshot database path previously written
 */
function cleanupSnapshot(destPath) {
  for (const p of [destPath, ...WAL_SUFFIXES.map((s) => destPath + s)]) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* already gone / never existed — nothing to do */
    }
  }
}

module.exports = { WAL_SUFFIXES, snapshotSqlite, cleanupSnapshot }
