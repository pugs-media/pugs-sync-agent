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

test('update.sh: npm install is wrapped in timeout to prevent hangs', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  assert.ok(
    src.includes('timeout 30 npm install'),
    'npm install must be wrapped with timeout to prevent registry/node hangs from blocking the updater'
  )
})

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

// ── git fetch timeout ────────────────────────────────────────────────────

test('update.sh: git fetch is wrapped in timeout to prevent network hangs', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // git fetch must be protected by timeout so a hung SSH connection or slow
  // remote does not stall the entire updater and block subsequent launchd cycles.
  assert.ok(
    src.includes('timeout 30 git fetch'),
    'git fetch must be wrapped with timeout to prevent network stalls'
  )
})

test('update.sh: git fetch timeout failure is logged', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // When timeout kills the fetch, the error message must be logged.
  assert.ok(
    src.includes('timeout') && src.includes('git fetch failed'),
    'timeout kill of git fetch must be logged'
  )
})
