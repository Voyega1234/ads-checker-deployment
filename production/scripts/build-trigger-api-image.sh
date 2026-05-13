#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-ad-compliance-trigger-api:local}"

docker build \
  -f production/api-trigger/Dockerfile \
  -t "$IMAGE_NAME" \
  .
