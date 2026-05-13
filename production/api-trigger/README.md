# API Trigger

Small HTTP service for manually triggering the ad compliance worker.

This service does not run policy, placement, Gemini, Meta, or Slack work inside
the HTTP request. It validates the request, starts a background run, then returns
immediately.

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
  "channel": "C08EA0XE2UU"
}
```

Dry-run the generated worker args without triggering the job:

```json
{
  "accountId": "act_1959218444986377",
  "mode": "full",
  "channel": "C08EA0XE2UU",
  "dryRun": true
}
```

Run all active accounts:

```json
{
  "allAccounts": true,
  "mode": "full",
  "accountDelay": 5
}
```

## Required Env

- `RUN_TRIGGER_TOKEN`
- `REPORT_VIEWER_URL`
- `TRIGGER_RUNNER=local` for Mac mini, or `TRIGGER_RUNNER=cloud-run` for Cloud Run
- `SLACK_OVERRIDE_CHANNEL_ID` optional debug fallback

For Mac mini:

```bash
cd /Users/convertcake/Desktop/ads-checker-deployment
TRIGGER_RUNNER=local \
RUN_TRIGGER_TOKEN='<secret>' \
REPORT_VIEWER_URL='https://report-viewer-theta.vercel.app/report-viewer' \
MAX_CONCURRENT_RUNS=1 \
PORT=8080 \
node production/api-trigger/server.js
```

Trigger one account:

```bash
curl -X POST http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"act_1177861947760094","mode":"full"}'
```

Trigger all routed accounts:

```bash
curl -X POST http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer <secret>" \
  -H "Content-Type: application/json" \
  -d '{"allAccounts":true,"mode":"full","accountDelay":5}'
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
  "accountDelay": 5
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
