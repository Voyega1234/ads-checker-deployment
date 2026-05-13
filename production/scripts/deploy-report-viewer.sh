#!/usr/bin/env bash
set -euo pipefail

cd report-viewer
npx vercel@latest --prod
