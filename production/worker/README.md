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

Build unified report from the latest placement output:

```bash
python production/worker/main.py --account act_4599179240326859 --mode unified
```

Run full flow but do not send Slack:

```bash
python production/worker/main.py --account act_4599179240326859 --mode full --skip-slack
```

Run full flow and send Slack:

```bash
python production/worker/main.py \
  --account act_4599179240326859 \
  --mode full \
  --channel C08EA0XE2UU \
  --viewer-url https://report-viewer-theta.vercel.app/report-viewer
```

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
