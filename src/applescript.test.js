'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { escapeAppleScriptString, buildSendScript } = require('./applescript')

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
