#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ACCOUNT=""
CHANNEL=""
BACKEND="gemini"
SOURCE=""
SLACK_FORMAT="catalog"
MAX_CARDS="10"
LIMIT_ADS=""
CATALOG_STYLE_VALUE="v2"
CATALOG_AI_SUMMARY_VALUE="1"
START_WORKER="1"
WORKER_CONCURRENCY_VALUE="${MACMINI_WORKER_CONCURRENCY:-1}"
GEMINI_AUTH_MODE_VALUE="${GEMINI_AUTH_MODE:-adc}"
GOOGLE_CLOUD_PROJECT_VALUE="${GOOGLE_CLOUD_PROJECT:-${GCP_PROJECT_ID:-ads-compliance-494407}}"
GOOGLE_CLOUD_LOCATION_VALUE="${GOOGLE_CLOUD_LOCATION:-global}"

LLM_MODEL_VALUE="${LLM_MODEL:-gemini-2.5-flash}"
LLM_TEMPERATURE_VALUE="${LLM_TEMPERATURE:-0.5}"
LLM_SEED_VALUE="${LLM_SEED:-42}"
OPENROUTER_MODEL_VALUE="${OPENROUTER_MODEL:-minimax/minimax-m3}"
OPENROUTER_REASONING_VALUE="${OPENROUTER_REASONING_ENABLED:-false}"
OPENROUTER_TIMEOUT_VALUE="${OPENROUTER_TIMEOUT_SECONDS:-90}"
OPENROUTER_JSON_VALUE="${OPENROUTER_RESPONSE_FORMAT_JSON:-true}"

usage() {
  cat <<'EOF'
Run one ad account through the macmini policy engine and send Slack Catalog.

Usage:
  production/scripts/run-macmini-policy-backend.sh \
    --backend gemini|openrouter \
    --account act_24333702262938851 \
    --channel C08EA0XE2UU

Common options:
  --backend VALUE              gemini or openrouter
  --account VALUE              Meta ad account, with or without act_
  --channel VALUE              Slack channel ID
  --source VALUE               Source label. Default: manual-<backend>-<timestamp>
  --max-cards VALUE            Slack catalog max cards. Default: 10
  --limit-ads VALUE            Limit run to first N active ads for this account
  --catalog-style VALUE        Catalog card style: classic or v2. Default: v2
  --catalog-ai-summary bool    Use AI summary for v2 card reasons. Default: true
  --worker-concurrency VALUE   Local queue worker concurrency. Default: 1
  --gemini-auth VALUE          Gemini auth mode: adc or api_key. Default: adc
  --gcp-project VALUE          Google Cloud project for ADC Gemini. Default: env or ads-compliance-494407
  --gcp-location VALUE         Google Cloud location for ADC Gemini. Default: global
  --no-worker                  Do not start a local worker; use an already-running worker

Gemini options:
  --llm-model VALUE            Default: gemini-2.5-flash
  --temperature VALUE          Default: 0.5
  --seed VALUE                 Default: 42

OpenRouter options:
  --openrouter-model VALUE     Default: minimax/minimax-m3
  --openrouter-reasoning bool  Default: false
  --openrouter-timeout sec     Default: 90
  --openrouter-json bool       Default: true

Examples:
  # Gemini
  production/scripts/run-macmini-policy-backend.sh \
    --backend gemini \
    --account act_24333702262938851 \
    --channel C08EA0XE2UU

  # OpenRouter
  production/scripts/run-macmini-policy-backend.sh \
    --backend openrouter \
    --openrouter-model minimax/minimax-m3 \
    --account act_24333702262938851 \
    --channel C08EA0XE2UU
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend) BACKEND="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --max-cards) MAX_CARDS="${2:-}"; shift 2 ;;
    --limit-ads) LIMIT_ADS="${2:-}"; shift 2 ;;
    --catalog-style) CATALOG_STYLE_VALUE="${2:-}"; shift 2 ;;
    --catalog-ai-summary) CATALOG_AI_SUMMARY_VALUE="${2:-}"; shift 2 ;;
    --no-catalog-ai-summary) CATALOG_AI_SUMMARY_VALUE="0"; shift ;;
    --worker-concurrency) WORKER_CONCURRENCY_VALUE="${2:-}"; shift 2 ;;
    --gemini-auth) GEMINI_AUTH_MODE_VALUE="${2:-}"; shift 2 ;;
    --gcp-project) GOOGLE_CLOUD_PROJECT_VALUE="${2:-}"; shift 2 ;;
    --gcp-location) GOOGLE_CLOUD_LOCATION_VALUE="${2:-}"; shift 2 ;;
    --no-worker) START_WORKER="0"; shift ;;
    --llm-model) LLM_MODEL_VALUE="${2:-}"; shift 2 ;;
    --temperature) LLM_TEMPERATURE_VALUE="${2:-}"; shift 2 ;;
    --seed) LLM_SEED_VALUE="${2:-}"; shift 2 ;;
    --openrouter-model) OPENROUTER_MODEL_VALUE="${2:-}"; shift 2 ;;
    --openrouter-reasoning) OPENROUTER_REASONING_VALUE="${2:-}"; shift 2 ;;
    --openrouter-timeout) OPENROUTER_TIMEOUT_VALUE="${2:-}"; shift 2 ;;
    --openrouter-json) OPENROUTER_JSON_VALUE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$BACKEND" != "gemini" && "$BACKEND" != "openrouter" ]]; then
  echo "--backend must be gemini or openrouter" >&2
  exit 2
fi

if [[ "$GEMINI_AUTH_MODE_VALUE" != "adc" && "$GEMINI_AUTH_MODE_VALUE" != "api_key" ]]; then
  echo "--gemini-auth must be adc or api_key" >&2
  exit 2
fi

if [[ -z "$ACCOUNT" || -z "$CHANNEL" ]]; then
  echo "--account and --channel are required" >&2
  usage
  exit 2
fi

if [[ -z "$SOURCE" ]]; then
  SOURCE="manual-${BACKEND}-$(date -u +%Y%m%dT%H%M%SZ)"
fi

export LLM_BACKEND="$BACKEND"
export GEMINI_AUTH_MODE="$GEMINI_AUTH_MODE_VALUE"
export GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT_VALUE"
export GOOGLE_CLOUD_LOCATION="$GOOGLE_CLOUD_LOCATION_VALUE"
export GOOGLE_GENAI_USE_ENTERPRISE="${GOOGLE_GENAI_USE_ENTERPRISE:-True}"
export LLM_MODEL="$LLM_MODEL_VALUE"
export LLM_TEMPERATURE="$LLM_TEMPERATURE_VALUE"
export LLM_SEED="$LLM_SEED_VALUE"
export OPENROUTER_MODEL="$OPENROUTER_MODEL_VALUE"
export OPENROUTER_REASONING_ENABLED="$OPENROUTER_REASONING_VALUE"
export OPENROUTER_TIMEOUT_SECONDS="$OPENROUTER_TIMEOUT_VALUE"
export OPENROUTER_RESPONSE_FORMAT_JSON="$OPENROUTER_JSON_VALUE"

if [[ "$BACKEND" == "openrouter" ]]; then
  if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    if [[ -f mac_mini_worker/.env ]] && grep -q '^OPENROUTER_API_KEY=' mac_mini_worker/.env; then
      # pipeline.py will load the key from mac_mini_worker/.env.
      :
    else
      echo "OPENROUTER_API_KEY is required for --backend openrouter" >&2
      exit 2
    fi
  fi
fi

echo "== macmini policy run =="
echo "account=$ACCOUNT"
echo "channel=$CHANNEL"
echo "backend=$LLM_BACKEND"
echo "gemini_auth=$GEMINI_AUTH_MODE"
echo "google_cloud_project=$GOOGLE_CLOUD_PROJECT"
echo "google_cloud_location=$GOOGLE_CLOUD_LOCATION"
echo "source=$SOURCE"
echo "worker_concurrency=$WORKER_CONCURRENCY_VALUE"
if [[ -n "$LIMIT_ADS" ]]; then
  echo "limit_ads=$LIMIT_ADS"
fi
echo "catalog_style=$CATALOG_STYLE_VALUE"
echo "catalog_ai_summary=$CATALOG_AI_SUMMARY_VALUE"
if [[ "$BACKEND" == "openrouter" ]]; then
  echo "openrouter_model=$OPENROUTER_MODEL"
  echo "openrouter_reasoning=$OPENROUTER_REASONING_ENABLED"
else
  echo "llm_model=$LLM_MODEL"
fi

WORKER_PID=""
cleanup() {
  if [[ -n "$WORKER_PID" ]]; then
    if kill -0 "$WORKER_PID" 2>/dev/null; then
      echo "== stopping worker pid=$WORKER_PID =="
      kill "$WORKER_PID" 2>/dev/null || true
      wait "$WORKER_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT INT TERM

if [[ "$START_WORKER" == "1" ]]; then
  echo "== starting worker =="
  v2.0_run-all-ad-acc/.venv/bin/python mac_mini_worker/worker_slack.py \
    --concurrency "$WORKER_CONCURRENCY_VALUE" &
  WORKER_PID="$!"
  export MACMINI_EMBEDDED_WORKER="0"
  sleep 2
fi

echo "== running workflow =="
WORKFLOW_CMD=(
  python3 production/worker/main.py
  --account "$ACCOUNT" \
  --mode full \
  --policy-engine macmini \
  --channel "$CHANNEL" \
  --slack-format "$SLACK_FORMAT" \
  --catalog-style "$CATALOG_STYLE_VALUE" \
  --catalog-max-cards "$MAX_CARDS" \
  --disable-recent-slack-skip \
  --source "$SOURCE"
)

if [[ -n "$LIMIT_ADS" ]]; then
  WORKFLOW_CMD+=(--limit-ads "$LIMIT_ADS")
fi

case "$(printf '%s' "$CATALOG_AI_SUMMARY_VALUE" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    WORKFLOW_CMD+=(--catalog-ai-summary)
    ;;
  0|false|no|off)
    WORKFLOW_CMD+=(--no-catalog-ai-summary)
    ;;
  *)
    echo "--catalog-ai-summary must be true/false" >&2
    exit 2
    ;;
esac

"${WORKFLOW_CMD[@]}"
