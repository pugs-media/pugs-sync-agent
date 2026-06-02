/**
 * Pugs Sync Agent — Scanner scoping filter (pure, no I/O).
 *
 * This is the security boundary that decides which iMessage rows are allowed
 * to leave a teammate's personal Mac and reach pugs-sales. Getting it wrong
 * either exfiltrates personal/non-prospect messages or silently broadens the
 * allowlist via an outbound "first-touch" from the wrong iCloud account.
 *
 * The rules (recent security fixes — see scan.js comments for history):
 *   1. Wrong-iCloud guard: an outbound (is_from_me) row only counts as the
 *      configured owner's deliberate first-touch when its chat.db `account`
 *      matches EXPECTED_APPLE_ID. Outbound from a *different* signed-in iCloud
 *      is dropped — that closes the prospect auto-extend backdoor.
 *   2. Group chats: shipped only when at least one participant is an
 *      allowlisted prospect/client. Personal groups never leave the Mac.
 *   3. Direct 1:1: owner's outbound passes; inbound passes only from an
 *      allowlisted prospect/client handle.
 *
 * Kept pure (no network, no DB, no env reads) so the boundary is unit-testable
 * — scan.js feeds it the prospect allowlist and EXPECTED_APPLE_ID.
 */

'use strict'

/**
 * Build a predicate that answers "is this single handle (phone or email) an
 * allowlisted prospect/client?" against the fetched prospect sets.
 *
 * Phones are matched on their last 10 digits (NANP local number) so that
 * +1-415-555-0100, (415) 555-0100, 14155550100 all collapse to the same key.
 * Emails are matched case-insensitively after trimming.
 *
 * @param {{phones: Set<string>, emails: Set<string>}} prospects
 * @returns {(handle: string|null|undefined) => boolean}
 */
function makeHandleAllowed(prospects) {
  const phones = prospects && prospects.phones ? prospects.phones : new Set()
  const emails = prospects && prospects.emails ? prospects.emails : new Set()
  return function handleAllowed(handle) {
    if (!handle) return false
    if (handle.includes('@')) return emails.has(handle.trim().toLowerCase())
    const digits = handle.replace(/\D/g, '').slice(-10)
    return digits.length === 10 && phones.has(digits)
  }
}

/**
 * Decide whether a single normalized message payload row is in scope to ship.
 *
 * @param {object} p                       normalized row (see scan.js payload map)
 * @param {object} opts
 * @param {(h: string) => boolean} opts.handleAllowed  allowlist predicate
 * @param {string} [opts.expectedAppleId]  EXPECTED_APPLE_ID ('' = no filter)
 * @returns {{keep: boolean, reason: 'wrong-apple-id'|'not-prospect'|'outbound'|'prospect'|'group-prospect'}}
 */
function classifyMessage(p, { handleAllowed, expectedAppleId = '' }) {
  // Wrong-iCloud guard applies to every kind of message: an outbound row whose
  // account doesn't match the configured Apple ID is a different iCloud's send.
  // (account looks like "iMessage;-;cjfpug@icloud.com"; includes() lets
  // EXPECTED_APPLE_ID be the bare email/phone.)
  if (p.is_from_me && expectedAppleId && p.account && !p.account.includes(expectedAppleId)) {
    return { keep: false, reason: 'wrong-apple-id' }
  }

  if (p.chat_kind === 'group') {
    // Sales-relevant groups only: keep iff a client/prospect is in the room.
    const keep = Array.isArray(p.chat_participants) && p.chat_participants.some(handleAllowed)
    return { keep, reason: keep ? 'group-prospect' : 'not-prospect' }
  }

  // Direct 1:1: owner's outbound (already passed the wrong-iCloud guard) passes;
  // inbound passes only from an allowlisted prospect/client handle.
  if (p.is_from_me) return { keep: true, reason: 'outbound' }
  return handleAllowed(p.handle)
    ? { keep: true, reason: 'prospect' }
    : { keep: false, reason: 'not-prospect' }
}

/**
 * Filter a batch of normalized message rows down to the ones allowed to ship,
 * returning drop counts for logging.
 *
 * @param {object[]} payload
 * @param {{prospects: {phones: Set<string>, emails: Set<string>}, expectedAppleId?: string}} opts
 * @returns {{kept: object[], droppedWrongAccount: number, droppedNotProspect: number}}
 */
function filterMessages(payload, { prospects, expectedAppleId = '' }) {
  const handleAllowed = makeHandleAllowed(prospects)
  const kept = []
  let droppedWrongAccount = 0
  let droppedNotProspect = 0
  for (const p of payload) {
    const { keep, reason } = classifyMessage(p, { handleAllowed, expectedAppleId })
    if (keep) {
      kept.push(p)
    } else if (reason === 'wrong-apple-id') {
      droppedWrongAccount++
    } else {
      droppedNotProspect++
    }
  }
  return { kept, droppedWrongAccount, droppedNotProspect }
}

module.exports = { makeHandleAllowed, classifyMessage, filterMessages }
