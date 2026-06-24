# Production Worker

This is a wrapper around the current working implementation.

## Local Examples

Run preflight checks:

```bash
python production/worker/main.py --mode doctor
```

Run stricter checks before a real policy/Slack run:

```bash
python production/worker/main.py --mode doctor --require-policy --require-slack
```

Run placement only:

```bash
python production/worker/main.py --account act_4599179240326859 --mode placement
```

Run policy only:

```bash
python production/worker/main.py --account act_4599179240326859 --mode policy
```

Select the policy implementation separately from the legacy runner:

```bash
# Existing implementation
python production/worker/main.py \
  --account act_4599179240326859 \
  --mode full \
  --policy-engine legacy \
  --policy-runner hybrid

# Queue-based implementation
python production/worker/main.py \
  --account act_4599179240326859 \
  --mode full \
  --policy-engine macmini
```

The macmini engine requires a separate queue consumer:

```bash
v2.0_run-all-ad-acc/.venv/bin/python mac_mini_worker/worker_slack.py
```

Build unified report from the latest placement output:

```bash
python production/worker/main.py --account act_4599179240326859 --mode unified
```

Run full flow but do not send Slack:

```bash
python production/worker/main.py --account act_4599179240326859 --mode full --skip-slack
```

Run full flow with automatic policy runner selection:

```bash
python production/worker/main.py \
  --account act_4599179240326859 \
  --mode full \
  --policy-runner hybrid
```

Policy smart-skip is enabled by default. If active ads have the same
`creative_id` and `ad_text` already saved in `meta_ad_check_db`, and no webhook
`newAdIds` are passed, the worker skips policy/spelling for that account and
continues to placement/report/Slack.

For `full` and `slack` runs, the worker also skips an account when
`ad_compliance_slack_sends` contains a successful send within the configured
recent window (24 hours by default). Webhook events remain unprocessed when
this rate limit applies. They are marked processed only after a later eligible
run completes successfully.

Force policy even when content is unchanged:

```bash
python production/worker/main.py \
  --account act_4599179240326859 \
  --mode full \
  --disable-policy-smart-skip
```

Run full flow and send Slack:

```bash
python production/worker/main.py \
  --account act_4599179240326859 \
  --mode full \
  --channel C08EA0XE2UU \
  --viewer-url https://report-viewer-theta.vercel.app/report-viewer
```

The default Slack format is the catalog/card message:

```bash
python production/worker/main.py \
  --account act_4599179240326859 \
  --mode full \
  --slack-format catalog
```

Use `--slack-format viewer` only when you need the old report-link message.
The catalog format includes the `Details` and `Ignore rule` buttons by default.

Catalog cards use placement screenshots when available and fall back to the ad
creative thumbnail for policy/spelling-only issues. Catalog images are fitted
onto a white canvas and uploaded to Supabase by default so Slack does not crop
the creative. The default can be made explicit with
`--catalog-cache-images --catalog-fit-images --catalog-max-cards 10`.

The worker calls the catalog sender with `--upload-report` and `--log-send` by
default. The send log is required by the Slack `Ignore rule` modal because n8n
queries `ad_compliance_slack_send_issues` to render the selectable rule list.

Check which Slack channel an account will use without running checks:

```bash
python production/worker/main.py \
  --account act_4599179240326859 \
  --check-slack-routing
```

## Notes

- Secrets come from the root `.env` in local runs.
- In Cloud Run/Mac mini, provide secrets via environment variables.
- Unified Slack sends use `Slack Channel ID` from the Google Sheet `Client`
  tab first. `--channel` is only a fallback/debug override.
- Google service account JSON must not be baked into the Docker image. Mount it
  as a secret at `v2.0_run-all-ad-acc/ai-sheet-manager-service-account.json`.
- This wrapper does not delete or move legacy code.
