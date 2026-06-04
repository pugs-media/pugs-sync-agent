/**
 * Pugs Sync Agent — Outbound dispatch planning (pure, no I/O).
 *
 * The poller (src/poll.js) pulls items off the cloud outbound queue and hands
 * each one to the LOCAL sender, which fires a real iMessage from a teammate's
 * personal Mac. That makes the per-item decision — send / skip / fail — a
 * sensitive boundary worth isolating and unit-testing, the same way the scanner
 * scoping rules were extracted into filter.js.
 *
 * This module owns ONLY the decision; the poller owns the network calls. Keeping
 * it pure (no fetch, no env) lets us lock the behaviour with tests so a refactor
 * can't silently change which queue items reach Messages.app.
 *
 * Decisions:
 *   - 'send' : the item is well-formed and under the retry ceiling → dispatch.
 *   - 'skip' : attempts >= maxAttempts → report as 'skipped' so the cloud can
 *              reap the dead row; without a report it stays 'pending' forever
 *              and consumes a queue slot on every poll cycle.
 *   - 'fail' : the item is structurally present (has an id) but its to_handle or
 *              body is missing/blank → report 'failed' WITHOUT touching the local
 *              sender, so a malformed/blank row can never misfire a real send.
 *   - 'drop' : the item is not a usable object / has no id → can't be reported,
 *              just log and move on.
 */

'use strict'

/** A value usable as an iMessage handle or body: a non-blank string. */
function isUsableString(v) {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Decide what the poller should do with one outbound-queue item.
 *
 * @param {{id?: any, to_handle?: any, body?: any, attempts?: any}} item
 * @param {{maxAttempts: number}} opts
 * @returns {{action: 'send'|'skip'|'fail'|'drop', reason?: string}}
 */
function planItem(item, { maxAttempts }) {
  if (!item || typeof item !== 'object' || item.id === undefined || item.id === null) {
    return { action: 'drop', reason: 'malformed-item' }
  }

  // attempts is advisory metadata from the cloud; treat anything non-numeric as 0
  // so a missing/garbled count fails open to "try it" rather than skipping forever.
  const attempts = Number.isFinite(item.attempts) ? item.attempts : 0
  if (attempts >= maxAttempts) {
    return { action: 'skip', reason: 'max-attempts' }
  }

  // Guard the send path: a queue row with no usable recipient or an empty/blank
  // body must never reach AppleScript. Whitespace-only bodies are rejected here
  // too — the sender treats them as truthy and would dispatch a blank iMessage.
  if (!isUsableString(item.to_handle)) {
    return { action: 'fail', reason: 'missing-or-blank-to_handle' }
  }
  if (!isUsableString(item.body)) {
    return { action: 'fail', reason: 'missing-or-blank-body' }
  }

  return { action: 'send' }
}

module.exports = { isUsableString, planItem }
