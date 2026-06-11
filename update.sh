#!/bin/bash
# Pugs Sync Agent — self-updater.
#
# Runs on Connor's Mac every N minutes via launchd. Pulls latest code
# from the remote, reinstalls deps if needed, and reloads the launchd
# services so the new code is live. No human in the loop.
#
# Safe by design:
#   - `git pull --ff-only` — won't auto-merge over local edits, just
#     bails. If Connor manually edits files, updates pause until those
#     are resolved (intentional).
#   - If `npm install` fails, services are NOT reloaded; the previous
#     version stays running.
#   - .env / state.json / *.log are gitignored; an update never touches
#     Connor's local config or runtime state.
#
# Run by launchd: com.pugs.syncagent.updater.plist (every 600s).
# Logs in updater.log / updater.error.log next to this script.

set -u  # NOT -e — we want to gracefully handle individual step failures

AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_PREFIX="$(date -u +%Y-%m-%dT%H:%M:%SZ) update.sh:"

cd "$AGENT_ROOT" || { echo "$LOG_PREFIX cannot cd $AGENT_ROOT"; exit 1; }

# ── Watchdog: self-heal a dead scanner ─────────────────────────────────────
# Scanner runs every 5min on StartInterval. If scanner.log hasn't been
# touched in >30min, something fucked up (launchd gave up after crash-loop,
# FDA silently revoked, post-sleep-wake bug, etc.) — panic-restart fixes
# ~all of these. 30min = 6 missed scan cycles, generous enough to ignore
# brief sleep/wake gaps but tight enough to recover within ~10min of any
# real stall (next updater tick after the threshold is breached).
#
# This runs BEFORE the git-pull logic so even a no-op update (no new
# commits) still exercises the watchdog. Charlie should never need to
# remote-recover the agent again.
SCANNER_LOG="$AGENT_ROOT/scanner.log"
WATCHDOG_THRESHOLD_SEC=1800

if [ -f "$SCANNER_LOG" ]; then
  log_mtime=$(stat -f %m "$SCANNER_LOG" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - log_mtime))

  # Two failure modes to catch:
  #   (1) scanner.log mtime stale     → launchd gave up scheduling scanner
  #   (2) scanner.log is fresh BUT no "Webhook OK" line in last 30min
  #       → scanner is crash-looping (e.g. FDA revoked silently — every
  #       launch errors before POSTing, but the log keeps being written).
  watchdog_fire=0
  watchdog_reason=""

  if [ "$age" -gt "$WATCHDOG_THRESHOLD_SEC" ]; then
    watchdog_fire=1
    watchdog_reason="scanner.log stale (${age}s old)"
  else
    # Check for a recent successful POST. The grep is greedy on purpose:
    # any of "Webhook OK", "sending heartbeat", or "Posting N messages"
    # within the last 200 lines is a sign of life. tail-then-grep
    # cheap even when the log is huge.
    if ! tail -200 "$SCANNER_LOG" 2>/dev/null | grep -qE "Webhook OK|sending heartbeat|Posting [0-9]+ messages"; then
      watchdog_fire=1
      watchdog_reason="scanner.log fresh but no recent success line — crash-loop suspected"
    fi
  fi

  if [ "$watchdog_fire" -eq 1 ]; then
    echo "$LOG_PREFIX WATCHDOG $watchdog_reason — running panic-restart.sh"
    bash "$AGENT_ROOT/panic-restart.sh" 2>&1 | sed "s|^|$LOG_PREFIX panic: |"

    # Beacon to pugs-sales so Charlie sees the self-heal fire in Vercel logs.
    # Best-effort (no -f, no retry, 5s timeout) — recovery already succeeded
    # locally; the POST is purely for observability. Repeated fires = genuine
    # broken state that self-heal isn't curing → Charlie should investigate.
    if [ -f "$AGENT_ROOT/.env" ]; then
      # shellcheck disable=SC1091
      . "$AGENT_ROOT/.env"
      if [ -n "${PUGS_SYNC_SECRET:-}" ] && [ -n "${PUGS_SYNC_WEBHOOK_URL:-}" ]; then
        # Derive base URL from PUGS_SYNC_WEBHOOK_URL (strip /api/import/imessage)
        BASE_URL="${PUGS_SYNC_WEBHOOK_URL%/api/import/imessage}"
        curl -sS -m 5 -X POST "$BASE_URL/api/sync/watchdog-fired" \
          -H "x-pugs-sync-secret: $PUGS_SYNC_SECRET" \
          -H "x-pugs-scanner-id: ${PUGS_SCANNER_ID:-}" \
          -H "content-type: application/json" \
          -d "{\"reason\":\"scanner.log stale\",\"age_seconds\":$age}" \
          >/dev/null 2>&1 \
          && echo "$LOG_PREFIX WATCHDOG beacon sent to pugs-sales" \
          || echo "$LOG_PREFIX WATCHDOG beacon failed (non-fatal)"
      fi
    fi

    echo "$LOG_PREFIX WATCHDOG done — skipping git update this run, will resume next cycle"
    exit 0
  fi
fi

# Capture the current HEAD before fetch so we can detect a no-op.
OLD_HEAD=$(git rev-parse HEAD 2>/dev/null || echo unknown)

# Timeout git fetch to prevent a hung network from stalling the updater
# and blocking all subsequent update cycles. 30s is generous for a normal
# fetch but tight enough to fail fast on SSH stalls or network hangs.
if ! timeout 30 git fetch --quiet 2>&1; then
  echo "$LOG_PREFIX git fetch failed (network? auth? timeout?), bailing"
  exit 0
fi

merge_out=$(git merge --ff-only origin/main 2>&1)
if [ $? -ne 0 ]; then
  # FF-only fails when there are local commits/edits OR when origin diverged.
  # We don't auto-resolve — Connor or Charlie has to sort it.
  echo "$LOG_PREFIX fast-forward merge failed (local changes or diverged), bailing"
  echo "$LOG_PREFIX merge detail: $(echo "$merge_out" | head -5 | tr '\n' '|')"
  exit 0
fi

NEW_HEAD=$(git rev-parse HEAD)
if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  # No new commits — common case, exit silently.
  exit 0
fi

echo "$LOG_PREFIX pulled $OLD_HEAD..$NEW_HEAD"

# Reinstall deps in case package.json changed. --no-audit --no-fund for speed;
# --loglevel error keeps errors visible while suppressing progress/info noise.
# Wrap in timeout so a hung registry/node process doesn't block the entire updater.
if ! npm_out=$(timeout 30 npm install --loglevel error --no-audit --no-fund 2>&1); then
  echo "$LOG_PREFIX npm install failed — NOT reloading services, prior version still running"
  printf '%s\n' "$npm_out" | head -20 | sed "s|^|$LOG_PREFIX npm: |"
  # Report the failure to the cloud
  if [ -f "$AGENT_ROOT/.env" ]; then
    # shellcheck disable=SC1091
    . "$AGENT_ROOT/.env"
    if [ -n "${PUGS_SYNC_SECRET:-}" ] && [ -n "${PUGS_SYNC_WEBHOOK_URL:-}" ]; then
      BASE_URL="${PUGS_SYNC_WEBHOOK_URL%/api/import/imessage}"
      curl -sS -m 5 -X POST "$BASE_URL/api/sync/health" \
        -H "x-pugs-sync-secret: $PUGS_SYNC_SECRET" \
        -H "x-pugs-scanner-id: ${PUGS_SCANNER_ID:-}" \
        -H "content-type: application/json" \
        -d '{"service":"updater","status":"error","error":"npm install failed"}' \
        >/dev/null 2>&1 || true
    fi
  fi
  exit 1
fi

# Reload the three runtime services. Updater itself doesn't reload itself
# (launchd will pick up plist changes on the next StartInterval tick).
# If any service fails to reload, the entire update is treated as failed
# (exit 1) so update.log shows a clear error and the watchdog can alert.
reload_failed=0
for kind in scanner sender poller; do
  dst="$LAUNCH_DIR/com.pugs.syncagent.$kind.plist"
  if [ -f "$dst" ]; then
    launchctl unload "$dst" 2>/dev/null
    if ! launchctl load "$dst" 2>&1; then
      echo "$LOG_PREFIX launchctl load $kind failed"
      reload_failed=1
    fi
  fi
done

if [ "$reload_failed" -eq 1 ]; then
  echo "$LOG_PREFIX service reload failed — update rolled back to previous version"
  # Report the reload failure to the cloud
  if [ -f "$AGENT_ROOT/.env" ]; then
    # shellcheck disable=SC1091
    . "$AGENT_ROOT/.env"
    if [ -n "${PUGS_SYNC_SECRET:-}" ] && [ -n "${PUGS_SYNC_WEBHOOK_URL:-}" ]; then
      BASE_URL="${PUGS_SYNC_WEBHOOK_URL%/api/import/imessage}"
      curl -sS -m 5 -X POST "$BASE_URL/api/sync/health" \
        -H "x-pugs-sync-secret: $PUGS_SYNC_SECRET" \
        -H "x-pugs-scanner-id: ${PUGS_SCANNER_ID:-}" \
        -H "content-type: application/json" \
        -d '{"service":"updater","status":"error","error":"launchctl reload failed"}' \
        >/dev/null 2>&1 || true
    fi
  fi
  exit 1
fi

echo "$LOG_PREFIX services reloaded on $NEW_HEAD"

# Report a successful update to the cloud health endpoint for observability
if [ -f "$AGENT_ROOT/.env" ]; then
  # shellcheck disable=SC1091
  . "$AGENT_ROOT/.env"
  if [ -n "${PUGS_SYNC_SECRET:-}" ] && [ -n "${PUGS_SYNC_WEBHOOK_URL:-}" ]; then
    BASE_URL="${PUGS_SYNC_WEBHOOK_URL%/api/import/imessage}"
    curl -sS -m 5 -X POST "$BASE_URL/api/sync/health" \
      -H "x-pugs-sync-secret: $PUGS_SYNC_SECRET" \
      -H "x-pugs-scanner-id: ${PUGS_SCANNER_ID:-}" \
      -H "content-type: application/json" \
      -d '{"service":"updater","status":"ok"}' \
      >/dev/null 2>&1 \
      && echo "$LOG_PREFIX health beacon sent to pugs-sales" \
      || echo "$LOG_PREFIX health beacon failed (non-fatal)"
  fi
fi
