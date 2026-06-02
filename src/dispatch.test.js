'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isUsableString, planItem } = require('./dispatch')

const MAX = 5
const plan = (item) => planItem(item, { maxAttempts: MAX })
const ok = { id: 1, to_handle: '+14155550100', body: 'Hello there', attempts: 0 }

test('isUsableString: only non-blank strings are usable', () => {
  assert.equal(isUsableString('x'), true)
  assert.equal(isUsableString('  hi  '), true)
  assert.equal(isUsableString(''), false)
  assert.equal(isUsableString('   '), false)
  assert.equal(isUsableString('\n\t '), false)
  assert.equal(isUsableString(null), false)
  assert.equal(isUsableString(undefined), false)
  assert.equal(isUsableString(123), false)
})

test('planItem: a well-formed item under the retry ceiling is dispatched', () => {
  assert.deepEqual(plan(ok), { action: 'send' })
})

test('planItem: missing attempts defaults to 0 → still sends', () => {
  assert.deepEqual(plan({ id: 2, to_handle: 'a@b.com', body: 'hi' }), { action: 'send' })
})

test('planItem: non-numeric attempts is treated as 0 (fail open to a try)', () => {
  assert.deepEqual(plan({ ...ok, attempts: 'nope' }), { action: 'send' })
  assert.deepEqual(plan({ ...ok, attempts: NaN }), { action: 'send' })
})

test('planItem: attempts at the ceiling is skipped (boundary is >=)', () => {
  assert.deepEqual(plan({ ...ok, attempts: MAX }), { action: 'skip', reason: 'max-attempts' })
})

test('planItem: attempts over the ceiling is skipped', () => {
  assert.deepEqual(plan({ ...ok, attempts: MAX + 3 }), { action: 'skip', reason: 'max-attempts' })
})

test('planItem: one below the ceiling still sends', () => {
  assert.deepEqual(plan({ ...ok, attempts: MAX - 1 }), { action: 'send' })
})

test('planItem: max-attempts is checked before the field guards (dead row never re-validated)', () => {
  // A dead row with a blank body should report as skip (let the cloud reap it),
  // not as a fresh field failure.
  assert.deepEqual(plan({ id: 9, to_handle: '', body: '', attempts: MAX }), {
    action: 'skip',
    reason: 'max-attempts',
  })
})

test('planItem: missing to_handle fails locally (never reaches the sender)', () => {
  assert.deepEqual(plan({ id: 3, body: 'hi' }), {
    action: 'fail',
    reason: 'missing-or-blank-to_handle',
  })
})

test('planItem: blank / whitespace-only to_handle fails (would misfire a send)', () => {
  assert.deepEqual(plan({ id: 4, to_handle: '   ', body: 'hi' }), {
    action: 'fail',
    reason: 'missing-or-blank-to_handle',
  })
})

test('planItem: non-string to_handle fails', () => {
  assert.deepEqual(plan({ id: 5, to_handle: 14155550100, body: 'hi' }), {
    action: 'fail',
    reason: 'missing-or-blank-to_handle',
  })
})

test('planItem: missing body fails locally', () => {
  assert.deepEqual(plan({ id: 6, to_handle: '+14155550100' }), {
    action: 'fail',
    reason: 'missing-or-blank-body',
  })
})

test('planItem: whitespace-only body fails (blank iMessage prevented)', () => {
  // send.js treats a whitespace body as truthy and would dispatch it; the guard
  // catches it before any real send.
  assert.deepEqual(plan({ id: 7, to_handle: '+14155550100', body: '   \n\t' }), {
    action: 'fail',
    reason: 'missing-or-blank-body',
  })
})

test('planItem: a valid handle with a blank body fails on the body, not the handle', () => {
  assert.equal(plan({ id: 8, to_handle: '+14155550100', body: '' }).reason, 'missing-or-blank-body')
})

test('planItem: null / non-object / id-less items are dropped (cannot be reported)', () => {
  for (const bad of [null, undefined, 42, 'str', [], {}, { to_handle: 'x', body: 'y' }, { id: null, body: 'y' }]) {
    assert.deepEqual(plan(bad), { action: 'drop', reason: 'malformed-item' }, `dropped: ${JSON.stringify(bad)}`)
  }
})

test('planItem: id of 0 is a valid id (not dropped)', () => {
  // Queue ids can be falsy-but-present; 0 must not be mistaken for "no id".
  assert.deepEqual(plan({ id: 0, to_handle: '+14155550100', body: 'hi' }), { action: 'send' })
})
