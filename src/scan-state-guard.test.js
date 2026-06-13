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

test('health-before-exit(4): heartbeat failure reports health=error before exiting (not a silent stall)', () => {
  // Without a health report before process.exit(4), a persistent heartbeat failure looks
  // like a silent stall on the dashboard — indistinguishable from a hung scanner.
  // The cloud health endpoint is best-effort (swallows errors if the cloud is down too),
  // so adding reportHealth here costs nothing on a full-cloud-outage and adds visibility
  // when only the webhook route is broken while the health route still responds.
  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  // The heartbeat-failure catch block must include both a reportHealth call and exit(4).
  assert.ok(
    scanCode.includes('Heartbeat failed after retries') &&
    scanCode.includes("reportHealth('scanner', 'error'") &&
    scanCode.includes('process.exit(4)'),
    'scan.js must call reportHealth(error) before process.exit(4) on heartbeat failure'
  )
})

test('health-before-exit(4): webhook failure reports health=error before exiting (not a silent stall)', () => {
  // Same pattern as heartbeat: a webhook failure that exits without a health report
  // leaves the cloud dashboard showing the last ok heartbeat, making a "webhook all retries
  // exhausted" look identical to "scanner is quietly idle". The health report disambiguates.
  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  assert.ok(
    scanCode.includes('Webhook POST failed after retries') &&
    scanCode.includes("reportHealth('scanner', 'error'") &&
    scanCode.includes('process.exit(4)'),
    'scan.js must call reportHealth(error) before process.exit(4) on webhook failure'
  )
})

test('all-GUID-dedup cursor-advance state-save guard: catches saveState errors and reports health (prevents silent cursor stall)', () => {
  // If saveState fails (disk full, permissions) after the all-GUID-dedup cursor advance,
  // the scanner must log it, report health=error, and exit — NOT silently continue.
  //
  // Without this guard, a disk-full failure would leave the cursor stuck at the old
  // position: every subsequent 5-min scan re-queries the same GUID-deduped batch,
  // keeps hitting "no new messages", and never advances to real new leads —
  // a silent lead-loss stall that looks identical to normal idle behaviour on the
  // dashboard. The exit triggers a launchd restart so a transient disk-full clears.
  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  assert.ok(
    scanCode.includes('State save failed after all-GUID-dedup cursor advance'),
    'scan.js must have a specific error message for the all-GUID-dedup cursor advance saveState failure path'
  )
  assert.ok(
    scanCode.includes("reportHealth('scanner', 'error'"),
    'scan.js must call reportHealth(scanner, error) on all-GUID-dedup cursor advance saveState failure'
  )
  assert.ok(
    scanCode.includes('process.exit(3)'),
    'scan.js must exit(3) on all-GUID-dedup cursor advance saveState failure to trigger launchd restart'
  )
})

test('all-filtered cursor-advance state-save guard: catches saveState errors and reports health (prevents silent cursor stall)', () => {
  // If saveState fails (disk full, permissions) in the all-prospect-filtered cursor-advance
  // path of main(), the scanner must log it, report health=error, and exit — NOT silently
  // continue with the cursor un-advanced.
  //
  // Why this stalls leads: this path fires whenever dedupedRows has content but every row
  // was dropped by the prospect/account filter (personal conversations with friends, family,
  // spam). Without the try/catch, a disk-full error leaves the cursor stuck: every subsequent
  // 5-min scan re-reads the same personal-message batch, never advancing to higher ROWIDs
  // where genuine prospect leads sit — a silent lead-loss stall identical to normal idle
  // behaviour on the dashboard.
  //
  // Mirrors the parallel guard for the all-GUID-dedup cursor-advance path (above).
  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  assert.ok(
    scanCode.includes('State save failed after all-filtered cursor advance'),
    'scan.js must have a specific error message for the all-filtered cursor advance saveState failure — ' +
    'removing this guard leaves the cursor stuck at the old position, blocking all subsequent leads'
  )
  assert.ok(
    scanCode.includes("reportHealth('scanner', 'error'"),
    'scan.js must call reportHealth(scanner, error) so a disk-full cursor stall is visible on the dashboard'
  )
  assert.ok(
    scanCode.includes('process.exit(3)'),
    'scan.js must exit(3) on saveState failure to trigger a launchd restart — a clean slate clears transient disk issues'
  )
})

test('sent_guids tracks filteredPayload GUIDs (actually sent), not dedupedRows (all scanned)', () => {
  // Bug: using dedupedRows.map(r => r.guid) adds GUIDs of non-prospect / normalization-dropped
  // messages to sent_guids even though those messages were NEVER shipped to pugs-sales.
  // After a ROWID reset recovery (7-day fallback), those messages reappear in the window.
  // If the person became a prospect in the meantime, their messages would be incorrectly
  // GUID-deduped out — a silent lead loss.
  //
  // Fix: use filteredPayload.map(r => r.guid) so only confirmed-sent GUIDs are tracked.
  // The cursor still advances to dedupedRows.last.rowid (unchanged), so non-prospect
  // messages are not re-processed in normal operation.
  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  assert.ok(
    scanCode.includes('filteredPayload.map(r => r.guid)'),
    'scan.js must track filteredPayload GUIDs (actually sent), not dedupedRows (all scanned)'
  )
  assert.ok(
    !scanCode.includes('dedupedRows.map(r => r.guid)'),
    'scan.js must NOT use dedupedRows.map(r => r.guid) — that incorrectly marks un-sent messages as sent'
  )
})

test('cursor advances to dedupedRows last rowid (not filteredPayload) — handles all-prospect-filtered batch', () => {
  // The cursor formula MUST use dedupedRows[dedupedRows.length - 1].rowid, NOT
  // filteredPayload[filteredPayload.length - 1]?.rowid.
  //
  // Why: the most common scan path is Connor having non-prospect conversations in his
  // inbox. normalizeRows produces N rows; filterMessages drops all of them (no prospects
  // among the senders). filteredPayload is therefore empty. If the cursor formula used
  // filteredPayload[last], it would either crash (undefined.rowid) or — with optional
  // chaining — silently return undefined, leaving the cursor at its OLD position.
  //
  // A cursor that never advances means the same 200-row batch is re-read every 5 min,
  // blocking ALL messages from higher ROWIDs — including genuine prospect leads that
  // arrive later. The scanner would appear healthy (heartbeats succeed, no crash) while
  // silently losing every new lead.
  //
  // The fix is to always key the cursor on dedupedRows (what was examined), so the cursor
  // advances regardless of filtering. GUIDs of un-sent messages are simply not added to
  // sent_guids (the filteredPayload formula), so they stay re-deliverable after a ROWID reset.
  const scanCode = fs.readFileSync(path.join(__dirname, 'scan.js'), 'utf8')

  assert.ok(
    scanCode.includes('dedupedRows[dedupedRows.length - 1].rowid'),
    'scan.js must advance the cursor using dedupedRows[last].rowid so a batch where all rows are ' +
    'prospect-filtered (filteredPayload=[]) still advances the cursor — not filteredPayload[last]?.rowid, ' +
    'which would stall the cursor and silently block all subsequent leads'
  )
  // Belt-and-suspenders: confirm filteredPayload is not used for the cursor rowid.
  // filteredPayload.length - 1 access pattern on an empty array would return undefined
  // and silently leave the cursor un-advanced.
  assert.ok(
    !scanCode.includes('filteredPayload[filteredPayload.length - 1]'),
    'scan.js must NOT derive the cursor rowid from filteredPayload — when filteredPayload is ' +
    'empty (all rows prospect-filtered) that expression is undefined and the cursor stalls'
  )
})
