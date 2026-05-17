# Ad Compliance Production Scaffold

This folder is the deploy-ready wrapper for the current ad compliance flow.
It is intentionally small and non-destructive: it calls the existing policy,
placement, unified report, and Slack sender code instead of moving everything at
once.

Production flow details live in `production/docs/compliance-flow.md`. Update
that file whenever runner, webhook, cache, or Slack routing behavior changes.

## Goals

- One clear entrypoint for local, Mac mini, and Cloud Run runs.
- One env contract.
- One report JSON contract for the report viewer.
- Keep legacy folders untouched until the production wrapper is stable.

## Current Runtime Split

- `production/worker` runs the compliance jobs.
- `production/api-trigger` optionally exposes a small manual trigger API for
  starting Cloud Run Job executions.
- `report-viewer` remains the Vercel app for reading report JSON.
- `production/shared` documents the expected report/env contracts.
- `production/scripts` contains safe wrapper commands.

## Recommended Rollout

1. Run one account locally with `production/scripts/run-local-worker.sh`.
2. Confirm report JSON and screenshots upload correctly.
3. Send Slack to a test channel.
4. Deploy `report-viewer`.
5. Build and run the worker container locally.
6. Deploy the worker to Cloud Run or run it on Mac mini cron.
7. Optionally deploy `production/api-trigger` as a Cloud Run Service for manual
   reruns.

Do not put secrets in this folder. Use root `.env` locally and platform
environment variables in Cloud Run/Vercel.
