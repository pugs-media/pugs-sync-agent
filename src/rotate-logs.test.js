const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

// Helper: run the rotate-logs.sh script in a test directory
function runRotateLogsInDir(testDir, maxMB = 1, maxFiles = 3) {
  const script = path.join(__dirname, '..', 'rotate-logs.sh')
  try {
    execFileSync('bash', [script, maxMB, maxFiles], {
      cwd: testDir,
      stdio: 'ignore',
      env: { ...process.env, AGENT_ROOT: testDir },
    })
  } catch (e) {
    // Script uses || true for some operations; exit code 1 is non-fatal
    if (e.status !== 0) throw e
  }
}

// Helper: create a log file of given size (in bytes)
function createLogFile(dir, name, sizeBytes) {
  const file = path.join(dir, name)
  const chunk = Buffer.alloc(1024, 'x')
  const fd = fs.openSync(file, 'w')
  let written = 0
  while (written < sizeBytes) {
    const toWrite = Math.min(chunk.length, sizeBytes - written)
    fs.writeSync(fd, chunk, 0, toWrite)
    written += toWrite
  }
  fs.closeSync(fd)
  return file
}

// Helper: list all files matching a pattern in a directory
function listLogFiles(dir, baseName) {
  const files = fs.readdirSync(dir)
  return files
    .filter(f => f.startsWith(baseName))
    .sort()
}

test('rotate-logs: creates .1 file when log exceeds threshold', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-logs-'))
  try {
    // Create a 2MB log file (threshold is 1MB)
    createLogFile(testDir, 'scanner.log', 2 * 1024 * 1024)
    runRotateLogsInDir(testDir, 1, 3)

    // Should have both .1.gz and (maybe) original if in-progress
    const files = listLogFiles(testDir, 'scanner.log')
    assert.ok(
      files.some(f => f === 'scanner.log.1.gz'),
      'rotation should create scanner.log.1.gz'
    )
    // Original file should be gone or very small (rotation moved it)
    if (fs.existsSync(path.join(testDir, 'scanner.log'))) {
      assert.strictEqual(
        fs.statSync(path.join(testDir, 'scanner.log')).size,
        0,
        'original log should be empty after rotation'
      )
    }
  } finally {
    fs.rmSync(testDir, { recursive: true })
  }
})

test('rotate-logs: ignores logs below threshold', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-logs-'))
  try {
    // Create a 512KB log file (threshold is 1MB)
    createLogFile(testDir, 'scanner.log', 512 * 1024)
    const originalSize = fs.statSync(path.join(testDir, 'scanner.log')).size

    runRotateLogsInDir(testDir, 1, 3)

    // File should be unchanged
    assert.strictEqual(
      fs.statSync(path.join(testDir, 'scanner.log')).size,
      originalSize,
      'logs below threshold should not be rotated'
    )
    const files = listLogFiles(testDir, 'scanner.log')
    assert.deepStrictEqual(
      files,
      ['scanner.log'],
      'should have only the original file'
    )
  } finally {
    fs.rmSync(testDir, { recursive: true })
  }
})

test('rotate-logs: skips missing log files gracefully', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-logs-'))
  try {
    // Don't create any files
    runRotateLogsInDir(testDir, 1, 3)

    // Should complete without error
    const files = fs.readdirSync(testDir)
    assert.strictEqual(
      files.length,
      0,
      'directory should remain empty'
    )
  } finally {
    fs.rmSync(testDir, { recursive: true })
  }
})

test('rotate-logs: handles multiple log files independently', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-logs-'))
  try {
    // Create oversized scanner and poller logs
    createLogFile(testDir, 'scanner.log', 2 * 1024 * 1024)
    createLogFile(testDir, 'scanner.error.log', 1.5 * 1024 * 1024)
    createLogFile(testDir, 'poller.log', 512 * 1024)  // below threshold

    runRotateLogsInDir(testDir, 1, 3)

    // scanner.log and scanner.error.log should be rotated
    assert.ok(
      fs.existsSync(path.join(testDir, 'scanner.log.1.gz')),
      'scanner.log should be rotated'
    )
    assert.ok(
      fs.existsSync(path.join(testDir, 'scanner.error.log.1.gz')),
      'scanner.error.log should be rotated'
    )
    // poller.log should not be rotated
    assert.strictEqual(
      fs.statSync(path.join(testDir, 'poller.log')).size,
      512 * 1024,
      'poller.log below threshold should not be rotated'
    )
  } finally {
    fs.rmSync(testDir, { recursive: true })
  }
})

test('rotate-logs: preserves multiple rotations up to max', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-logs-'))
  try {
    // Simulate multiple rotations by pre-creating archived files
    createLogFile(testDir, 'scanner.log.1.gz', 100)
    createLogFile(testDir, 'scanner.log.2.gz', 100)
    createLogFile(testDir, 'scanner.log', 2 * 1024 * 1024)  // oversized

    runRotateLogsInDir(testDir, 1, 3)

    // After rotation, should have .1.gz, .2.gz, .3.gz (old .1 → .2, new → .1)
    const files = listLogFiles(testDir, 'scanner.log')
    assert.ok(
      files.includes('scanner.log.1.gz'),
      'should have scanner.log.1.gz'
    )
    assert.ok(
      files.includes('scanner.log.2.gz'),
      'should have scanner.log.2.gz (rotated from .1)'
    )
    assert.ok(
      files.includes('scanner.log.3.gz'),
      'should have scanner.log.3.gz (rotated from .2)'
    )
    assert.ok(
      !files.includes('scanner.log.4.gz'),
      'should not exceed max of 3 files'
    )
  } finally {
    fs.rmSync(testDir, { recursive: true })
  }
})

test('rotate-logs: cleans up files beyond max retention', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-logs-'))
  try {
    // Pre-create many old rotations
    for (let i = 1; i <= 10; i++) {
      createLogFile(testDir, `scanner.log.${i}.gz`, 100)
    }
    createLogFile(testDir, 'scanner.log', 2 * 1024 * 1024)

    runRotateLogsInDir(testDir, 1, 3)  // maxFiles = 3

    // Should keep only the newest 3 rotations
    const files = listLogFiles(testDir, 'scanner.log')
    const rotated = files.filter(f => f.endsWith('.gz'))
    assert.ok(
      rotated.length <= 3,
      `should have at most 3 rotated files, got ${rotated.length}: ${rotated.join(', ')}`
    )
  } finally {
    fs.rmSync(testDir, { recursive: true })
  }
})

test('update.sh: calls rotate-logs.sh before git operations', () => {
  // Verify that rotate-logs.sh is called early in update.sh
  const updateSh = fs.readFileSync(path.join(__dirname, '..', 'update.sh'), 'utf8')

  const rotateLogsCall = updateSh.match(/rotate-logs\.sh/)
  assert.ok(
    rotateLogsCall,
    'update.sh should call rotate-logs.sh'
  )

  // Verify it's called before git fetch (which comes later)
  const rotateLine = updateSh.indexOf('rotate-logs.sh')
  const gitLine = updateSh.indexOf('git fetch')
  assert.ok(
    rotateLine < gitLine,
    'rotate-logs.sh should be called before git fetch'
  )
})
