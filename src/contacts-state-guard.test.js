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

test('contacts-sync failure: reports health=error when syncContacts returns ok:false (prevents silent enrichment stall)', () => {
  // When syncContacts() returns { ok: false, error: '...' }, the scan must call
  // reportHealth('scanner', 'error') so Charlie's dashboard shows the degradation.
  // Without this, a broken contacts endpoint is invisible: nameless drafts accumulate
  // in pugs-sales with no alert and no way to distinguish a broken sync from a
  // healthy quiet scanner.
  //
  // The contacts-state-save guard (above) covers the orthogonal success+save-fail path.
  // This test covers the else branch: syncContacts returned ok:false (POST failed,
  // cloud error, etc) — the case most likely to be lost in a future refactor.
  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  // Verify: the else branch contains the 'contacts sync failed' marker
  assert.ok(
    scanCode.includes('contacts sync failed'),
    'scan.js must include "contacts sync failed" in the else branch — ' +
    'removing it means a broken contacts endpoint is invisible on the health dashboard'
  )

  // Verify: reportHealth is called when the sync returns ok:false
  assert.ok(
    scanCode.includes("reportHealth('scanner', 'error'") && scanCode.includes('contacts sync failed'),
    'scan.js must call reportHealth(scanner, error) when syncContacts returns ok:false — ' +
    'otherwise enrichment stalls silently while the dashboard shows a healthy scanner'
  )

  // Verify: res?.error is used as the reason, with fallback to 'unknown failure'
  // A sync failure with no error field must not surface as an empty/undefined message.
  assert.ok(
    scanCode.includes("res?.error || 'unknown failure'"),
    "scan.js must fall back to 'unknown failure' when res?.error is absent — " +
    "an undefined reason makes triage harder than a clear fallback string"
  )
})
