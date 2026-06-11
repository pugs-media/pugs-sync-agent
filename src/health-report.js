/**
 * Health Reporting — simple telemetry for scanner/poller/updater health.
 *
 * Each service sends a POST to pugs-sales /api/sync/health with:
 *   { service: "scanner|poller|updater", status: "ok|error",
 *     item_count?: number, error?: string, run_duration_ms?: number }
 *
 * This gives Charlie visibility into whether all four services are running
 * without SSH-ing into Connor's Mac. Beacons are best-effort (timeouts are
 * swallowed) so a cloud outage doesn't crash the agent.
 */

const { fetchWithTimeout } = require('./fetch-timeout')

/**
 * Report a service run to the cloud health endpoint.
 * Best-effort — swallows network errors and timeouts.
 * Never throws or crashes the agent.
 *
 * @param {string} service        "scanner" | "poller" | "updater"
 * @param {string} status         "ok" | "error"
 * @param {object} opts           { itemCount?, errorMessage?, durationMs?, webhookUrl?, secret?, scannerId? }
 */
async function reportHealth(service, status, {
  itemCount = undefined,
  errorMessage = undefined,
  durationMs = undefined,
  _fetch = fetch,
  _timeoutMs = 5000,
  webhookUrl = process.env.PUGS_SYNC_WEBHOOK_URL,
  secret = process.env.PUGS_SYNC_SECRET,
  scannerId = process.env.PUGS_SCANNER_ID || '',
} = {}) {
  if (!webhookUrl || !secret) {
    // No-op if config is missing (e.g. during tests)
    return
  }

  let url
  try {
    const base = new URL(webhookUrl).origin
    url = `${base}/api/sync/health`
  } catch (e) {
    // Invalid webhook URL — swallow and return (best-effort)
    console.warn(`health report ${service} config error (malformed URL): ${e.message || e}`)
    return
  }

  const payload = { service, status }
  if (itemCount !== undefined) payload.item_count = itemCount
  if (errorMessage !== undefined) payload.error = errorMessage
  if (durationMs !== undefined) payload.run_duration_ms = durationMs

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pugs-sync-secret': secret,
        'x-pugs-scanner-id': scannerId,
      },
      body: JSON.stringify(payload),
    }, _timeoutMs, _fetch)
    if (!res.ok) {
      // Cloud rejected it; log but don't crash
      const text = await res.text()
      console.warn(`health report ${service} rejected: ${res.status} ${text.slice(0, 100)}`)
    }
  } catch (e) {
    // Network error, timeout, or cloud down — swallow it
    console.warn(`health report ${service} failed (non-fatal): ${e.message || e}`)
  }
}

module.exports = { reportHealth }
