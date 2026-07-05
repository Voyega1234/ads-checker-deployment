# Cloudflare Tunnel — Webhook Deploy Guide

Exposes the local `production/api-trigger/server.js` on the Mac mini as a public
HTTPS endpoint that n8n can call when a new Meta ad appears.

```
n8n → https://ads-trigger.convertcake.com/runs
         ↓ (Cloudflare Tunnel)
      Mac mini :8080 → production/api-trigger/server.js
         ↓
      production/worker/main.py (background)
         ↓
      mac_mini_worker pipeline → Gemini ADC → Slack
```

---

## 1. Prerequisites

```bash
# Install cloudflared
brew install cloudflared

# Confirm gcloud ADC is active (run once)
gcloud auth application-default login
gcloud config set project ads-compliance-494407

# Confirm Node.js is available
node --version   # >= 18
```

---

## 2. Environment File

Create `/Users/convertcake/Desktop/ads-checker-deployment/.env.trigger` (gitignored):

```bash
# Auth
RUN_TRIGGER_TOKEN=<generate: openssl rand -hex 32>

# Runner
TRIGGER_RUNNER=local
MAX_CONCURRENT_RUNS=2
PORT=8080

# Gemini
GEMINI_AUTH_MODE=adc
GOOGLE_CLOUD_PROJECT=ads-compliance-494407
GOOGLE_CLOUD_LOCATION=global

# Slack / report
REPORT_VIEWER_URL=https://report-viewer-theta.vercel.app/report-viewer
SLACK_ALERT_FORMAT=catalog
POLICY_ENGINE=macmini

# Optional: override all runs to a single Slack channel for debugging
# SLACK_OVERRIDE_CHANNEL_ID=C0B1ZT7S1HV
```

---

## 3. Start the API Trigger Server

```bash
cd /Users/convertcake/Desktop/ads-checker-deployment
set -a && source .env.trigger && set +a
node production/api-trigger/server.js
```

Verify it's up:

```bash
curl http://127.0.0.1:8080/health
# {"ok":true,"service":"ad-compliance-trigger","runner":"local",...}
```

---

## 4. Cloudflare Tunnel Setup (one-time)

### 4a. Login and create tunnel

```bash
cloudflared tunnel login
# Opens browser → select convertcake.com → Authorize

cloudflared tunnel create ads-trigger
# Saves credentials to ~/.cloudflared/<tunnel-id>.json
# Note the tunnel ID printed (looks like: a1b2c3d4-...)

cloudflared tunnel list
# Confirm it appears
```

### 4b. Create config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: ads-trigger
credentials-file: /Users/convertcake/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: ads-trigger.convertcake.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Replace `<tunnel-id>` with the UUID from step 4a.

### 4c. Add DNS record

```bash
cloudflared tunnel route dns ads-trigger ads-trigger.convertcake.com
# Creates CNAME: ads-trigger.convertcake.com → <tunnel-id>.cfargotunnel.com
```

### 4d. Test the tunnel (foreground first)

```bash
# Keep the trigger server running in another tab, then:
cloudflared tunnel run ads-trigger

# In a third tab:
curl https://ads-trigger.convertcake.com/health
# Should return {"ok":true,...}
```

---

## 5. Auto-start on Mac Boot (launchd)

Two LaunchAgent plist files — one for the API server, one for the tunnel.

### 5a. API Trigger Server

Create `~/Library/LaunchAgents/com.convertcake.ads-trigger.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.convertcake.ads-trigger</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/convertcake/Desktop/ads-checker-deployment/production/api-trigger/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/convertcake/Desktop/ads-checker-deployment</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>             <string>8080</string>
    <key>TRIGGER_RUNNER</key>   <string>local</string>
    <key>MAX_CONCURRENT_RUNS</key> <string>2</string>
    <key>GEMINI_AUTH_MODE</key> <string>adc</string>
    <key>GOOGLE_CLOUD_PROJECT</key> <string>ads-compliance-494407</string>
    <key>GOOGLE_CLOUD_LOCATION</key> <string>global</string>
    <key>POLICY_ENGINE</key>    <string>macmini</string>
    <key>SLACK_ALERT_FORMAT</key> <string>catalog</string>
    <key>REPORT_VIEWER_URL</key>
      <string>https://report-viewer-theta.vercel.app/report-viewer</string>
    <key>RUN_TRIGGER_TOKEN</key>
      <string>REPLACE_WITH_YOUR_TOKEN</string>
    <key>PATH</key>
      <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>

  <key>RunAtLoad</key>  <true/>
  <key>KeepAlive</key> <true/>

  <key>StandardOutPath</key>
    <string>/Users/convertcake/Desktop/ads-checker-deployment/logs/api-trigger/server.log</string>
  <key>StandardErrorPath</key>
    <string>/Users/convertcake/Desktop/ads-checker-deployment/logs/api-trigger/server.log</string>
</dict>
</plist>
```

### 5b. Cloudflare Tunnel

Create `~/Library/LaunchAgents/com.convertcake.cloudflared.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.convertcake.cloudflared</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>run</string>
    <string>ads-trigger</string>
  </array>

  <key>RunAtLoad</key>  <true/>
  <key>KeepAlive</key> <true/>

  <key>StandardOutPath</key>
    <string>/Users/convertcake/Desktop/ads-checker-deployment/logs/api-trigger/cloudflared.log</string>
  <key>StandardErrorPath</key>
    <string>/Users/convertcake/Desktop/ads-checker-deployment/logs/api-trigger/cloudflared.log</string>
</dict>
</plist>
```

### 5c. Load both services

```bash
mkdir -p /Users/convertcake/Desktop/ads-checker-deployment/logs/api-trigger

launchctl load ~/Library/LaunchAgents/com.convertcake.ads-trigger.plist
launchctl load ~/Library/LaunchAgents/com.convertcake.cloudflared.plist

# Check they started
launchctl list | grep convertcake

# Tail logs
tail -f /Users/convertcake/Desktop/ads-checker-deployment/logs/api-trigger/server.log
tail -f /Users/convertcake/Desktop/ads-checker-deployment/logs/api-trigger/cloudflared.log
```

### 5d. Manage services

```bash
# Restart after config change
launchctl unload ~/Library/LaunchAgents/com.convertcake.ads-trigger.plist
launchctl load   ~/Library/LaunchAgents/com.convertcake.ads-trigger.plist

# Stop permanently
launchctl unload ~/Library/LaunchAgents/com.convertcake.ads-trigger.plist
launchctl unload ~/Library/LaunchAgents/com.convertcake.cloudflared.plist
```

---

## 6. n8n Configuration

### Node: HTTP Request

| Field  | Value |
|--------|-------|
| Method | POST |
| URL    | `https://ads-trigger.convertcake.com/runs` |
| Authentication | Header Auth |
| Header name | `Authorization` |
| Header value | `Bearer <your RUN_TRIGGER_TOKEN>` |
| Content-Type | `application/json` |

### Body — new ad webhook (standard n8n trigger)

```json
{
  "accountId": "{{ $json.account_id }}",
  "mode": "full",
  "policyEngine": "macmini",
  "source": "n8n-webhook",
  "newAdIds": "{{ $json.new_ad_ids }}",
  "eventIds": "{{ $json.event_ids }}",
  "markEventsProcessed": true,
  "slackFormat": "catalog",
  "catalogMaxCards": 10
}
```

### Body — test (dry-run, no actual run)

```json
{
  "testCase": "grand-home-mart",
  "mode": "full",
  "channel": "C0B1ZT7S1HV",
  "dryRun": true
}
```

### Body — full account run (manual/admin)

```json
{
  "allAccounts": true,
  "mode": "full",
  "policyEngine": "macmini",
  "accountDelay": 5,
  "allowFullAccountRun": true,
  "slackFormat": "catalog"
}
```

---

## 7. Quick Test After Deploy

```bash
TOKEN="<your RUN_TRIGGER_TOKEN>"

# Health check
curl https://ads-trigger.convertcake.com/health

# Dry-run (validates payload, returns generated args without triggering)
curl -s -X POST https://ads-trigger.convertcake.com/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "act_24333702262938851",
    "mode": "full",
    "policyEngine": "macmini",
    "newAdIds": ["120000000000000001"],
    "dryRun": true
  }' | jq .

# Live run (real ads, sends to Slack)
curl -s -X POST https://ads-trigger.convertcake.com/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "act_24333702262938851",
    "mode": "full",
    "policyEngine": "macmini",
    "newAdIds": ["<real_ad_id>"],
    "channel": "C0B1ZT7S1HV",
    "source": "manual-test"
  }' | jq .

# Tail the worker log to watch progress
tail -f logs/api-trigger/run-*.log
```

---

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `curl: (6) Could not resolve host` | Tunnel not running — check `cloudflared.log` |
| `401 unauthorized` | Wrong `RUN_TRIGGER_TOKEN` in request header |
| `409 run_already_in_progress` | Previous run still active; wait or increase `MAX_CONCURRENT_RUNS` |
| `400 newAdIds is required` | Pass `newAdIds` or `"allowFullAccountRun": true` |
| ADC warning in server log | Normal for user credentials — set `GOOGLE_CLOUD_PROJECT` (already done) |
| Gemini `PERMISSION_DENIED` | Re-run `gcloud auth application-default login` as the Mac mini user |
| launchctl service not starting | Check plist path to `node` — run `which node` and update plist if different |
