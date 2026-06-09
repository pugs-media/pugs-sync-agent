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
