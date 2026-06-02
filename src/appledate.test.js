'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { appleDateToISO } = require('./appledate')

// ── valid conversions ───────────────────────────────────────────────────────

test('appleDateToISO: nanosecond timestamp (Sierra+) converts correctly', () => {
  // 2020-01-01T00:00:00Z is (1577836800000 - 978307200000) ms = 599529600000 ms
  // past the Apple epoch → 599529600000 * 1e6 nanoseconds.
  assert.equal(appleDateToISO(599529600000000000), '2020-01-01T00:00:00.000Z')
})

test('appleDateToISO: legacy second timestamp converts correctly', () => {
  // 0 seconds past the Apple epoch = 2001-01-01T00:00:00Z (below the ns sentinel).
  assert.equal(appleDateToISO(0), '2001-01-01T00:00:00.000Z')
  // 1 day of seconds past the epoch.
  assert.equal(appleDateToISO(86400), '2001-01-02T00:00:00.000Z')
})

// ── missing / non-finite inputs → null (never throws) ────────────────────────

test('appleDateToISO: null / undefined return null', () => {
  assert.equal(appleDateToISO(null), null)
  assert.equal(appleDateToISO(undefined), null)
})

test('appleDateToISO: NaN and Infinity return null', () => {
  assert.equal(appleDateToISO(NaN), null)
  assert.equal(appleDateToISO(Infinity), null)
  assert.equal(appleDateToISO(-Infinity), null)
})

// ── the poison-pill regression: out-of-range dates must NOT throw ────────────

test('appleDateToISO: an out-of-range FUTURE timestamp returns null instead of throwing', () => {
  // Regression: new Date(ms).toISOString() throws RangeError for ms beyond the
  // representable range. A single such row used to reject the whole scan and
  // stall the cursor forever. It must now drop to null without throwing.
  assert.doesNotThrow(() => appleDateToISO(1e30))
  assert.equal(appleDateToISO(1e30), null)
})

test('appleDateToISO: an out-of-range PAST timestamp returns null instead of throwing', () => {
  assert.doesNotThrow(() => appleDateToISO(-1e30))
  assert.equal(appleDateToISO(-1e30), null)
})

test('appleDateToISO: a timestamp exactly at the Date range boundary stays valid', () => {
  // 8.64e15 ms past the unix epoch is the max representable Date. Expressed as
  // an Apple-epoch nanosecond value: (8.64e15 - 978307200000) ms * 1e6.
  const maxAppleNs = (8.64e15 - 978307200000) * 1e6
  assert.equal(appleDateToISO(maxAppleNs), new Date(8.64e15).toISOString())
})
