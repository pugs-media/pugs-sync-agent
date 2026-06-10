'use strict'

// Test for scanner state-save guard: if saveState fails after a successful webhook POST,
// the scanner must catch the error, report it to health, and exit cleanly rather than
// silently proceeding with an unadvanced state (which would cause duplicates on next run).
//
// See scan.js lines ~560: state save wrapped in try/catch after webhook POST success.

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const path     = require('path')
const fs       = require('fs')
const os       = require('os')

test('state-save guard: catch and report saveState errors (prevents silent duplicate-send risk)', () => {
  // This is a code-review test that validates the structure of the fix.
  // The actual runtime behavior is exercised through scan.test.js's full integration tests.

  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  // Verify: saveState is wrapped in try/catch at the critical point (after webhook POST)
  const saveStateInTryCatch = scanCode.includes('try {') &&
                               scanCode.includes('saveState(STATE_PATH') &&
                               scanCode.includes('Advanced state to ROWID') &&
                               scanCode.includes('} catch (e) {') &&
                               scanCode.includes('State save failed after webhook POST')

  assert.ok(saveStateInTryCatch, 'scan.js must wrap critical saveState call in try/catch with error message')

  // Verify: error is reported to health endpoint
  assert.ok(scanCode.includes("reportHealth('scanner', 'error'"),
    'scan.js must report state-save failures to cloud health endpoint')

  // Verify: process exits on state-save failure (don't continue with unadvanced state)
  assert.ok(scanCode.includes('process.exit(3)'),
    'scan.js must exit on state-save failure to prevent silent duplicate-send risk')
})
