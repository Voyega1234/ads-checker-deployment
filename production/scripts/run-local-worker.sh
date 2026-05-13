#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-}"
MODE="${2:-full}"

if [[ -z "$ACCOUNT" ]]; then
  echo "Usage: production/scripts/run-local-worker.sh act_<ACCOUNT_ID> [policy|placement|unified|slack|full]"
  exit 2
fi

python3 production/worker/main.py \
  --account "$ACCOUNT" \
  --mode "$MODE" \
  --skip-slack
