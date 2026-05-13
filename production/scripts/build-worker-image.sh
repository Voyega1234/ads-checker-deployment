#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-ad-compliance-worker:local}"

docker build \
  -f production/worker/Dockerfile \
  -t "$IMAGE_NAME" \
  .
