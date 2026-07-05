#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

API_URL="${TRIGGER_API_URL:-http://127.0.0.1:${PORT:-8080}/runs}"
TOKEN="${RUN_TRIGGER_TOKEN:-}"
ACCOUNT=""
CHANNEL=""
NEW_AD_IDS=""
EVENT_IDS=""
TEST_CASE=""
SOURCE="webhook-test-$(date -u +%Y%m%dT%H%M%SZ)"
SLACK_FORMAT="catalog"
POLICY_ENGINE="macmini"
CATALOG_MAX_CARDS="10"
DRY_RUN="1"
TAIL_LOG="1"
SKIP_HEALTH="0"
MARK_EVENTS_PROCESSED="1"
DISABLE_RECENT_SLACK_SKIP="1"

usage() {
  cat <<'EOF'
Simulate the n8n new-ad trigger against the deployed Mac mini trigger API.

Default mode is dry-run: it validates the API payload and prints the worker args
without starting the full workflow. Add --live to run policy + placement +
unified + Slack catalog.

Usage:
  production/scripts/test-n8n-new-ad-trigger.sh \
    --account act_1177861947760094 \
    --new-ad-ids 120243898233580277 \
    --channel C0B1ZT7S1HV

  production/scripts/test-n8n-new-ad-trigger.sh \
    --test-case recovery-me \
    --channel C0B1ZT7S1HV \
    --live

Required:
  RUN_TRIGGER_TOKEN must be exported or present in .env.

Options:
  --api-url VALUE                  Trigger URL. Default: http://127.0.0.1:${PORT:-8080}/runs
  --token VALUE                    Override RUN_TRIGGER_TOKEN for this call.
  --account VALUE                  Meta ad account, with or without act_.
  --new-ad-ids VALUE               Comma-separated Meta ad IDs.
  --event-ids VALUE                Optional comma-separated UUIDs from meta_ad_status_events.
  --test-case VALUE                Use API test payload: grand-home-mart or recovery-me.
  --channel VALUE                  Slack channel override for the test send.
  --source VALUE                   Source label. Default: webhook-test-<UTC timestamp>.
  --catalog-max-cards VALUE        Catalog max cards. Default: 10.
  --dry-run                        Validate payload/args only. Default.
  --live                           Start the full workflow through the API.
  --no-tail                        Do not tail the local worker log after --live.
  --respect-recent-slack-skip      Keep the 24h recent Slack skip guard.
  --no-mark-events-processed       Do not send markEventsProcessed=true.
  --skip-health                    Do not call GET /health before POST /runs.
  -h, --help                       Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --new-ad-ids) NEW_AD_IDS="${2:-}"; shift 2 ;;
    --event-ids) EVENT_IDS="${2:-}"; shift 2 ;;
    --test-case) TEST_CASE="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --catalog-max-cards) CATALOG_MAX_CARDS="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --live) DRY_RUN="0"; shift ;;
    --no-tail) TAIL_LOG="0"; shift ;;
    --respect-recent-slack-skip) DISABLE_RECENT_SLACK_SKIP="0"; shift ;;
    --no-mark-events-processed) MARK_EVENTS_PROCESSED="0"; shift ;;
    --skip-health) SKIP_HEALTH="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$TOKEN" && -f .env ]]; then
  TOKEN="$(python3 - .env <<'PY'
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
for raw in env_path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() == "RUN_TRIGGER_TOKEN":
        print(value.strip().strip('"').strip("'"))
        break
PY
)"
fi

if [[ -z "$TOKEN" ]]; then
  echo "RUN_TRIGGER_TOKEN is required. Export it or put RUN_TRIGGER_TOKEN=... in .env." >&2
  exit 2
fi

if [[ -z "$TEST_CASE" ]]; then
  if [[ -z "$ACCOUNT" || -z "$NEW_AD_IDS" ]]; then
    echo "--account and --new-ad-ids are required unless --test-case is used." >&2
    usage
    exit 2
  fi
fi

PAYLOAD_FILE="$(mktemp -t n8n-trigger-payload.XXXXXX.json)"
RESPONSE_FILE="$(mktemp -t n8n-trigger-response.XXXXXX.json)"
trap 'rm -f "$PAYLOAD_FILE" "$RESPONSE_FILE"' EXIT

export ACCOUNT CHANNEL NEW_AD_IDS EVENT_IDS TEST_CASE SOURCE SLACK_FORMAT POLICY_ENGINE
export CATALOG_MAX_CARDS DRY_RUN MARK_EVENTS_PROCESSED DISABLE_RECENT_SLACK_SKIP

python3 - "$PAYLOAD_FILE" <<'PY'
import json
import os
import sys

def split_csv(value):
    return [item.strip() for item in str(value or "").split(",") if item.strip()]

def env_bool(name):
    return os.environ.get(name, "0").strip().lower() in {"1", "true", "yes", "on"}

payload = {
    "mode": "full",
    "source": os.environ["SOURCE"],
    "slackFormat": os.environ["SLACK_FORMAT"],
    "policyEngine": os.environ["POLICY_ENGINE"],
    "catalogCacheImages": True,
    "catalogFitImages": True,
    "catalogMaxCards": int(os.environ["CATALOG_MAX_CARDS"]),
}

if env_bool("DRY_RUN"):
    payload["dryRun"] = True
if env_bool("MARK_EVENTS_PROCESSED"):
    payload["markEventsProcessed"] = True
if env_bool("DISABLE_RECENT_SLACK_SKIP"):
    payload["disableRecentSlackSkip"] = True

test_case = os.environ.get("TEST_CASE", "").strip()
if test_case:
    payload["testCase"] = test_case

account = os.environ.get("ACCOUNT", "").strip()
if account:
    payload["accountId"] = account

channel = os.environ.get("CHANNEL", "").strip()
if channel:
    payload["channel"] = channel

new_ad_ids = split_csv(os.environ.get("NEW_AD_IDS"))
if new_ad_ids:
    payload["newAdIds"] = new_ad_ids

event_ids = split_csv(os.environ.get("EVENT_IDS"))
if event_ids:
    payload["eventIds"] = event_ids

with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

HEALTH_URL="${API_URL%/runs}/health"
if [[ "$SKIP_HEALTH" != "1" ]]; then
  echo "== health =="
  curl -fsS "$HEALTH_URL" | python3 -m json.tool
fi

echo "== payload =="
python3 -m json.tool "$PAYLOAD_FILE"

echo "== POST $API_URL =="
HTTP_STATUS="$(
  curl -sS \
    -o "$RESPONSE_FILE" \
    -w "%{http_code}" \
    -X POST "$API_URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "@$PAYLOAD_FILE"
)"

echo "http_status=$HTTP_STATUS"
python3 -m json.tool "$RESPONSE_FILE" || cat "$RESPONSE_FILE"

if (( HTTP_STATUS < 200 || HTTP_STATUS >= 300 )); then
  exit 1
fi

if [[ "$DRY_RUN" == "1" || "$TAIL_LOG" != "1" ]]; then
  exit 0
fi

read -r WORKER_PID LOG_PATH < <(python3 - "$RESPONSE_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
operation = data.get("operation") or {}
print(operation.get("pid") or "", operation.get("logPath") or "")
PY
)

if [[ -z "$WORKER_PID" || -z "$LOG_PATH" ]]; then
  echo "No local worker pid/logPath returned; not tailing."
  exit 0
fi

echo "== tailing local worker log =="
echo "pid=$WORKER_PID"
echo "log=$LOG_PATH"

for _ in {1..20}; do
  [[ -f "$LOG_PATH" ]] && break
  sleep 0.5
done

tail -n +1 -f "$LOG_PATH" &
TAIL_PID="$!"
while kill -0 "$WORKER_PID" 2>/dev/null; do
  sleep 5
done
sleep 1
kill "$TAIL_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true

echo "== worker process exited =="
