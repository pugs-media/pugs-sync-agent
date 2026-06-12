#!/bin/bash
# Pugs Sync Agent — log rotation utility
#
# Rotates .log and .error.log files when they exceed a size threshold.
# Keeps a limited number of rotated archives and compresses them.
# Called by update.sh before the git pull logic.
#
# Configuration (tunable):
#   MAX_LOG_SIZE_MB: rotate when a log exceeds this size (default: 50)
#   MAX_LOG_FILES: keep this many rotated + compressed archives (default: 5)

set -u

# Configuration
MAX_LOG_SIZE_MB=${1:-50}
MAX_LOG_FILES=${2:-5}
MAX_LOG_SIZE_BYTES=$((MAX_LOG_SIZE_MB * 1024 * 1024))

# AGENT_ROOT defaults to the directory containing this script, but can be overridden
# via environment variable (used for testing)
if [ -z "${AGENT_ROOT:-}" ]; then
  AGENT_ROOT="$(cd "$(dirname "$0")" && pwd)"
fi

# Rotate a single log file if it exceeds the threshold
rotate_log_file() {
  local logfile=$1
  local filesize

  if [ ! -f "$logfile" ]; then
    return 0
  fi

  filesize=$(stat -f%z "$logfile" 2>/dev/null || echo 0)
  if [ "$filesize" -lt "$MAX_LOG_SIZE_BYTES" ]; then
    return 0
  fi

  # File exceeds threshold — rotate it
  # Shift existing rotations: .1 → .2, .2 → .3, etc.
  for i in $(seq $MAX_LOG_FILES -1 1); do
    next=$((i + 1))
    if [ -f "$logfile.$i.gz" ]; then
      mv "$logfile.$i.gz" "$logfile.$next.gz" 2>/dev/null || true
    fi
  done

  # Move current → .1 and compress it
  if mv "$logfile" "$logfile.1" 2>/dev/null; then
    gzip "$logfile.1" 2>/dev/null &
  fi

  # Clean up old rotations beyond MAX_LOG_FILES (after shift, so .N+1 and beyond)
  for i in $(seq $((MAX_LOG_FILES + 1)) 100); do
    [ -f "$logfile.$i.gz" ] && rm -f "$logfile.$i.gz"
  done
}

# Rotate all log files
rotate_log_file "$AGENT_ROOT/scanner.log"
rotate_log_file "$AGENT_ROOT/scanner.error.log"
rotate_log_file "$AGENT_ROOT/sender.log"
rotate_log_file "$AGENT_ROOT/sender.error.log"
rotate_log_file "$AGENT_ROOT/poller.log"
rotate_log_file "$AGENT_ROOT/poller.error.log"
rotate_log_file "$AGENT_ROOT/updater.log"
rotate_log_file "$AGENT_ROOT/updater.error.log"

wait  # for any background gzip jobs
