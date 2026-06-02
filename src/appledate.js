/**
 * Pugs Sync Agent — Apple Core Data date conversion (pure, no I/O).
 *
 * chat.db stores message timestamps as the offset from the Apple epoch
 * (2001-01-01 00:00:00 UTC) — in SECONDS on older macOS, or NANOSECONDS on
 * Sierra and later. The scanner maps this over every row to produce sent_at.
 *
 * Why this is its own pure, tested module: scan.js drops rows whose sent_at is
 * null, but it ran the conversion inline and `new Date(ms).toISOString()`
 * THROWS a RangeError for any timestamp outside the representable Date range
 * (~±273,790 years). A single corrupt/out-of-range date row would then reject
 * the whole scan before the cursor advanced past it — so the next run re-reads
 * the same poison row and crashes again, stalling ALL ingestion indefinitely.
 * Returning null instead lets scan.js's existing filter drop just that row and
 * ship the rest, advancing the cursor past it.
 */

'use strict'

// 2001-01-01T00:00:00Z expressed in unix milliseconds.
const APPLE_EPOCH_MS = 978307200000
// Modern macOS stores nanoseconds; values above this sentinel are treated as
// nanoseconds, below it as seconds. (A nanosecond timestamp for any plausible
// message date is ~1e17+; a seconds timestamp is ~1e9.)
const NS_SENTINEL = 1e15
// JS Date represents timestamps within ±8.64e15 ms of the epoch; beyond that
// new Date(ms).toISOString() throws "Invalid time value".
const MAX_DATE_MS = 8.64e15

/**
 * Convert an Apple Core Data timestamp into an ISO 8601 string.
 *
 * @param {number|null|undefined} d  Apple timestamp (seconds or nanoseconds)
 * @returns {string|null}  ISO string, or null for missing / non-finite /
 *                         out-of-range values (never throws)
 */
function appleDateToISO(d) {
  if (d === null || d === undefined || !Number.isFinite(d)) return null
  const ms = d > NS_SENTINEL ? (d / 1e6) + APPLE_EPOCH_MS : (d * 1000) + APPLE_EPOCH_MS
  if (!Number.isFinite(ms) || ms < -MAX_DATE_MS || ms > MAX_DATE_MS) return null
  return new Date(ms).toISOString()
}

module.exports = { APPLE_EPOCH_MS, NS_SENTINEL, MAX_DATE_MS, appleDateToISO }
