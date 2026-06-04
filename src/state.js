'use strict'

/**
 * Persistent scan state (state.json).
 *
 * saveState uses an atomic write (write temp + rename) so a mid-write crash
 * cannot leave a partial/corrupt state.json. Without this, a crash during
 * writeFileSync produces invalid JSON; the next run's JSON.parse fails
 * silently (caught by loadState), resets last_rowid to 0, and re-ingests
 * every message from the beginning — duplicate delivery to pugs-sales.
 */

const fs   = require('fs')

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return { last_rowid: 0 }
  }
}

function saveState(statePath, state) {
  const tmp = statePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, statePath)
}

module.exports = { loadState, saveState }
