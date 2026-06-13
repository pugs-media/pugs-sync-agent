#!/bin/bash
# Pugs Sync Agent — emergency restart.
#
# Single command to fully reset the agent when something has gone sideways.
# Designed to be run remotely via SSH (Tailscale) without any further
# interaction. Idempotent — safe to run anytime.
#
# What it does:
#   1. Unloads all 4 launchd jobs (scanner, sender, poller, updater).
#   2. git pull --ff-only (in case the agent is stuck on an old commit).
#   3. Reinstalls npm deps.
#   4. Reloads all 4 launchd jobs.
#   5. Runs scanner once synchronously to verify chat.db access works.
#   6. Prints heartbeat status — should appear in pugs-sales within 1 min.
#
# Usage:
#   bash ~/pugs-sync-agent/panic-restart.sh
#
# Or via SSH from Charlie's machine (Tailscale):
#   ssh connor@<tailscale-hostname> "bash ~/pugs-sync-agent/panic-restart.sh"

set -u

AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
cd "$AGENT_ROOT" || { echo "❌ cannot cd $AGENT_ROOT"; exit 1; }

echo "━━ 1. Unloading existing launchd jobs ━━"
for kind in scanner sender poller updater; do
  dst="$LAUNCH_DIR/com.pugs.syncagent.$kind.plist"
  [ -f "$dst" ] && launchctl unload "$dst" 2>/dev/null && echo "   ✓ unloaded $kind" || echo "   ⊘ $kind not loaded"
done

echo
echo "━━ 2. Pulling latest code ━━"
git fetch --quiet
if git merge --ff-only origin/main 2>&1; then
  echo "   ✓ on $(git rev-parse --short HEAD)"
else
  echo "   ⚠ ff-only failed (local edits?) — using current HEAD: $(git rev-parse --short HEAD)"
fi

echo
echo "━━ 3. Reinstalling deps ━━"
if npm install --loglevel error --no-audit --no-fund 2>&1; then
  echo "   ✓ deps installed"
else
  echo "   ⚠ npm install encountered errors (continuing)"
fi

echo
echo "━━ 4. Reloading launchd jobs ━━"
NODE_BIN="$(which node)"
mkdir -p "$LAUNCH_DIR"
for kind in scanner sender poller updater; do
  src="$AGENT_ROOT/launchd/com.pugs.syncagent.$kind.plist"
  dst="$LAUNCH_DIR/com.pugs.syncagent.$kind.plist"
  sed -e "s|__NODE_BIN__|$NODE_BIN|g" -e "s|__AGENT_ROOT__|$AGENT_ROOT|g" "$src" > "$dst"
  if launchctl load "$dst" 2>&1; then
    echo "   ✓ loaded $kind"
  else
    echo "   ❌ failed to load $kind"
  fi
done

echo
echo "━━ 5. Running scanner once synchronously ━━"
scan_out=$("$NODE_BIN" "$AGENT_ROOT/src/scan.js" 2>&1)
scan_rc=$?
echo "$scan_out" | tail -10
if [ "$scan_rc" -eq 0 ]; then
  echo "   ✓ scanner ran cleanly"
else
  echo "   ❌ scanner errored (exit $scan_rc) — check $AGENT_ROOT/scanner.error.log"
  tail -20 "$AGENT_ROOT/scanner.error.log" 2>/dev/null
fi

echo
echo "━━ Done ━━"
echo "Verify in pugs-sales: curl -H \"Authorization: Bearer \$CRON_SECRET\" \\"
echo "  https://pugs-sales.vercel.app/api/admin/diagnose-imessage | jq .heartbeat"
echo "Should show a recent timestamp within 1 minute."
