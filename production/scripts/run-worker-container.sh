#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="${1:-}"
IMAGE_NAME="${2:-ad-compliance-worker:local}"

if [[ -z "$ACCOUNT" ]]; then
  echo "Usage: production/scripts/run-worker-container.sh act_<ACCOUNT_ID> [image-name]"
  exit 2
fi

docker run --rm \
  --env-file .env \
  -e REPORT_VIEWER_URL="${REPORT_VIEWER_URL:-https://report-viewer-theta.vercel.app/report-viewer}" \
  "$IMAGE_NAME" \
  --account "$ACCOUNT" \
  --mode full \
  --skip-slack
