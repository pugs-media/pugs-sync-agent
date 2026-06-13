const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')

test('panic-restart.sh: npm install does not use --silent (hides errors)', () => {
  const src = fs.readFileSync('panic-restart.sh', 'utf8')
  assert.ok(
    !src.match(/npm\s+install\s+--silent/),
    'npm install must not use --silent — that suppresses error output needed to diagnose install failures'
  )
})

test('panic-restart.sh: npm install uses --loglevel error (errors visible, noise suppressed)', () => {
  const src = fs.readFileSync('panic-restart.sh', 'utf8')
  assert.ok(
    src.includes('npm install --loglevel error'),
    'npm install should use --loglevel error to surface install errors in the panic-restart log'
  )
})

test('panic-restart.sh: npm install includes --no-audit and --no-fund for speed', () => {
  const src = fs.readFileSync('panic-restart.sh', 'utf8')
  const npmLine = src.match(/npm install[^\n]+/)?.[0]
  assert.ok(
    npmLine && npmLine.includes('--no-audit'),
    'npm install should include --no-audit'
  )
  assert.ok(
    npmLine && npmLine.includes('--no-fund'),
    'npm install should include --no-fund'
  )
})

test('panic-restart.sh: bash -n reports no syntax errors', () => {
  const { execFileSync } = require('child_process')
  assert.doesNotThrow(
    () => {
      execFileSync('bash', ['-n', 'panic-restart.sh'], { stdio: 'pipe' })
    },
    'panic-restart.sh must not have bash syntax errors'
  )
})

test('panic-restart.sh: calls npm install after pulling code', () => {
  const src = fs.readFileSync('panic-restart.sh', 'utf8')
  const gitLine = src.indexOf('git merge --ff-only')
  const npmLine = src.indexOf('npm install')
  assert.ok(
    gitLine < npmLine && gitLine !== -1 && npmLine !== -1,
    'npm install should be called after git operations'
  )
})

test('panic-restart.sh: exits with scanner exit code so update.sh watchdog gets accurate self_heal_ok', () => {
  // Bug: panic-restart.sh captured scan_rc but never used it as the script exit code.
  // update.sh reads panic_rc=$? to set self_heal_ok in the cloud beacon. If
  // panic-restart.sh exits 0 unconditionally, self_heal_ok is always true — even
  // when the scanner is still broken after the self-heal. PR #125 fixed the pipe
  // swallowing the exit code in update.sh; this fixes the source.
  const src = fs.readFileSync('panic-restart.sh', 'utf8')
  assert.ok(
    src.includes('exit $scan_rc'),
    'panic-restart.sh must exit with $scan_rc so update.sh watchdog can set self_heal_ok correctly'
  )
  // exit $scan_rc must come after the scan_rc=$? assignment
  const scanRcAssignIdx = src.indexOf('scan_rc=$?')
  const exitIdx = src.indexOf('exit $scan_rc')
  assert.ok(
    scanRcAssignIdx !== -1 && exitIdx !== -1 && exitIdx > scanRcAssignIdx,
    'exit $scan_rc must come after scan_rc=$? capture'
  )
})

test('panic-restart.sh: step 5 captures scanner exit code — not tail exit code', () => {
  // Bug: `if node ... | tail -10` checks tail's exit code (always 0), not node's.
  // A scanner that exits 2/3/4 would still print "✓ scanner ran cleanly" — false
  // assurance during an emergency recovery when Charlie is diagnosing a stall.
  // Fix: capture to variable, check $? before piping through tail.
  const src = fs.readFileSync('panic-restart.sh', 'utf8')

  // Must NOT pipe node directly into the if-condition (that swallows node's exit code)
  assert.ok(
    !src.match(/if\s+"\$NODE_BIN"[^\n]*\|\s*tail/),
    'step 5 must not pipe node into tail inside an if-condition — that checks tail exit code (always 0), not node exit code'
  )

  // Must capture exit code separately (scan_rc=$?)
  assert.ok(
    src.includes('scan_rc=$?'),
    'step 5 must capture scanner exit code via scan_rc=$? so a failed scan is correctly diagnosed'
  )

  // Must branch on the captured exit code, not the pipe result
  assert.ok(
    src.includes('[ "$scan_rc" -eq 0 ]'),
    'step 5 must branch on $scan_rc (captured node exit code), not the pipe result'
  )
})
