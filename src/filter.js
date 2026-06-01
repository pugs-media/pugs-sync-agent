/**
 * Pugs Sync Agent — message-filter primitives (pure, no I/O).
 *
 * This module holds the security-critical logic that decides which iMessages
 * are allowed to leave Connor's Mac and reach the pugs-sales cloud. Keeping it
 * pure (no DB, no network, no env) lets us unit-test the allowlist boundary —
 * a regression here would leak private messages, so it must stay covered.
 *
 * Extracted verbatim from scan.js so behavior is unchanged; scan.js now imports
 * these helpers.
 */

/**
 * Apple Core Data dates are seconds (older macOS) OR nanoseconds (Sierra+)
 * since 2001-01-01 00:00:00 UTC (978307200 unix seconds). Auto-detect.
 * @param {number|null|undefined} d
 * @returns {string|null} ISO-8601 string, or null if undecodable.
 */
function appleDateToISO(d) {
  if (d === null || d === undefined) return null
  // Sentinel: nanoseconds since 2001 is > 1e15 in modern macOS
  const ms = d > 1e15 ? (d / 1e6) + 978307200000 : (d * 1000) + 978307200000
  if (!isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/**
 * Normalize a phone handle to its last 10 digits (US numbering), or null if it
 * doesn't reduce to exactly 10 digits.
 * @param {string|null|undefined} handle
 * @returns {string|null}
 */
function normalizePhone(handle) {
  if (!handle) return null
  const digits = String(handle).replace(/\D/g, '').slice(-10)
  return digits.length === 10 ? digits : null
}

/**
 * Is a single handle (phone or email) an allowlisted prospect/client?
 * @param {string|null|undefined} handle
 * @param {{phones: Set<string>, emails: Set<string>}} prospects
 *        phones = 10-digit strings; emails = lowercased addresses.
 * @returns {boolean}
 */
function isHandleAllowed(handle, prospects) {
  if (!handle || !prospects) return false
  if (handle.includes('@')) {
    return prospects.emails.has(handle.trim().toLowerCase())
  }
  const digits = normalizePhone(handle)
  return digits !== null && prospects.phones.has(digits)
}

/**
 * Classify whether a single mapped message row should ship to pugs-sales.
 *
 * Mirrors the prospect-intersect filter exactly:
 *   - Wrong-iCloud guard runs first: an outbound row whose `account` doesn't
 *     match EXPECTED_APPLE_ID is dropped (closes the auto-extend backdoor),
 *     regardless of chat kind.
 *   - Group chats: keep iff a client/prospect handle is among the participants
 *     (personal groups never leave the Mac).
 *   - Direct 1:1: outbound passes; inbound passes only from an allowlisted
 *     prospect/client handle.
 *
 * @param {object} p mapped message ({ is_from_me, account, chat_kind,
 *        chat_participants, handle })
 * @param {{prospects: {phones:Set,emails:Set}, expectedAppleId?: string}} opts
 * @returns {'ship'|'drop_wrong_account'|'drop_not_prospect'}
 */
function classifyMessage(p, { prospects, expectedAppleId = '' } = {}) {
  if (p.is_from_me && expectedAppleId && p.account && !p.account.includes(expectedAppleId)) {
    return 'drop_wrong_account'
  }
  if (p.chat_kind === 'group') {
    const ok = Array.isArray(p.chat_participants) &&
               p.chat_participants.some(h => isHandleAllowed(h, prospects))
    return ok ? 'ship' : 'drop_not_prospect'
  }
  if (p.is_from_me) return 'ship'
  return isHandleAllowed(p.handle, prospects) ? 'ship' : 'drop_not_prospect'
}

module.exports = { appleDateToISO, normalizePhone, isHandleAllowed, classifyMessage }
