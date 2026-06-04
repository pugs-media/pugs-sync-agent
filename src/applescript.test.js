'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { escapeAppleScriptString, buildSendScript, parseOsascriptResult } = require('./applescript')

test('escapeAppleScriptString: leaves a plain string untouched', () => {
  assert.equal(escapeAppleScriptString('+14155550100'), '+14155550100')
  assert.equal(escapeAppleScriptString('Hello there'), 'Hello there')
})

test('escapeAppleScriptString: escapes double quotes so the literal cannot be terminated', () => {
  assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"')
})

test('escapeAppleScriptString: escapes backslashes (and does not double-escape quotes)', () => {
  // Each source char is handled exactly once: \ -> \\ and " -> \"
  assert.equal(escapeAppleScriptString('a\\b"c'), 'a\\\\b\\"c')
})

test('escapeAppleScriptString: maps \\n, \\r and \\t to AppleScript escapes', () => {
  assert.equal(escapeAppleScriptString('a\nb'), 'a\\nb')
  assert.equal(escapeAppleScriptString('a\rb'), 'a\\rb')
  assert.equal(escapeAppleScriptString('a\tb'), 'a\\tb')
})

test('escapeAppleScriptString: regression — CRLF leaves no raw carriage return', () => {
  // The previous implementation escaped \n but left \r raw, which corrupts the
  // AppleScript literal. The escaped output must contain no literal CR/LF.
  const out = escapeAppleScriptString('line1\r\nline2')
  assert.equal(out, 'line1\\r\\nline2')
  assert.doesNotMatch(out, /[\r\n]/)
})

test('escapeAppleScriptString: strips other C0 control chars and NUL', () => {
  assert.equal(escapeAppleScriptString('a\x00b\x07c\x1fd\x7fe'), 'abcde')
})

test('escapeAppleScriptString: handles null/undefined as empty string', () => {
  assert.equal(escapeAppleScriptString(null), '')
  assert.equal(escapeAppleScriptString(undefined), '')
})

test('buildSendScript: produces the expected script for a normal send', () => {
  const script = buildSendScript({ to: '+14155550100', text: 'Hi there', service: 'iMessage' })
  assert.match(script, /service type = iMessage/)
  assert.match(script, /buddy "\+14155550100" of targetService/)
  assert.match(script, /send "Hi there" to targetBuddy/)
})

test('buildSendScript: defaults unknown/missing service to iMessage, honors SMS', () => {
  assert.match(buildSendScript({ to: 'x', text: 'y' }), /service type = iMessage/)
  assert.match(buildSendScript({ to: 'x', text: 'y', service: 'whatever' }), /service type = iMessage/)
  assert.match(buildSendScript({ to: 'x', text: 'y', service: 'SMS' }), /service type = SMS/)
})

test('buildSendScript: a quote in the body cannot inject extra AppleScript statements', () => {
  // Attempt to close the string and append a command. After escaping, the
  // injected quote is neutralised, so only one `send` statement exists and the
  // attacker text stays inside the literal.
  const evil = '" \n tell application "Finder" to delete every item\n "'
  const script = buildSendScript({ to: '+14155550100', text: evil })
  // Exactly one send statement (the legitimate one).
  assert.equal((script.match(/\bsend "/g) || []).length, 1)
  // No raw newline injected by the payload — the body is single-line escaped.
  const sendLine = script.split('\n').find(l => l.includes('send "'))
  assert.ok(sendLine.includes('\\"'), 'injected quote should be escaped')
  // The escaped Finder text remains as data inside the send literal.
  assert.match(sendLine, /Finder/)
})

test('buildSendScript: a malicious handle cannot break out of the buddy literal', () => {
  const evilHandle = '+1" of targetService\nsend "pwned'
  const script = buildSendScript({ to: evilHandle, text: 'ok' })
  const buddyLine = script.split('\n').find(l => l.includes('buddy "'))
  assert.ok(buddyLine.includes('\\"'), 'injected quote in handle should be escaped')
  // Still exactly one send statement — the handle did not introduce another.
  assert.equal((script.match(/\bsend "/g) || []).length, 1)
})

// --- Error-detection contract in buildSendScript ---

test('buildSendScript: wraps send in try/on error and returns "ok" on success path', () => {
  const script = buildSendScript({ to: '+14155550100', text: 'Hi', service: 'iMessage' })
  assert.match(script, /\btry\b/)
  assert.match(script, /return "ok"/)
  assert.match(script, /on error errMsg number errNum/)
  assert.match(script, /return "error:" & errNum & ":" & errMsg/)
})

test('buildSendScript: error return appears inside the on-error handler, not on the success path', () => {
  const script = buildSendScript({ to: 'x', text: 'y' })
  const lines = script.split('\n').map(l => l.trim())
  const onErrorIdx = lines.findIndex(l => l.startsWith('on error'))
  const returnOkIdx = lines.findIndex(l => l === 'return "ok"')
  const returnErrIdx = lines.findIndex(l => l.startsWith('return "error:"'))
  // "return ok" must come before the "on error" clause
  assert.ok(returnOkIdx < onErrorIdx, '"return ok" should precede the on-error handler')
  // error return must come after "on error"
  assert.ok(returnErrIdx > onErrorIdx, '"return error:" should be inside on-error handler')
})

// --- parseOsascriptResult ---

test('parseOsascriptResult: "ok" stdout → ok:true', () => {
  assert.deepEqual(parseOsascriptResult('ok'), { ok: true })
  assert.deepEqual(parseOsascriptResult('ok\n'), { ok: true })
  assert.deepEqual(parseOsascriptResult('  ok  '), { ok: true })
})

test('parseOsascriptResult: "error:<code>:<msg>" stdout → ok:false with detail', () => {
  const r = parseOsascriptResult('error:-1728:Can\'t get buddy "+1" of service')
  assert.equal(r.ok, false)
  assert.match(r.detail, /-1728/)
  assert.match(r.detail, /Can't get buddy/)
})

test('parseOsascriptResult: error detail is capped at 400 chars', () => {
  const longErr = 'error:-9999:' + 'x'.repeat(500)
  const r = parseOsascriptResult(longErr)
  assert.equal(r.ok, false)
  assert.ok(r.detail.length <= 400, 'detail must not exceed 400 chars')
})

test('parseOsascriptResult: empty stdout → ok:false with "no output" detail', () => {
  const r = parseOsascriptResult('')
  assert.equal(r.ok, false)
  assert.match(r.detail, /no output/)
})

test('parseOsascriptResult: null/undefined stdout → ok:false', () => {
  assert.equal(parseOsascriptResult(null).ok, false)
  assert.equal(parseOsascriptResult(undefined).ok, false)
})

test('parseOsascriptResult: unexpected non-error stdout → ok:false with "unexpected result"', () => {
  const r = parseOsascriptResult('some random output')
  assert.equal(r.ok, false)
  assert.match(r.detail, /unexpected result/)
})
