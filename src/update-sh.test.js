'use strict'

const { test }         = require('node:test')
const assert           = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs               = require('fs')
const path             = require('path')

const UPDATE_SH = path.join(__dirname, '..', 'update.sh')

// ── syntax ───────────────────────────────────────────────────────────────────

test('update.sh: bash -n reports no syntax errors', () => {
  assert.doesNotThrow(
    () => execFileSync('bash', ['-n', UPDATE_SH]),
    'update.sh must be syntactically valid bash'
  )
})

// ── merge error surfacing ────────────────────────────────────────────────────

test('update.sh: git merge output is captured (not redirected to /dev/null)', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // The old form redirected to /dev/null, losing the merge reason.
  // The new form captures into a variable so the reason can be logged.
  assert.ok(
    !src.includes('git merge --ff-only origin/main >/dev/null'),
    'merge output must not be silenced with >/dev/null — merge reason must be loggable'
  )
  assert.ok(
    src.includes('git merge --ff-only origin/main 2>&1'),
    'merge output (stdout+stderr) must be captured into a variable'
  )
  assert.ok(
    src.includes('merge detail'),
    'the captured merge reason must be echoed to the log'
  )
})

// ── npm error surfacing ───────────────────────────────────────────────────────

test('update.sh: npm install does not use --silent (hides errors)', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  assert.ok(
    !src.includes('npm install --silent'),
    'npm install must not use --silent — that suppresses error output needed to diagnose deploy failures'
  )
})

test('update.sh: npm install uses --loglevel error (errors visible, noise suppressed)', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  assert.ok(
    src.includes('--loglevel error'),
    'npm install should use --loglevel error to surface install errors in the updater log'
  )
})

test('update.sh: npm install failure logs the captured npm output', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // The captured npm_out variable must be printed on failure.
  assert.ok(
    src.includes('npm_out'),
    'npm install output must be captured (npm_out) and printed on failure'
  )
})

// ── launchctl reload guard ──────────────────────────────────────────────────

test('update.sh: launchctl load failure causes exit with error code', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // If a service fails to reload, the script must exit with code 1
  // (not silently claim success with "services reloaded").
  assert.ok(
    src.includes('reload_failed'),
    'script must track reload failures in a variable'
  )
  assert.ok(
    src.includes('exit 1') && src.includes('reload_failed') && src.includes('service reload failed'),
    'script must exit with code 1 if any service reload fails'
  )
})

test('update.sh: successful reload shows clear success message', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // The final success message only appears after the reload guard passes.
  assert.ok(
    src.includes('services reloaded on $NEW_HEAD'),
    'final success message must say services are reloaded'
  )
  // Verify that the success message comes AFTER the reload guard.
  const reloadGuardIndex = src.indexOf('if [ "$reload_failed" -eq 1 ]')
  const successMsgIndex = src.indexOf('services reloaded on $NEW_HEAD')
  assert.ok(
    reloadGuardIndex < successMsgIndex,
    'success message must come after the reload_failed guard'
  )
})

test('update.sh: reload is atomic — all unload before any load', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // For atomicity, all three services must be unloaded BEFORE any are loaded.
  // This prevents a partially-updated state if a load fails mid-way.
  const firstUnloadIndex = src.indexOf('launchctl unload')
  const firstLoadIndex = src.indexOf('launchctl load "$dst"', firstUnloadIndex)
  const lastUnloadIndex = src.lastIndexOf('launchctl unload')
  assert.ok(
    lastUnloadIndex < firstLoadIndex,
    'all launchctl unload calls must come before any launchctl load calls'
  )
})

test('update.sh: reload failure triggers rollback to OLD_HEAD', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // If any service fails to load, the script must rollback by:
  // 1. git reset --hard $OLD_HEAD
  // 2. npm install
  // 3. launchctl load all services from old code
  assert.ok(
    src.includes('git reset --hard "$OLD_HEAD"'),
    'rollback must reset code to OLD_HEAD'
  )
  assert.ok(
    src.includes('ROLLBACK FAILED') || src.includes('ROLLBACK SUCCESS'),
    'rollback outcome must be logged clearly'
  )
  // Verify rollback happens inside the reload_failed guard
  const reloadFailedGuardStart = src.indexOf('if [ "$reload_failed" -eq 1 ]')
  const resetStart = src.indexOf('git reset --hard "$OLD_HEAD"')
  const reloadFailedGuardEnd = src.indexOf('exit 1', reloadFailedGuardStart)
  assert.ok(
    reloadFailedGuardStart < resetStart && resetStart < reloadFailedGuardEnd,
    'rollback must occur inside the reload_failed guard'
  )
})
