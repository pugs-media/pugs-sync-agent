'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  appleDateToISO,
  normalizePhone,
  isHandleAllowed,
  classifyMessage,
} = require('./filter')

// ── appleDateToISO ──────────────────────────────────────────────────────

test('appleDateToISO: null/undefined → null', () => {
  assert.equal(appleDateToISO(null), null)
  assert.equal(appleDateToISO(undefined), null)
})

test('appleDateToISO: seconds-since-2001 (older macOS) decodes', () => {
  // 0 Apple-seconds == 2001-01-01T00:00:00Z
  assert.equal(appleDateToISO(0), '2001-01-01T00:00:00.000Z')
  // one day later
  assert.equal(appleDateToISO(86400), '2001-01-02T00:00:00.000Z')
})

test('appleDateToISO: nanoseconds-since-2001 (modern macOS) decodes', () => {
  // 1 day in ns == 86400 * 1e9, above the 1e15 sentinel? No — pick a realistic
  // modern timestamp well past the 1e15 threshold.
  const ns = 700000000 * 1e9 // ~2023, ~7e17 ns, clearly > 1e15
  const iso = appleDateToISO(ns)
  assert.equal(iso, new Date(700000000 * 1000 + 978307200000).toISOString())
})

test('appleDateToISO: seconds and nanoseconds for the same instant agree', () => {
  const seconds = 700000000
  assert.equal(appleDateToISO(seconds), appleDateToISO(seconds * 1e9))
})

test('appleDateToISO: non-finite → null', () => {
  assert.equal(appleDateToISO(Infinity), null)
  assert.equal(appleDateToISO(NaN), null)
})

// ── normalizePhone ──────────────────────────────────────────────────────

test('normalizePhone: strips formatting and keeps last 10 digits', () => {
  assert.equal(normalizePhone('+1 (415) 555-0100'), '4155550100')
  assert.equal(normalizePhone('14155550100'), '4155550100')
  assert.equal(normalizePhone('4155550100'), '4155550100')
})

test('normalizePhone: fewer than 10 digits → null', () => {
  assert.equal(normalizePhone('555-0100'), null)
  assert.equal(normalizePhone(''), null)
  assert.equal(normalizePhone(null), null)
  assert.equal(normalizePhone(undefined), null)
})

// ── isHandleAllowed ─────────────────────────────────────────────────────

function prospects({ phones = [], emails = [] } = {}) {
  return {
    phones: new Set(phones),
    // server lowercases emails before they reach us — mirror that here
    emails: new Set(emails.map(e => e.toLowerCase())),
  }
}

test('isHandleAllowed: allowlisted phone matches regardless of formatting', () => {
  const p = prospects({ phones: ['4155550100'] })
  assert.equal(isHandleAllowed('+14155550100', p), true)
  assert.equal(isHandleAllowed('(415) 555-0100', p), true)
})

test('isHandleAllowed: non-allowlisted phone rejected', () => {
  const p = prospects({ phones: ['4155550100'] })
  assert.equal(isHandleAllowed('+14155559999', p), false)
})

test('isHandleAllowed: email match is case-insensitive', () => {
  const p = prospects({ emails: ['Lead@Example.com'] })
  assert.equal(isHandleAllowed('lead@example.com', p), true)
  assert.equal(isHandleAllowed('  LEAD@EXAMPLE.COM  ', p), true)
})

test('isHandleAllowed: unknown email rejected', () => {
  const p = prospects({ emails: ['lead@example.com'] })
  assert.equal(isHandleAllowed('stranger@example.com', p), false)
})

test('isHandleAllowed: null/empty handle or prospects → false', () => {
  assert.equal(isHandleAllowed(null, prospects()), false)
  assert.equal(isHandleAllowed('', prospects()), false)
  assert.equal(isHandleAllowed('4155550100', null), false)
})

// ── classifyMessage (the ship/drop security boundary) ───────────────────

const P = prospects({ phones: ['4155550100'], emails: ['lead@example.com'] })
const EXPECTED = 'connor@icloud.com'

test('inbound 1:1 from a prospect ships', () => {
  const msg = { is_from_me: 0, chat_kind: 'direct', handle: '+14155550100' }
  assert.equal(classifyMessage(msg, { prospects: P }), 'ship')
})

test('inbound 1:1 from a non-prospect (Mom/friend) is dropped', () => {
  const msg = { is_from_me: 0, chat_kind: 'direct', handle: '+14155559999' }
  assert.equal(classifyMessage(msg, { prospects: P }), 'drop_not_prospect')
})

test('outbound 1:1 from the configured Apple ID ships', () => {
  const msg = { is_from_me: 1, chat_kind: 'direct', handle: '+14155559999',
                account: 'iMessage;-;connor@icloud.com' }
  assert.equal(classifyMessage(msg, { prospects: P, expectedAppleId: EXPECTED }), 'ship')
})

test('outbound 1:1 from a DIFFERENT Apple ID is dropped (closes auto-extend backdoor)', () => {
  const msg = { is_from_me: 1, chat_kind: 'direct', handle: '+14155559999',
                account: 'iMessage;-;someone-else@icloud.com' }
  assert.equal(classifyMessage(msg, { prospects: P, expectedAppleId: EXPECTED }), 'drop_wrong_account')
})

test('outbound with no EXPECTED_APPLE_ID configured ships (back-compat)', () => {
  const msg = { is_from_me: 1, chat_kind: 'direct', handle: '+14155559999',
                account: 'iMessage;-;someone-else@icloud.com' }
  assert.equal(classifyMessage(msg, { prospects: P }), 'ship')
})

test('group containing a prospect participant ships', () => {
  const msg = { is_from_me: 0, chat_kind: 'group', handle: '+14155559999',
                chat_participants: ['+14155559999', 'lead@example.com'] }
  assert.equal(classifyMessage(msg, { prospects: P }), 'ship')
})

test('personal group with no prospect participant never leaves the Mac', () => {
  const msg = { is_from_me: 0, chat_kind: 'group', handle: '+14155559999',
                chat_participants: ['+14155559999', '+14155558888'] }
  assert.equal(classifyMessage(msg, { prospects: P }), 'drop_not_prospect')
})

test('group with null participants is dropped (no allowlisted member provable)', () => {
  const msg = { is_from_me: 0, chat_kind: 'group', handle: '+14155559999',
                chat_participants: null }
  assert.equal(classifyMessage(msg, { prospects: P }), 'drop_not_prospect')
})

test('wrong-account guard wins over group membership for outbound', () => {
  // Even a sales-relevant group must not ship outbound from the wrong iCloud.
  const msg = { is_from_me: 1, chat_kind: 'group', handle: '+14155550100',
                account: 'iMessage;-;someone-else@icloud.com',
                chat_participants: ['+14155550100'] }
  assert.equal(classifyMessage(msg, { prospects: P, expectedAppleId: EXPECTED }), 'drop_wrong_account')
})

test('EXPECTED_APPLE_ID may be the bare email (substring match on account)', () => {
  const msg = { is_from_me: 1, chat_kind: 'direct', handle: '+14155559999',
                account: 'iMessage;-;connor@icloud.com' }
  assert.equal(classifyMessage(msg, { prospects: P, expectedAppleId: 'connor@icloud.com' }), 'ship')
})
