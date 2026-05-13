#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-}"
CHANNEL="${2:-${SLACK_OVERRIDE_CHANNEL_ID:-}}"
VIEWER_URL="${REPORT_VIEWER_URL:-https://report-viewer-theta.vercel.app/report-viewer}"

if [[ -z "$ACCOUNT" || -z "$CHANNEL" ]]; then
  echo "Usage: production/scripts/run-local-slack.sh act_<ACCOUNT_ID> C08..."
  exit 2
fi

python3 production/worker/main.py \
  --account "$ACCOUNT" \
  --mode full \
  --channel "$CHANNEL" \
  --viewer-url "$VIEWER_URL"
