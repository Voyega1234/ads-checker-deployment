# Mac Mini Policy Worker

Queue-based Policy + Spelling engine backed by `macmini_worker_jobs`.

## Components

- `worker_slack.py`: polls `job_source=slack_alert`, processes pending jobs, and
  writes `output_json`.
- `account_runner.py`: fetches Meta ads for one account, groups exact captions,
  inserts one queue job per caption, waits for results, and persists an exact
  historical policy run for the Slack Catalog.
- `pipeline.py`: shared retrieval, prompt, LLM backend, queue, and write-back logic.
- `step_01_*` through `step_05_*`: individual pipeline stages.

## Start Queue Consumer

The current shared policy virtualenv already contains the required packages:

```bash
v2.0_run-all-ad-acc/.venv/bin/python mac_mini_worker/worker_slack.py
```

Optional concurrent caption jobs:

```bash
v2.0_run-all-ad-acc/.venv/bin/python mac_mini_worker/worker_slack.py --concurrency 2
```

Default concurrency is `1`. You can also set `MACMINI_WORKER_CONCURRENCY=2`.
Start with `2` for safer Gemini/OpenRouter rate-limit behavior; increase only
after watching logs and API quota.

`worker_slack.py` is queue-only. It reads `caption` from `input_json` and
`client_id` from `metadata_json`, then calls:

```python
response = pipeline.run_pipeline(
    request["caption"],
    image_url=None,
    recheck_until_pass=False,
    max_recheck_attempts=3,
    process_image=False,
    client_id=request["client_id"],
)
```

## LLM Backend

Gemini remains the default:

```env
LLM_BACKEND=gemini
LLM_MODEL=gemini-2.5-flash
LLM_TEMPERATURE=0.5
LLM_SEED=42
```

OpenRouter can be enabled without changing the workflow code:

```env
LLM_BACKEND=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=minimax/minimax-m3
OPENROUTER_REASONING_ENABLED=true
LLM_TEMPERATURE=0.5
LLM_SEED=42
```

`OPENROUTER_MODEL` is used only when `LLM_BACKEND=openrouter`. Rule embedding
retrieval still uses the configured Gemini embedding model.

## Select Engine

Existing implementation:

```bash
python3 production/worker/main.py \
  --account act_3820001441548201 \
  --mode full \
  --policy-engine legacy \
  --policy-runner hybrid
```

Queue implementation:

```bash
python3 production/worker/main.py \
  --account act_3820001441548201 \
  --mode full \
  --policy-engine macmini
```

API body:

```json
{
  "accountId": "act_3820001441548201",
  "mode": "full",
  "policyEngine": "macmini",
  "source": "webhook",
  "newAdIds": ["120000000000000001"]
}
```

`policyRunner` applies only when `policyEngine` is `legacy`.

## Migration Boundary

The macmini engine owns rule retrieval, prompt execution, Policy, and Spelling.
During migration, `account_runner.py` still reuses the existing Meta fetch and
database row adapters from `v2.0_run-all-ad-acc`. Placement and Slack Catalog
generation remain in the production workflow.
