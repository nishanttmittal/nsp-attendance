#!/usr/bin/env bash
# Waits for the Firestore free-tier read quota to refill (~12:30 PM IST), then runs the
# read-only advance audit once and saves the report. Poll is ONE tiny read every 10 min.
cd "$(dirname "$0")/.." || exit 1
OUT="$HOME/attendance-app/jobs/downloads/advance-audit-$(date +%F).txt"
mkdir -p "$HOME/attendance-app/jobs/downloads"
for _ in $(seq 1 200); do            # ~33h ceiling, then give up
  if node jobs/verifyAdvanceState.js > "$OUT" 2>&1; then
    echo "AUDIT COMPLETE $(date '+%F %H:%M') -> $OUT"
    exit 0
  fi
  grep -q 'QUOTA STILL EXHAUSTED' "$OUT" || { echo "FAILED for a non-quota reason — see $OUT"; exit 1; }
  sleep 600
done
echo "gave up waiting for quota"; exit 1
