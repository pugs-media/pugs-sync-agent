'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  PARTICIPANT_SEPARATOR,
  parseParticipants,
  normalizeRow,
  normalizeRows,
} = require('./payload')

// The separator MUST be the ASCII Unit Separator (0x1F) that chat.db's
// group_concat(handle, char(31)) joins on. Locking it here means a future edit
// that drops the (invisible) separator down to '' — which would explode every
// participant list into single characters and silently drop all group chats —
// fails this suite instead of shipping.
test('PARTICIPANT_SEPARATOR is the ASCII Unit Separator (0x1F)', () => {
  assert.equal(PARTICIPANT_SEPARATOR, '\x1f')
  assert.equal(PARTICIPANT_SEPARATOR.charCodeAt(0), 31)
})

test('parseParticipants: splits a multi-handle concat on the unit separator', () => {
  const concat = ['+14155550100', 'client@acme.com', '+14155550111'].join('\x1f')
  assert.deepEqual(parseParticipants(concat), [
    '+14155550100',
    'client@acme.com',
    '+14155550111',
  ])
})

test('parseParticipants: a single handle yields a one-element array (not chars)', () => {
  // Regression guard: split('') would return ['+','1','4',...]; split on the
  // separator returns the whole handle intact.
  assert.deepEqual(parseParticipants('+14155550100'), ['+14155550100'])
})

test('parseParticipants: null/empty concat yields null (chat has no handles)', () => {
  assert.equal(parseParticipants(null), null)
  assert.equal(parseParticipants(undefined), null)
  assert.equal(parseParticipants(''), null)
})

test('parseParticipants: drops empty fragments from leading/trailing separators', () => {
  const concat = '\x1f+14155550100\x1f\x1fclient@acme.com\x1f'
  assert.deepEqual(parseParticipants(concat), ['+14155550100', 'client@acme.com'])
})

// A valid Apple nanosecond timestamp (2024-01-01T00:00:00Z) so sent_at is
// non-null and the row survives the drop filter.
const APPLE_NS_2024 = (1704067200000 - 978307200000) * 1e6

function baseRow(overrides = {}) {
  return {
    rowid: 42,
    guid: 'ABC-123',
    text: 'hello there',
    date: APPLE_NS_2024,
    is_from_me: 0,
    service: 'iMessage',
    account: 'iMessage;-;owner@icloud.com',
    handle: '+14155550100',
    chat_guid: 'iMessage;-;+14155550100',
    chat_display_name: null,
    participant_count: 1,
    chat_participants_concat: '+14155550100',
    ...overrides,
  }
}

test('normalizeRow: maps a direct 1:1 inbound row into the cloud shape', () => {
  const p = normalizeRow(baseRow())
  assert.equal(p.rowid, 42)
  assert.equal(p.guid, 'ABC-123')
  assert.equal(p.text, 'hello there')
  assert.equal(p.sent_at, '2024-01-01T00:00:00.000Z')
  assert.equal(p.is_from_me, 0)
  assert.equal(p.handle, '+14155550100')
  assert.equal(p.account, 'iMessage;-;owner@icloud.com')
  assert.equal(p.service, 'iMessage')
  assert.equal(p.chat_id, 'iMessage;-;+14155550100')
  assert.equal(p.chat_kind, 'direct')
  assert.equal(p.chat_name, null)
  assert.deepEqual(p.chat_participants, ['+14155550100'])
})

test('normalizeRow: participant_count > 1 is classified as a group with parsed members', () => {
  const p = normalizeRow(baseRow({
    participant_count: 3,
    chat_display_name: 'Acme Deal',
    chat_participants_concat: ['+14155550100', 'client@acme.com', '+14155550111'].join('\x1f'),
  }))
  assert.equal(p.chat_kind, 'group')
  assert.equal(p.chat_name, 'Acme Deal')
  assert.deepEqual(p.chat_participants, ['+14155550100', 'client@acme.com', '+14155550111'])
})

test('normalizeRow: is_from_me is coerced to 1/0 and SMS service preserved', () => {
  const sent = normalizeRow(baseRow({ is_from_me: 1, service: 'SMS' }))
  assert.equal(sent.is_from_me, 1)
  assert.equal(sent.service, 'SMS')
  // Any non-SMS service normalizes to iMessage.
  assert.equal(normalizeRow(baseRow({ service: 'RCS' })).service, 'iMessage')
})

test('normalizeRow: blank account/chat_guid/chat_display_name become null', () => {
  const p = normalizeRow(baseRow({ account: '', chat_guid: '', chat_display_name: '' }))
  assert.equal(p.account, null)
  assert.equal(p.chat_id, null)
  assert.equal(p.chat_name, null)
})

test('normalizeRow: a corrupt/out-of-range date yields sent_at null (never throws)', () => {
  // Far beyond the representable Date range — appledate returns null rather
  // than throwing, so the row can be dropped instead of crashing the scan.
  const p = normalizeRow(baseRow({ date: 9.99e30 }))
  assert.equal(p.sent_at, null)
})

test('normalizeRows: drops inbound rows with no usable timestamp or sender handle', () => {
  const rows = [
    baseRow({ rowid: 1 }),                       // keep
    baseRow({ rowid: 2, date: 9.99e30 }),        // drop: bad date → sent_at null
    baseRow({ rowid: 3, handle: null }),         // drop: inbound, no sender handle
    baseRow({ rowid: 4, handle: 'x@y.com', chat_participants_concat: null }), // keep
  ]
  const kept = normalizeRows(rows)
  assert.deepEqual(kept.map(r => r.rowid), [1, 4])
  assert.equal(kept[1].chat_participants, null)
})

test('normalizeRows: KEEPS an outbound row even with a null handle', () => {
  // chat.db sets message.handle_id = 0 for the owner's own sent messages, so the
  // scanner's LEFT JOIN handle yields handle === null on every outbound row.
  // Dropping those would discard the owner's first-touch outbound before it ever
  // reaches filter.js — which is exactly the row filter.js is built to ship.
  const kept = normalizeRows([
    baseRow({ rowid: 10, is_from_me: 1, handle: null }),                 // keep (outbound)
    baseRow({ rowid: 11, is_from_me: 0, handle: null }),                 // drop (inbound, no sender)
    baseRow({ rowid: 12, is_from_me: 1, handle: null, date: 9.99e30 }),  // drop (outbound but bad date)
  ])
  assert.deepEqual(kept.map(r => r.rowid), [10])
  assert.equal(kept[0].is_from_me, 1)
  assert.equal(kept[0].handle, null)
})

test('normalizeRows: a truthy non-1 is_from_me still keeps a handle-less outbound row', () => {
  // is_from_me is coerced to 1/0 in the row shape, so the filter must treat the
  // normalized (post-coercion) flag — guard against a regression to raw values.
  const kept = normalizeRows([baseRow({ rowid: 20, is_from_me: true, handle: null })])
  assert.deepEqual(kept.map(r => r.rowid), [20])
})

test('normalizeRows: empty input yields empty output', () => {
  assert.deepEqual(normalizeRows([]), [])
})
