#!/usr/bin/env bash
set -euo pipefail

python3 production/worker/main.py --mode doctor "$@"
