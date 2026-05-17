# Runbook

For the full architecture and data flow, read
`production/docs/compliance-flow.md` first. This runbook is only the command
cheat sheet.

## Local Dry Run

First run doctor:

```bash
python production/worker/main.py --mode doctor
```

For policy and Slack readiness:

```bash
python production/worker/main.py --mode doctor --require-policy --require-slack
```

```bash
production/scripts/run-local-worker.sh act_1959218444986377 full
```

This runs the full flow without Slack.

## Send Slack Test

```bash
production/scripts/run-local-slack.sh act_1959218444986377 C08EA0XE2UU
```

## Check Slack Routing

Before a production run, verify the destination channel from the Google Sheet
`Client` tab:

```bash
python production/worker/main.py --account act_1959218444986377 --check-slack-routing
```

For every active account:

```bash
python production/worker/main.py --all-accounts --check-slack-routing
```

`--channel` is only a fallback/debug override when the Client sheet has no
`Slack Channel ID`.

## Build Worker Container

```bash
production/scripts/build-worker-image.sh
```

## Run Worker Container Locally

```bash
production/scripts/run-worker-container.sh act_1959218444986377
```

## Deploy Report Viewer

```bash
production/scripts/deploy-report-viewer.sh
```

## Cloud Run Shape

Use `production/worker/Dockerfile`.

Arguments:

```txt
--account act_<ACCOUNT_ID> --mode full --channel <SLACK_CHANNEL> --viewer-url <REPORT_VIEWER_URL>
```

For scheduled runs, prefer one Cloud Run Job execution per ad account. This
keeps retries, logs, and failures easy to reason about.

## Manual Trigger API

Use `production/api-trigger/Dockerfile` for an optional Cloud Run Service that
triggers the worker job.

The API is intentionally thin. It returns quickly and does not run the
compliance workflow inside the HTTP request.

```bash
curl -X POST "$TRIGGER_API_URL/runs" \
  -H "Authorization: Bearer $RUN_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "act_1959218444986377",
    "mode": "full",
    "channel": "C08EA0XE2UU"
  }'
```

Dry-run request validation without starting the job:

```bash
curl -X POST "$TRIGGER_API_URL/runs" \
  -H "Authorization: Bearer $RUN_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"act_1959218444986377","dryRun":true}'
```

## Required Secret Mounts

Do not bake secrets into the image.

- Environment variables: Meta, Gemini, Supabase, Slack
- Secret file mount:
  `v2.0_run-all-ad-acc/ai-sheet-manager-service-account.json`

The root `.dockerignore` excludes `.env`, local outputs, virtualenvs, and the
Google service account JSON.
