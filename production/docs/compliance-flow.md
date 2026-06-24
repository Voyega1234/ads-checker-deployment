# Ad Compliance Flow

This document is the working source of truth for how the production wrapper,
Mac mini trigger API, policy checker, placement checker, report builder, and
Slack sender fit together.

Update this file when the flow changes so we do not need to rediscover behavior
from code during every debugging session.

## Current Decision

Use a hybrid policy runner:

- `legacy` for small accounts because it starts immediately and is faster when
  there are only a few unique text groups.
- `batch` for large accounts because realtime Gemini calls can stall on many
  text groups and block the whole all-account run.

Recommended threshold:

```text
if text_groups_to_process >= 20 or fetched_ads >= 40:
  use batch policy
else:
  use legacy policy
```

The current worker supports automatic threshold switching with
`--policy-runner hybrid`. `hybrid` is the default unless `POLICY_RUNNER` is set.

## Main Entrypoints

### Production Worker

File: `production/worker/main.py`

This is the stable wrapper used by local runs, Mac mini runs, and Cloud Run
jobs. It keeps the older implementation in `v2.0_run-all-ad-acc` and `src`
intact.

Supported modes:

```text
doctor     validate environment and syntax
policy     run policy/spelling checks only
placement  run placement preview checks only
unified    build unified alert JSON from placement + policy DB results
slack      send an existing unified alert to Slack
full       policy -> placement -> unified -> Slack
```

Account selection:

```text
--account act_<id>        one account
--accounts act_a,act_b    selected active accounts
--all-accounts            all active accounts that have Client sheet Slack Channel ID
```

Important options:

```text
--policy-runner legacy|batch|hybrid
--disable-policy-smart-skip
--hybrid-batch-min-ads 40
--hybrid-batch-min-text-groups 20
--batch-poll-interval 60
--batch-timeout 7200
--batch-force-recheck
--viewer-url https://report-viewer-theta.vercel.app/report-viewer
--source webhook
--new-ad-ids 123,456
--event-ids uuid1,uuid2
--mark-events-processed
--skip-slack
```

### API Trigger

File: `production/api-trigger/server.js`

This is a thin HTTP API for n8n or manual triggers. It does not run the checks
inside the HTTP request. It validates the JSON body, starts a background worker,
then returns `202`.

Endpoints:

```text
GET  /health
POST /runs
```

Authentication:

```text
Authorization: Bearer $RUN_TRIGGER_TOKEN
```

Local Mac mini runner:

```text
TRIGGER_RUNNER=local
MAX_CONCURRENT_RUNS=1
PORT=8080
```

When `MAX_CONCURRENT_RUNS=1`, a second request returns:

```json
{ "ok": false, "error": "run_already_in_progress" }
```

Logs:

```text
logs/api-trigger/run-<timestamp>.log
logs/api-trigger/runs/<timestamp>.json
```

## Full Workflow

For one account in `--mode full`:

```text
1. Resolve Slack route from Client sheet.
2. Policy smart-skip preflight.
3. Run policy/spelling checks only when active ad content changed or webhook new ad IDs exist.
   Webhook new-ad runs fetch the explicit ad IDs without the ACTIVE filter, because
   in-process ads are normally `PENDING_REVIEW`.
4. Run placement preview checks. Webhook new-ad runs also fetch explicit ad IDs
   without the active/spend filters.
5. Build unified report JSON.
6. Send unified Slack alert.
7. Optionally mark webhook status events as processed.
```

The worker runs accounts sequentially in `--all-accounts` mode:

```text
account A finishes fully
wait --account-delay seconds
account B starts
```

With the current batch runner, `--policy-runner batch` uses `--wait`, so the
worker waits for the batch to finish before moving to placement or the next
account. `--policy-runner hybrid` may choose batch for large accounts, so this
same wait behavior applies after the decision.

## Slack Routing

Source of truth: Google Sheet `Client` tab.

Required columns:

```text
Slack Channel ID
Slack Channel Name
```

For all-account runs, only active accounts that have `Slack Channel ID` in the
Client sheet are runnable. Accounts without this field are skipped before any
Meta/Gemini work is started.

`--channel` is a fallback/debug override for single-account testing. Production
routing should come from the sheet.

Check routing:

```bash
python3 production/worker/main.py --all-accounts --check-slack-routing
python3 production/worker/main.py --account act_1177861947760094 --check-slack-routing
```

## Policy And Spelling Flow

Policy smart-skip:

```text
production/worker/main.py
  -> read-only Meta fetch for active ads
  -> read meta_ad_check_db snapshot for the account/client
  -> compare each active ad with text:
       ad_id exists in DB
       creative_id unchanged
       normalized ad_text unchanged
  -> skip policy runner if all active text ads are unchanged and no webhook newAdIds were passed
```

Smart-skip is enabled by default. It is bypassed when:

```text
--disable-policy-smart-skip
--batch-force-recheck
--new-ad-ids has any value
missing Client mapping
any active text ad is new or changed
```

This skip only avoids policy/spelling work. Placement still runs and can reuse
its own cache independently.

Hybrid runner:

```text
production/worker/main.py
  -> read-only Meta preflight
  -> count active fetched ads
  -> count unique extracted ad_text groups
  -> choose batch if fetched_ads >= 40 or unique_text_groups >= 20
  -> otherwise choose legacy
```

The thresholds can be changed with:

```text
POLICY_HYBRID_BATCH_MIN_ADS
POLICY_HYBRID_BATCH_MIN_TEXT_GROUPS
```

Legacy runner:

```text
production/worker/main.py
  -> v2.0_run-all-ad-acc/worker.py --once <account>
  -> Meta fetch
  -> upsert meta_ad_check_db
  -> group identical ad_text
  -> Gemini policy/spell assessment for groups that need checking
  -> save/reuse DB results
```

Batch runner:

```text
production/worker/main.py
  -> v2.0_run-all-ad-acc/batch_policy.py submit --wait
  -> Meta fetch
  -> upsert meta_ad_check_db
  -> group identical ad_text
  -> reuse existing DB results when possible
  -> submit remaining groups to Gemini Batch API
  -> poll until complete
  -> persist parsed results
```

Important behavior:

- Dedupe for text policy/spelling is based on text grouping, not just `ad_id`.
- If different ads use the exact same `ad_text`, they should reuse one policy
  result.
- Webhook-triggered ads may have missing `creative.body` or direct image URL.
  For those, the Meta fetch fallback should use:
  - `asset_feed_spec.bodies[0].text`
  - `asset_feed_spec.images`

## Policy Rule Retrieval

Embedding retrieval is the default for policy prompts:

```text
POLICY_RULE_RETRIEVAL=embedding  # default; use all only for debugging/fallback
POLICY_RULE_EMBEDDING_MATCH_COUNT=100
POLICY_RULE_EMBEDDING_VECTOR_CANDIDATES=150
```

Both legacy policy checks and batch policy checks call
`embed_policy_rules_gemini.search_policy_rules_for_prompt()` so the prompt gets
only the most relevant policy rules for each unique caption/text group instead
of every rule.

If embedding search fails, the code falls back to all rules.

`RULES_BLOCK` is compacted before sending to Gemini. Internal retrieval
metadata such as `retrieval`, `match_source`, `similarity`, and
`combined_rank_score` is removed from the prompt. `rule_id` stays in the prompt
because the structured response schema uses it to trace findings back to the
source rule.

Manual test:

```bash
cd v2.0_run-all-ad-acc
python embed_policy_rules_gemini.py search --text "ลงทุนง่าย ได้ชัวร์ เทคนิค scalping"
```

## Placement Flow

Placement runner:

```text
production/worker/main.py
  -> node src/index.js --json
```

Environment passed by wrapper:

```text
META_AD_ACCOUNT_ID=act_<id>
OUTPUT_DIR=output/<account_num>
AD_LIMIT=all
MIN_SPEND=0
```

Output:

```text
output/<account_num>/report-latest.json
```

The placement checker fetches active ads from Meta and validates configured
placements/previews. If no active ads match the current filters, no placement
report may be produced. The wrapper currently treats missing placement report
as a failed account; this should eventually become a clearer `no_active_ads`
status.

Placement cache:

```text
src/index.js
  -> loadPlacementCache()
  -> read meta_ad_check_db.ad_media_assessment_result
  -> reuse cached placement results when fingerprint matches
  -> save placement result back to meta_ad_check_db
```

The cache fingerprint includes:

```text
PLACEMENT_CACHE_VERSION
GEMINI_MODEL
creativeId
creativeEffectiveObjectStoryId
creativeImageHash
creativeThumbnailUrl
creativeObjectType
creativeInstagramPermalinkUrl
formats
```

Default TTL is 168 hours and can be changed with:

```text
PLACEMENT_CACHE_TTL_HOURS
```

Set `PLACEMENT_CACHE_TTL_HOURS=0` to disable TTL expiry. Bump
`PLACEMENT_CACHE_VERSION` when the placement validation prompt/rules change and
old cached placement decisions should not be reused.

## Unified Report And Slack

Unified builder:

```text
node src/build-unified-compliance-alert.js \
  --report output/<account_num>/report-latest.json \
  --account act_<id> \
  --out output/<account_num>/unified-alert-<account_num>.json
```

Webhook metadata:

```text
--source webhook
--new-ad-ids 123,456
```

The unified report groups open issues into:

```text
Affected ads
Policy
Spelling
Placement
```

Policy display ignores low-priority/waived rules before building report and
Slack output. Raw Gemini output and `meta_ad_check_db` stay unchanged for audit.
By default, rules with `policy_rules.priority = 50` are ignored in display. This
currently covers the Thai translation requirement rule, so if it is the only
failing rule the ad displays as pass/no open policy issue. If the same ad also
fails other policy rules, only the non-ignored rules remain visible.

Future display ignores can be added without code changes:

```text
AD_COMPLIANCE_DISPLAY_IGNORE_RULE_PRIORITIES=50
AD_COMPLIANCE_DISPLAY_IGNORE_RULE_IDS=rule_id_1,rule_id_2
```

Client-specific display ignores are stored in Supabase:

```text
client_policy_rule_ignores
  client_id
  rule_id
  is_ignored
  last_updated_by_slack_id
```

When `is_ignored = true`, the unified report filters that rule only for the
matching client. The catalog Slack cards expose an `Ignore rule` action only on
cards that contain policy issues with rule IDs. The action payload includes the
account/client/issue identifiers and the affected rule IDs; the logged issue row
also stores `meta.ignorableRules` for n8n to render the selection modal.

Slack sender:

```text
node src/send-report-viewer-to-slack.js \
  --json output/<account_num>/unified-alert-<account_num>.json \
  --channel <Slack Channel ID> \
  --viewer-url https://report-viewer-theta.vercel.app/report-viewer
```

Catalog Slack sender uses fitted white-canvas images by default so carousel
cards show the whole creative instead of raw cropped media. Relevant controls:

```text
CATALOG_CACHE_IMAGES=1
CATALOG_FIT_IMAGES=1
CATALOG_MAX_CARDS=10
```

Manual catalog sends can override with `--max-cards <n>`. Use
`--no-cache-images --no-fit-images` only for explicit raw-image debugging.

If there are no open issues, Slack may be skipped with reason `no_open_issues`.

## Report Viewer

Viewer base URL:

```text
https://report-viewer-theta.vercel.app/report-viewer
```

Report URL shape:

```text
https://report-viewer-theta.vercel.app/report-viewer?report=<public-report-json-url>
```

The report JSON is uploaded to Supabase Storage and the viewer reads it from
the `report` query parameter.

## Webhook/N8N Flow

Meta webhook rows are saved to:

```text
meta_ad_status_events
```

Important columns:

```text
ad_account_id
ad_object_id
level
status_name
field
event_time
event_datetime
processed_at
batch_id
process_error
```

N8N should group pending events for a short debounce window, then call the API
with arrays. For one account:

```json
{
  "mode": "full",
  "accountId": "act_1047165889391141",
  "policyRunner": "batch",
  "source": "webhook",
  "newAdIds": ["120243898233580277"],
  "eventIds": ["a1012c92-38ad-47a7-870d-a6f907ad31fa"],
  "channel": "C08EA0XE2UU",
  "markEventsProcessed": true,
  "batchPolicyPollInterval": 60,
  "batchPolicyTimeout": 7200
}
```

`newAdIds` and `eventIds` must be JSON arrays, not raw strings without quotes.

For multiple accounts in one debounce window, prefer one API request with
`accountIds` and flat `newAdIds` / `eventIds` arrays. The worker runs accounts
sequentially, and each account fetches only matching ad IDs from its own account
edge. This avoids concurrent API-trigger conflicts while still batching the
webhook events.

The worker marks matching `meta_ad_status_events` as processed after the run if:

- `--mark-events-processed` is passed.
- Supabase env is available.
- `event_ids` or `new_ad_ids` match unprocessed rows.

## Data Stores

Supabase tables currently involved:

```text
meta_adaccounts              active account list and client mapping
meta_ad_check_db             fetched ad/creative/text state and policy status
ad_compliance_issue_states   resolved/ignored issue state from report viewer
client_policy_rule_ignores   client-specific policy rules hidden from Slack display
policy_rule_types            policy rule metadata
vw_rules_block_rows          prompt rule rows
meta_ad_status_events        Meta webhook status events
```

Storage:

```text
ads-compliance/ad-preview-checker/reports/<date>/<client-account-date>.json
```

Local output:

```text
output/<account_num>/report-latest.json
output/<account_num>/unified-alert-<account_num>.json
```

## Recommended Production Shape

Simple current shape:

```text
n8n schedule/webhook
  -> Cloudflare Tunnel
  -> Mac mini API trigger
  -> production worker
  -> Supabase + Slack
```

Current hybrid shape:

```text
preflight account
  -> count fetched ads and text groups
  -> legacy if small
  -> batch if large
```

Larger future improvement:

```text
Phase 1: submit batch jobs for large accounts
Phase 2: run legacy small accounts while batches process
Phase 3: collect batch results, build reports, send Slack
```

The larger version is more scalable but needs more job state tracking. The
hybrid synchronous version is the safest next step.

## Operational Commands

Run all active routed accounts:

```bash
POLICY_RULE_EMBEDDING_MATCH_COUNT=100 \
POLICY_RULE_EMBEDDING_VECTOR_CANDIDATES=150 \
python3 production/worker/main.py \
  --mode full \
  --all-accounts \
  --policy-runner hybrid \
  --viewer-url https://report-viewer-theta.vercel.app/report-viewer
```

Run one account with batch policy:

```bash
python3 production/worker/main.py \
  --mode full \
  --account act_1047165889391141 \
  --policy-runner batch \
  --batch-poll-interval 60 \
  --batch-timeout 7200 \
  --viewer-url https://report-viewer-theta.vercel.app/report-viewer
```

Trigger from API:

```bash
curl -X POST "$TRIGGER_API_URL/runs" \
  -H "Authorization: Bearer $RUN_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "act_1177861947760094",
    "mode": "full",
    "policyRunner": "legacy"
  }'
```

Tail latest local API-triggered run:

```bash
tail -f logs/api-trigger/run-<timestamp>.log
```

Tail latest manual full workflow run if `latest.logpath` exists:

```bash
tail -f "$(cat logs/full-workflow/latest.logpath)"
```

## Known Gaps

- Policy smart-skip is based on active ad `creative_id` and `ad_text`; it does
  not skip webhook-triggered runs with explicit `newAdIds`.
- Batch mode currently waits for completion before moving to the next account.
- Missing placement reports are currently treated as failed accounts, even when
  the real state is simply no active ads matched.
- Some legacy text checks can fail with `Prompt 'spell_checker' not found`.
  The flow continues, but this should be cleaned up.
- For account groups with many unique captions, legacy realtime requests can
  timeout and make the all-account run too slow.
