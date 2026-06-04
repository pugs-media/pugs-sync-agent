/**
 * Pugs Sync Agent — AppleScript builders (pure, no I/O).
 *
 * The outbound sender (src/send.js) hands user-controlled `to` and `text`
 * values into an `osascript` invocation. That string is interpolated into an
 * AppleScript double-quoted literal, so anything that can terminate or corrupt
 * that literal is an injection / corruption surface. Keeping the escaping and
 * script assembly pure (no network, no child_process) lets us unit-test the
 * boundary — a regression here either breaks legitimate sends or lets a crafted
 * handle/body alter the script.
 */

/**
 * Escape a JS string for safe interpolation into an AppleScript double-quoted
 * string literal. AppleScript supports the C-style escapes \\ \" \n \r \t inside
 * "..." literals, so we map to those rather than stripping. Every other control
 * character (which AppleScript cannot represent inside a literal and would
 * either error or be swallowed) is dropped.
 *
 * @param {string|null|undefined} s
 * @returns {string}
 */
function escapeAppleScriptString(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/[\\"\n\r\t]/g, (ch) => {
      switch (ch) {
        case '\\': return '\\\\'
        case '"':  return '\\"'
        case '\n': return '\\n'
        case '\r': return '\\r'
        case '\t': return '\\t'
        default:   return ch
      }
    })
    // Strip any remaining C0 control chars + DEL (\x00-\x1f minus the \t \n \r
    // we mapped above, plus \x7f). A raw one of these inside the literal
    // corrupts the AppleScript source.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/**
 * Build the AppleScript that sends `text` to handle `to` over Messages.app.
 * `service` selects the Messages service type; anything other than 'SMS'
 * defaults to 'iMessage'. Both `to` and `text` are escaped so a quote,
 * backslash, or newline in either cannot break out of the string literal.
 *
 * The script wraps the send in a try/on error block and writes "ok" to stdout
 * on success or "error:<code>:<message>" on failure. This means send.js can
 * validate the send actually succeeded by checking stdout — not just the
 * osascript exit code, which is 0 even on AppleScript runtime errors like
 * buddy-not-found.
 *
 * @param {{to: string, text: string, service?: string}} args
 * @returns {string} AppleScript source suitable for `osascript -e`.
 */
function buildSendScript({ to, text, service } = {}) {
  const svc = service === 'SMS' ? 'SMS' : 'iMessage'
  const safeTo   = escapeAppleScriptString(to)
  const safeText = escapeAppleScriptString(text)
  return `
    tell application "Messages"
      try
        set targetService to 1st service whose service type = ${svc}
        set targetBuddy to buddy "${safeTo}" of targetService
        send "${safeText}" to targetBuddy
        return "ok"
      on error errMsg number errNum
        return "error:" & errNum & ":" & errMsg
      end try
    end tell
  `
}

/**
 * Parse the stdout from an osascript buildSendScript invocation.
 * Returns { ok: true } if the send succeeded, or { ok: false, detail: string }
 * if the AppleScript reported a runtime error or returned unexpected output.
 *
 * @param {string|null|undefined} stdout
 * @returns {{ ok: boolean, detail?: string }}
 */
function parseOsascriptResult(stdout) {
  const result = (stdout || '').trim()
  if (result === 'ok') return { ok: true }
  if (result.startsWith('error:')) {
    return { ok: false, detail: result.slice(6, 406) }
  }
  return { ok: false, detail: result ? `unexpected result: ${result.slice(0, 400)}` : 'no output from osascript' }
}

module.exports = { escapeAppleScriptString, buildSendScript, parseOsascriptResult }
