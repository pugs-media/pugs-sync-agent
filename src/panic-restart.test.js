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
