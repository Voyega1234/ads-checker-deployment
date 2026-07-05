# API Trigger

Small HTTP service for triggering the ad compliance worker.

This service does not run policy, placement, Gemini, Meta, or Slack work inside
the HTTP request. It validates the request, starts a background run, then returns
immediately.

The trigger is new-ad-only by default. Production n8n calls must pass `newAdIds`
from `meta_ad_status_events`; requests without `newAdIds` are rejected so the
worker does not rerun old ads and spam Slack. Manual/admin full-account runs are
still possible by passing `allowFullAccountRun: true`.

It supports two runners:

- `TRIGGER_RUNNER=cloud-run`: call a Cloud Run Job.
- `TRIGGER_RUNNER=local`: spawn `production/worker/main.py` on the same machine,
  useful for Mac mini deployment.

## Endpoints

```bash
GET /health
```

```bash
POST /runs
Authorization: Bearer $RUN_TRIGGER_TOKEN

{
  "accountId": "act_1959218444986377",
  "mode": "full",
  "newAdIds": ["120243898233580277"],
  "channel": "C08EA0XE2UU"
}
```

Dry-run the generated worker args without triggering the job:

```json
{
  "accountId": "act_1959218444986377",
  "mode": "full",
  "newAdIds": ["120243898233580277"],
  "channel": "C08EA0XE2UU",
  "dryRun": true
}
```

Manual/admin full-account run:

```json
{
  "allAccounts": true,
  "mode": "full",
  "policyRunner": "hybrid",
  "accountDelay": 5,
  "allowFullAccountRun": true
}
```

Webhook/new-ad body from n8n:

```json
{
  "accountId": "act_1047165889391141",
  "mode": "full",
  "policyRunner": "batch",
  "source": "webhook",
  "newAdIds": ["120243898233580277", "120243908503730277"],
  "eventIds": ["a1012c92-38ad-47a7-870d-a6f907ad31fa"],
  "slackFormat": "catalog",
  "markEventsProcessed": true,
  "batchPolicyPollInterval": 60,
  "batchPolicyTimeout": 7200
}
```

The default Slack format is `"catalog"`, the carousel/card Slack sender. The
API passes `--slack-format catalog` to the worker even when the request body
omits `slackFormat`. Set `"slackFormat": "viewer"` only when you need the old
report-link message. Catalog cards include the `What to fix` and `Ignore rule`
buttons by default.
Catalog cards use placement screenshots when available and fall back to the ad
creative thumbnail for policy/spelling-only issues. Catalog images are fitted
onto a white canvas and uploaded to Supabase by default so Slack does not crop
the creative. You can make this explicit in request bodies with:

```json
{
  "slackFormat": "catalog",
  "catalogCacheImages": true,
  "catalogFitImages": true,
  "catalogMaxCards": 10
}
```

The worker limits successful Slack runs to one per ad account within the
configured recent window (24 hours by default). If a webhook arrives during
that window, its `meta_ad_status_events` rows remain pending so a later n8n
poll can submit the accumulated ad/event IDs after the account becomes
eligible again.

To force immediate processing for a webhook/new-ad request, either set
`RECENT_SLACK_SKIP=0` on the worker environment or pass:

```json
{
  "disableRecentSlackSkip": true
}
```

Reusable test payloads are available so n8n can test the new-ad path without
waiting for fresh Meta webhook events:

```json
{
  "testCase": "grand-home-mart",
  "mode": "full",
  "channel": "C0B1ZT7S1HV",
  "dryRun": true
}
```

Available `testCase` values:

```text
grand-home-mart
recovery-me
```

## Required Env

- `RUN_TRIGGER_TOKEN`
- `REPORT_VIEWER_URL`
- `TRIGGER_RUNNER=local` for Mac mini (default), or `TRIGGER_RUNNER=cloud-run` for Cloud Run
- `SLACK_OVERRIDE_CHANNEL_ID` optional debug fallback

For Mac mini:

```bash
cd /Users/convertcake/Desktop/ads-checker-deployment
gcloud auth application-default login
TRIGGER_RUNNER=local \
GEMINI_AUTH_MODE=adc \
GOOGLE_CLOUD_PROJECT='<gcp-project-id>' \
RUN_TRIGGER_TOKEN='<secret>' \
REPORT_VIEWER_URL='https://report-viewer-theta.vercel.app/report-viewer' \
MAX_CONCURRENT_RUNS=1 \
PORT=8080 \
node production/api-trigger/server.js
```

`GEMINI_AUTH_MODE=adc` keeps Gemini calls on Application Default Credentials
instead of `GEMINI_API_KEY`. Use `GEMINI_AUTH_MODE=api_key` only for the legacy
API-key path.

Trigger one account:

```bash
curl -X POST http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"act_1177861947760094","mode":"full","newAdIds":["120243898233580277"]}'
```

Simulate the n8n new-ad trigger after Mac deploy:

```bash
# Dry-run: validate payload and generated worker args only.
production/scripts/test-n8n-new-ad-trigger.sh \
  --account act_1177861947760094 \
  --new-ad-ids 120243898233580277 \
  --channel C0B1ZT7S1HV

# Live: start full workflow through the trigger API and tail the worker log.
production/scripts/test-n8n-new-ad-trigger.sh \
  --account act_1177861947760094 \
  --new-ad-ids 120243898233580277 \
  --channel C0B1ZT7S1HV \
  --live
```

Trigger all routed accounts for manual/admin testing:

```bash
curl -X POST http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"allAccounts":true,"mode":"full","accountDelay":5,"allowFullAccountRun":true}'
```

Local runner logs default to:

```text
logs/api-trigger/run-<timestamp>.log
```

If a run is already active, the local runner returns HTTP `409`:

```json
{
  "ok": false,
  "error": "run_already_in_progress"
}
```

## Cloudflare Tunnel for n8n

Install `cloudflared` on the Mac mini:

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create ad-compliance-trigger
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: ad-compliance-trigger
credentials-file: /Users/convertcake/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: ad-compliance-trigger.yourdomain.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Add DNS:

```bash
cloudflared tunnel route dns ad-compliance-trigger ad-compliance-trigger.yourdomain.com
```

Run the tunnel:

```bash
cloudflared tunnel run ad-compliance-trigger
```

n8n HTTP Request node:

```text
Method: POST
URL: https://ad-compliance-trigger.yourdomain.com/runs
Header: Authorization: Bearer <secret>
Header: Content-Type: application/json
```

Body for all routed accounts:

```json
{
  "allAccounts": true,
  "mode": "full",
  "policyRunner": "hybrid",
  "accountDelay": 5
}
```

`policyRunner` supports `hybrid`, `legacy`, and `batch`. `hybrid` is the worker
default and chooses batch for larger accounts based on active ad count and
unique ad-text group count.

`policyEngine` selects the implementation independently:

- `macmini` (default): enqueue unique captions in `macmini_worker_jobs`; the
  production worker starts a queue consumer for the duration of the run
- `legacy`: use `v2.0_run-all-ad-acc`

```json
{
  "accountId": "act_3820001441548201",
  "mode": "full",
  "policyEngine": "macmini",
  "source": "webhook",
  "newAdIds": ["120000000000000001"]
}
```

For Cloud Run:

- `GCP_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT`
- `CLOUD_RUN_REGION`
- `CLOUD_RUN_JOB_NAME`

Alternatively set `CLOUD_RUN_JOB_RESOURCE` to the full resource path:

```txt
projects/<project>/locations/<region>/jobs/<job>
```

## IAM

The Cloud Run service account for this API needs permission to run the target
job, for example `roles/run.developer` scoped to the job/project plus
`iam.serviceAccounts.actAs` when the target job uses a separate runtime service
account.
