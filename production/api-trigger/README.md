# API Trigger

Small HTTP service for manually triggering the ad compliance Cloud Run Job.

This service does not run policy, placement, Gemini, Meta, or Slack work inside
the HTTP request. It only validates the request and calls the Cloud Run Jobs API.

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
  "channel": "C08EA0XE2UU",
  "accountDelay": 5
}
```

## Required Env

- `RUN_TRIGGER_TOKEN`
- `GCP_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT`
- `CLOUD_RUN_REGION`
- `CLOUD_RUN_JOB_NAME`
- `REPORT_VIEWER_URL`
- `SLACK_OVERRIDE_CHANNEL_ID` optional default

Alternatively set `CLOUD_RUN_JOB_RESOURCE` to the full resource path:

```txt
projects/<project>/locations/<region>/jobs/<job>
```

## IAM

The Cloud Run service account for this API needs permission to run the target
job, for example `roles/run.developer` scoped to the job/project plus
`iam.serviceAccounts.actAs` when the target job uses a separate runtime service
account.
