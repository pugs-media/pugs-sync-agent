/**
 * Pugs Sync Agent — chat.db row → cloud payload normalization (pure, no I/O).
 *
 * scan.js reads raw rows out of the chat.db snapshot and maps each one into the
 * shape pugs-sales expects before the scoping filter (filter.js) decides which
 * rows may ship. That mapping used to live inline in scan.js, untested — which
 * is exactly where a subtle parsing bug hid: the group-participant list was
 * split on the empty string ('') instead of the ASCII Unit Separator the SQL
 * group_concat joins on, turning every participant list into an array of single
 * characters. Because filter.js keeps a group chat only when one of its
 * participants is an allowlisted prospect, that bug silently dropped EVERY
 * sales-relevant group chat (defeating commit 313ab80) and shipped garbage
 * thread-identity data to the cloud.
 *
 * Extracting the mapping here (same pattern as filter.js / dispatch.js /
 * appledate.js) makes the boundary unit-testable so a separator typo can't
 * regress it again.
 */

'use strict'

const { appleDateToISO } = require('./appledate')

// chat.db's group_concat(handle, char(31)) joins participant handles with the
// ASCII Unit Separator (0x1F). It can't collide with phone/email content, so we
// split the concatenated column back on the SAME separator. Splitting on '' (the
// empty string) instead explodes the value into individual characters — the bug
// this module exists to prevent.
const PARTICIPANT_SEPARATOR = '\x1f'

/**
 * Parse the group_concat participant column back into an array of handles.
 * Returns null when the chat has no participant handles (column is null/empty),
 * matching the chat_participants contract scan.js sends to the cloud.
 *
 * @param {string|null|undefined} concat
 * @returns {string[]|null}
 */
function parseParticipants(concat) {
  if (!concat) return null
  return concat.split(PARTICIPANT_SEPARATOR).filter(Boolean)
}

/**
 * Normalize one raw chat.db row into the cloud payload shape.
 *
 * @param {object} r  raw row from scan.js's SELECT
 * @returns {object}  normalized payload row (sent_at may be null → dropped later)
 */
function normalizeRow(r) {
  return {
    rowid: r.rowid,
    guid: r.guid,
    text: r.text,
    sent_at: appleDateToISO(r.date),
    is_from_me: r.is_from_me ? 1 : 0,
    handle: r.handle,
    account: r.account || null,
    service: r.service === 'SMS' ? 'SMS' : 'iMessage',
    chat_id: r.chat_guid || null,
    // 1 external handle = direct (owner + one other); 2+ = group.
    chat_kind: r.participant_count === 1 ? 'direct' : 'group',
    chat_name: r.chat_display_name || null,
    chat_participants: parseParticipants(r.chat_participants_concat),
  }
}

/**
 * Normalize a batch of raw rows, dropping any row that lacks a usable timestamp
 * (a corrupt/out-of-range Apple date yields sent_at === null and is dropped here
 * rather than crashing the scan — see appledate.js).
 *
 * The sender-handle requirement applies to INBOUND rows ONLY. chat.db stores
 * `message.handle_id = 0` for the owner's own sent messages, so the scanner's
 * `LEFT JOIN handle` yields handle === null on every outbound row. Dropping
 * those here would discard the owner's outbound messages before they ever reach
 * filter.js — which is the module that deliberately ships outbound 1:1s (the
 * "first-touch" that auto-extends the prospect allowlist server-side) and gates
 * outbound via the wrong-iCloud guard. So we keep handle-less rows when they're
 * outbound (is_from_me) and let filter.js make the ship/drop call; inbound rows
 * still need a sender handle (an inbound message with no sender can't be scoped).
 *
 * @param {object[]} rows
 * @returns {object[]} normalized, shippable rows
 */
function normalizeRows(rows) {
  return rows.map(normalizeRow).filter(r => r.sent_at && (r.handle || r.is_from_me))
}

module.exports = { PARTICIPANT_SEPARATOR, parseParticipants, normalizeRow, normalizeRows }
