'use strict'

/**
 * Wraps _fetch with an AbortController-based timeout. Merges the abort signal
 * into opts so mock fetches in tests can honour it. Clears the timer on
 * success or failure to prevent handle leaks.
 *
 * Matches the pattern already used by dispatchToLocalSender in poll.js —
 * generalised here so all cloud-facing fetches share one implementation.
 *
 * @param {string}   url
 * @param {object}   opts        - fetch init options (merged with signal)
 * @param {number}   timeoutMs   - abort after this many milliseconds
 * @param {function} _fetch      - injectable fetch (tests / prod)
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, opts, timeoutMs, _fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return _fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

module.exports = { fetchWithTimeout }
