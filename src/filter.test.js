'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeHandleAllowed, classifyMessage, filterMessages } = require('./filter')

// A small allowlist used across tests. Phones are stored as bare 10-digit keys
// (matching scan.js's fetchProspectHandles normalization); emails lowercased.
function prospects() {
  return {
    phones: new Set(['4155550100', '2025550199']),
    emails: new Set(['lead@acme.com', 'cfo@bigco.io']),
  }
}

// Build a normalized payload row with sensible defaults; override per test.
function row(overrides = {}) {
  return {
    rowid: 1,
    is_from_me: 0,
    handle: '+14155550100',
    account: 'iMessage;-;connor@icloud.com',
    chat_kind: 'direct',
    chat_participants: null,
    ...overrides,
  }
}

// ── makeHandleAllowed ───────────────────────────────────────────────────────

test('handleAllowed: matches a phone regardless of formatting (last 10 digits)', () => {
  const allowed = makeHandleAllowed(prospects())
  assert.equal(allowed('+14155550100'), true)
  assert.equal(allowed('14155550100'), true)
  assert.equal(allowed('(415) 555-0100'), true)
  assert.equal(allowed('415.555.0100'), true)
})

test('handleAllowed: rejects a non-allowlisted phone', () => {
  const allowed = makeHandleAllowed(prospects())
  assert.equal(allowed('+19998887777'), false)
})

test('handleAllowed: matches emails case-insensitively and trimmed', () => {
  const allowed = makeHandleAllowed(prospects())
  assert.equal(allowed('lead@acme.com'), true)
  assert.equal(allowed('  LEAD@Acme.com '), true)
  assert.equal(allowed('stranger@acme.com'), false)
})

test('handleAllowed: rejects null/empty and short/garbled handles', () => {
  const allowed = makeHandleAllowed(prospects())
  assert.equal(allowed(null), false)
  assert.equal(allowed(undefined), false)
  assert.equal(allowed(''), false)
  assert.equal(allowed('555-0100'), false) // only 7 digits → not a 10-digit match
})

test('handleAllowed: a short-code style number sharing the last 10 digits still requires exactly 10', () => {
  const allowed = makeHandleAllowed(prospects())
  // 9 digits → slice(-10) yields 9 chars → length !== 10 → reject
  assert.equal(allowed('415555010'), false)
})

// ── classifyMessage: wrong-iCloud guard ─────────────────────────────────────

test('classify: outbound from a DIFFERENT iCloud is dropped (backdoor closed)', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({ is_from_me: 1, account: 'iMessage;-;someone-else@icloud.com', handle: '+19998887777' })
  const res = classifyMessage(r, { handleAllowed, expectedAppleId: 'connor@icloud.com' })
  assert.deepEqual(res, { keep: false, reason: 'wrong-apple-id' })
})

test('classify: outbound from the configured iCloud passes even to a non-prospect (deliberate first-touch)', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({ is_from_me: 1, account: 'iMessage;-;connor@icloud.com', handle: '+19998887777' })
  const res = classifyMessage(r, { handleAllowed, expectedAppleId: 'connor@icloud.com' })
  assert.equal(res.keep, true)
  assert.equal(res.reason, 'outbound')
})

test('classify: EXPECTED_APPLE_ID unset disables the wrong-iCloud guard (back-compat)', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({ is_from_me: 1, account: 'iMessage;-;whoever@icloud.com', handle: '+19998887777' })
  const res = classifyMessage(r, { handleAllowed, expectedAppleId: '' })
  assert.equal(res.keep, true)
  assert.equal(res.reason, 'outbound')
})

test('classify: guard tolerates a missing account on outbound (passes — nothing to compare)', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({ is_from_me: 1, account: null, handle: '+14155550100' })
  const res = classifyMessage(r, { handleAllowed, expectedAppleId: 'connor@icloud.com' })
  assert.equal(res.keep, true)
})

// ── classifyMessage: direct 1:1 inbound ─────────────────────────────────────

test('classify: inbound 1:1 from an allowlisted prospect is kept', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({ is_from_me: 0, handle: 'lead@acme.com' })
  assert.deepEqual(classifyMessage(r, { handleAllowed }), { keep: true, reason: 'prospect' })
})

test('classify: inbound 1:1 from a stranger (Mom/friend/newsletter) is dropped', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({ is_from_me: 0, handle: '+19998887777' })
  assert.deepEqual(classifyMessage(r, { handleAllowed }), { keep: false, reason: 'not-prospect' })
})

// ── classifyMessage: group chats ────────────────────────────────────────────

test('classify: group with an allowlisted participant is kept (sales-relevant room)', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({
    is_from_me: 0,
    handle: '+15551234567',
    chat_kind: 'group',
    chat_participants: ['+19998887777', '+14155550100'],
  })
  assert.deepEqual(classifyMessage(r, { handleAllowed }), { keep: true, reason: 'group-prospect' })
})

test('classify: personal group with NO allowlisted participant never leaves the Mac', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({
    is_from_me: 0,
    handle: '+15551234567',
    chat_kind: 'group',
    chat_participants: ['+19998887777', '+18001112222'],
  })
  assert.deepEqual(classifyMessage(r, { handleAllowed }), { keep: false, reason: 'not-prospect' })
})

test('classify: group with null/empty participants is dropped (no allowlisted member)', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  assert.equal(classifyMessage(row({ chat_kind: 'group', chat_participants: null }), { handleAllowed }).keep, false)
  assert.equal(classifyMessage(row({ chat_kind: 'group', chat_participants: [] }), { handleAllowed }).keep, false)
})

test('classify: outbound from a stranger iCloud into a prospect group is STILL dropped (guard runs first)', () => {
  const handleAllowed = makeHandleAllowed(prospects())
  const r = row({
    is_from_me: 1,
    account: 'iMessage;-;someone-else@icloud.com',
    chat_kind: 'group',
    chat_participants: ['+14155550100'], // prospect present, but wrong sender account
  })
  const res = classifyMessage(r, { handleAllowed, expectedAppleId: 'connor@icloud.com' })
  assert.deepEqual(res, { keep: false, reason: 'wrong-apple-id' })
})

// ── filterMessages: batch + drop accounting ─────────────────────────────────

test('filterMessages: keeps only in-scope rows and reports accurate drop counts', () => {
  const payload = [
    row({ rowid: 1, is_from_me: 0, handle: 'lead@acme.com' }),                       // keep: prospect
    row({ rowid: 2, is_from_me: 0, handle: '+19998887777' }),                        // drop: not-prospect
    row({ rowid: 3, is_from_me: 1, account: 'iMessage;-;connor@icloud.com' }),       // keep: outbound
    row({ rowid: 4, is_from_me: 1, account: 'iMessage;-;evil@icloud.com' }),         // drop: wrong-apple-id
    row({ rowid: 5, is_from_me: 0, chat_kind: 'group', chat_participants: ['cfo@bigco.io'] }), // keep: group-prospect
    row({ rowid: 6, is_from_me: 0, chat_kind: 'group', chat_participants: ['x@y.com'] }),      // drop: not-prospect
  ]
  const { kept, droppedWrongAccount, droppedNotProspect } =
    filterMessages(payload, { prospects: prospects(), expectedAppleId: 'connor@icloud.com' })

  assert.deepEqual(kept.map(r => r.rowid), [1, 3, 5])
  assert.equal(droppedWrongAccount, 1)
  assert.equal(droppedNotProspect, 2)
  // Invariant scan.js relies on: kept + wrongAccount + notProspect === total.
  assert.equal(kept.length + droppedWrongAccount + droppedNotProspect, payload.length)
})

test('filterMessages: empty batch yields empty kept and zero drops', () => {
  const res = filterMessages([], { prospects: prospects(), expectedAppleId: 'connor@icloud.com' })
  assert.deepEqual(res, { kept: [], droppedWrongAccount: 0, droppedNotProspect: 0 })
})
