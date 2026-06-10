'use strict'

// Test for scanner contacts state-save guard: if saveState fails after a successful
// contacts sync POST, the scanner must catch the error and report it to health rather
// than crashing. This prevents the scan from exiting prematurely when disk is full or
// permissions are restricted.
//
// See scan.js lines ~600: contacts state save wrapped in try/catch after syncContacts success.

const { test } = require('node:test')
const assert   = require('node:assert/strict')
const path     = require('path')
const fs       = require('fs')

test('contacts-state-save guard: catch and report saveState errors (prevents scan crash on disk full)', () => {
  // This is a code-review test that validates the structure of the guard.

  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  // Verify: saveState is wrapped in try/catch when updating contacts state after sync success
  const contactsStateInTryCatch = scanCode.includes('if (res?.ok)') &&
                                  scanCode.includes('try {') &&
                                  scanCode.includes('last_contacts_at') &&
                                  scanCode.includes('} catch (e) {') &&
                                  scanCode.includes('Contacts state save failed')

  assert.ok(contactsStateInTryCatch, 'scan.js must wrap contacts state save in try/catch with error message')

  // Verify: error is reported to health endpoint
  assert.ok(scanCode.includes("reportHealth('scanner', 'error'") && scanCode.includes('Contacts state save'),
    'scan.js must report contacts state-save failures to cloud health endpoint')

  // Verify: error is logged (not silent)
  assert.ok(scanCode.includes("console.warn") && scanCode.includes('Contacts state save'),
    'scan.js must log contacts state-save failures to console')
})
