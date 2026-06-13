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

// ── watchdog success-line patterns ───────────────────────────────────────────

test('update.sh: watchdog grep includes GUID-deduped as a success indicator', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // After a ROWID reset, the scanner advances the cursor through an already-sent
  // backlog. Each run logs "All N rows were GUID-deduped (already sent) — advancing
  // cursor…" but prints none of Webhook OK / sending heartbeat / Posting N messages.
  // Without GUID-deduped in the grep, the watchdog fires against a healthy scanner
  // if that backlog takes >30 min to clear (>1000 messages in the 7-day fallback
  // window). Adding it prevents a spurious panic-restart + false alert to Charlie.
  assert.ok(
    src.includes('GUID-deduped'),
    'watchdog grep must include GUID-deduped so post-ROWID-reset cursor advances are recognised as healthy'
  )
})

// ── watchdog log-file existence guard ────────────────────────────────────────

test('update.sh: watchdog skips entirely when scanner.log does not exist (prevents cascade restarts after log rotation)', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // rotate-logs.sh MOVES scanner.log to scanner.log.1 when it exceeds the size
  // threshold — after rotation the file is gone, not truncated. On the same
  // update.sh run the watchdog must skip rather than fire.
  //
  // Without the [ -f ] guard, `stat` on the missing file falls back to mtime=0,
  // so age = (now - 0) ≈ 54 years, which always exceeds WATCHDOG_THRESHOLD_SEC.
  // That would trigger panic-restart on EVERY update.sh cycle until the scanner
  // creates a new scanner.log — cascading service restarts every 10 minutes and
  // a stream of false-alarm beacons to Charlie.
  assert.ok(
    src.includes('[ -f "$SCANNER_LOG" ]'),
    'watchdog must guard on scanner.log existence — log rotation moves the file away; ' +
    'missing guard causes stat mtime=0 → age≈54yr → panic-restart on every update cycle'
  )
  // Verify the watchdog block is wholly nested inside that guard, not just that
  // the guard string appears somewhere.
  // WATCHDOG_THRESHOLD_SEC is defined as a constant before the guard — use the
  // reference ($WATCHDOG_THRESHOLD_SEC) which appears inside the if-block.
  const guardIdx     = src.indexOf('[ -f "$SCANNER_LOG" ]')
  const watchdogIdx  = src.indexOf('watchdog_fire=')
  const thresholdIdx = src.indexOf('$WATCHDOG_THRESHOLD_SEC')
  assert.ok(
    guardIdx < watchdogIdx && guardIdx < thresholdIdx,
    'watchdog_fire assignment and threshold reference must come after the [ -f ] guard'
  )
})

// ── watchdog beacon ──────────────────────────────────────────────────────────

// ── BASE_URL origin derivation ────────────────────────────────────────────────

test('update.sh: BASE_URL uses URL-origin extraction (not hardcoded path-suffix removal)', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // The original pattern `${PUGS_SYNC_WEBHOOK_URL%/api/import/imessage}` silently
  // fails for non-standard URL formats (staging URLs, future path changes): the
  // suffix match is exact, so a URL like https://staging.pugs.media/webhook/imessage
  // would keep the full path and send health beacons to the wrong endpoint.
  // The fix uses `cut -d/ -f1-3` — same URL-origin extraction as scan.js's
  // `new URL(webhookUrl).origin`: scheme + host, no path, works for any URL shape.
  assert.ok(
    !src.includes('%/api/import/imessage'),
    'BASE_URL must not be derived by stripping a hardcoded /api/import/imessage suffix — ' +
    'that silently fails for non-standard URL formats (staging, future path changes). ' +
    'Use cut -d/ -f1-3 or equivalent origin extraction.'
  )
  assert.ok(
    src.includes('cut -d/ -f1-3'),
    'BASE_URL must be derived from the URL origin using cut -d/ -f1-3 ' +
    '(scheme+host, correct for any URL shape regardless of path format)'
  )
})

test('update.sh: watchdog beacon body uses $watchdog_reason (not hardcoded "scanner.log stale")', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  // The watchdog fires for two distinct reasons:
  //   (1) scanner.log mtime stale — launchd gave up scheduling
  //   (2) scanner.log fresh but no "Webhook OK" in last 200 lines — crash-loop
  // If the beacon body hardcodes "scanner.log stale", Charlie sees the wrong
  // diagnostic for reason (2) and wastes time investigating the wrong failure mode.
  assert.ok(
    !src.includes('"reason":"scanner.log stale"'),
    'beacon body must not hardcode the reason string — use $watchdog_reason so both failure modes report accurately'
  )
  // In the shell script the JSON is embedded with escaped quotes: \"reason\":\"$watchdog_reason\"
  assert.ok(
    src.includes('\\"reason\\":\\"$watchdog_reason\\"'),
    'beacon body must use $watchdog_reason so the actual trigger is sent to pugs-sales'
  )
})

// ── watchdog grep ↔ scan.js log-string alignment ─────────────────────────────
// The watchdog in update.sh greps scanner.log for success indicators. If scan.js
// renames a log string without updating the grep, the watchdog silently misfires —
// it treats every healthy run as a crash-loop and triggers panic-restart every 10
// minutes, restarting all services and sending false alerts to Charlie. These tests
// lock the alignment so a log-string rename is caught before it ships.
//
// Each test: (a) confirms the pattern appears in the watchdog grep, (b) confirms the
// matching log string still exists in scan.js. Both checks must pass together —
// having the pattern without the log line is dead pattern; having the log line
// without the pattern is a watchdog blind spot.

const SCAN_JS = path.join(__dirname, 'scan.js')

// Helper: extract the watchdog grep -qE pattern from update.sh.
// Returns the alternation string, e.g. "Webhook OK|sending heartbeat|..."
function extractWatchdogGrepPattern(updateShSrc) {
  const m = updateShSrc.match(/grep -qE "([^"]+)"/)
  assert.ok(m, 'watchdog grep -qE pattern must be present in update.sh')
  return m[1]
}

test('update.sh watchdog grep: "Webhook OK" matches what scan.js actually logs on successful POST', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  const scanSrc = fs.readFileSync(SCAN_JS, 'utf8')
  const pattern = extractWatchdogGrepPattern(src)

  assert.ok(
    pattern.includes('Webhook OK'),
    '"Webhook OK" must be in the watchdog grep pattern — removing it means successful scans are invisible to the watchdog'
  )
  assert.ok(
    scanSrc.includes('Webhook OK'),
    'scan.js must log a line containing "Webhook OK" — if this string is renamed without updating the grep pattern the watchdog panic-restarts healthy scanners'
  )
})

test('update.sh watchdog grep: "sending heartbeat" matches what scan.js actually logs on empty-queue run', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  const scanSrc = fs.readFileSync(SCAN_JS, 'utf8')
  const pattern = extractWatchdogGrepPattern(src)

  assert.ok(
    pattern.includes('sending heartbeat'),
    '"sending heartbeat" must be in the watchdog grep pattern — quiet runs with no messages must still count as healthy'
  )
  assert.ok(
    scanSrc.includes('sending heartbeat'),
    'scan.js must log a line containing "sending heartbeat" on empty-queue runs — rename without grep update causes watchdog to panic-restart on every quiet scan'
  )
})

test('update.sh watchdog grep: "Posting [0-9]+ messages" pattern matches what scan.js actually logs', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  const scanSrc = fs.readFileSync(SCAN_JS, 'utf8')
  const pattern = extractWatchdogGrepPattern(src)

  assert.ok(
    pattern.includes('Posting [0-9]+ messages'),
    '"Posting [0-9]+ messages" must be in the watchdog grep pattern'
  )
  // scan.js logs: `Posting ${filteredPayload.length} messages (ROWIDs ...)`
  // Verify the template literal prefix still exists so the pattern can match.
  assert.ok(
    scanSrc.includes('} messages (ROWIDs'),
    'scan.js must log "Posting N messages (ROWIDs..." — if this prefix is renamed the "Posting [0-9]+ messages" pattern stops matching and the watchdog misfires'
  )
})

test('update.sh watchdog grep: "GUID-deduped" matches what scan.js actually logs in cursor-advance path', () => {
  const src = fs.readFileSync(UPDATE_SH, 'utf8')
  const scanSrc = fs.readFileSync(SCAN_JS, 'utf8')
  const pattern = extractWatchdogGrepPattern(src)

  assert.ok(
    pattern.includes('GUID-deduped'),
    '"GUID-deduped" must be in the watchdog grep pattern — post-ROWID-reset cursor-advance runs must be recognised as healthy'
  )
  assert.ok(
    scanSrc.includes('GUID-deduped'),
    'scan.js must log a line containing "GUID-deduped" in the all-dedup cursor-advance branch — rename without grep update causes watchdog to fire during normal post-ROWID-reset recovery'
  )
})
