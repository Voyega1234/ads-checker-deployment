#!/usr/bin/env python3
"""
Production wrapper for the current ad compliance flow.

This wrapper keeps the existing implementation intact and gives us one stable
entrypoint for local, Mac mini, and Cloud Run.

Single account:
  python production/worker/main.py --account act_123

All active accounts from Supabase:
  python production/worker/main.py --all-accounts
  python production/worker/main.py --all-accounts --skip-slack
  python production/worker/main.py --all-accounts --channel C08EA0XE2UU
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from slack_routing import resolve_slack_route, resolve_slack_routes


PROJECT_ROOT = Path(__file__).resolve().parents[2]
POLICY_DIR = PROJECT_ROOT / "v2.0_run-all-ad-acc"
OUTPUT_DIR = PROJECT_ROOT / os.environ.get("OUTPUT_DIR", "output")
DEFAULT_REPORT_VIEWER_URL = "https://report-viewer-theta.vercel.app/report-viewer"


def load_project_env() -> None:
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
    alias_env("SUPABASE_URL", "VITE_SUPABASE_URL")
    alias_env("SUPABASE_SERVICE_KEY", "VITE_SUPABASE_SERVICE_KEY")
    alias_env("SLACK_BOT_TOKEN", "SLACK_BOT_OAUTH")


def alias_env(target: str, source: str) -> None:
    if os.environ.get(target):
        return
    value = os.environ.get(source)
    if value:
        os.environ[target] = value


def main() -> int:
    load_project_env()
    parser = argparse.ArgumentParser(description="Run ad compliance production flow.")
    parser.add_argument("--account", help="Meta ad account id, with or without act_.")
    parser.add_argument("--accounts", default="", help="Comma-separated Meta ad account ids.")
    parser.add_argument("--all-accounts", action="store_true", help="Run all active accounts from Supabase.")
    parser.add_argument("--account-delay", type=int, default=5, help="Seconds to wait between accounts (default: 5).")
    parser.add_argument(
        "--mode",
        choices=["doctor", "policy", "placement", "unified", "slack", "full"],
        default="full",
        help="Which part of the flow to run.",
    )
    parser.add_argument("--channel", default=os.environ.get("SLACK_OVERRIDE_CHANNEL_ID", ""))
    parser.add_argument("--viewer-url", default=os.environ.get("REPORT_VIEWER_URL", DEFAULT_REPORT_VIEWER_URL))
    parser.add_argument("--placement-report", default="")
    parser.add_argument("--unified-report", default="")
    parser.add_argument("--skip-slack", action="store_true")
    parser.add_argument(
        "--disable-recent-slack-skip",
        action="store_true",
        default=os.environ.get("RECENT_SLACK_SKIP", "1").strip().lower() in {"0", "false", "no", "off"},
        help=(
            "Do not skip accounts that already sent an ad_compliance_slack_sends "
            "status=sent row within the recent Slack window."
        ),
    )
    parser.add_argument(
        "--recent-slack-skip-hours",
        type=float,
        default=float(os.environ.get("RECENT_SLACK_SKIP_HOURS", "24")),
        help="Skip account if ad_compliance_slack_sends has status=sent within this many hours.",
    )
    parser.add_argument(
        "--disable-policy-smart-skip",
        action="store_true",
        default=os.environ.get("POLICY_SMART_SKIP", "1").strip().lower() in {"0", "false", "no", "off"},
        help=(
            "Always enter the policy runner. By default, policy is skipped when active ads "
            "have the same creative/text as meta_ad_check_db and no webhook new ad IDs are present."
        ),
    )
    parser.add_argument(
        "--policy-runner",
        choices=["legacy", "batch", "hybrid"],
        default=os.environ.get("POLICY_RUNNER", "hybrid"),
        help=(
            "Policy assessment runner. legacy keeps current realtime worker; "
            "batch uses Gemini Batch API; hybrid chooses batch for larger accounts."
        ),
    )
    parser.add_argument(
        "--hybrid-batch-min-ads",
        type=int,
        default=int(os.environ.get("POLICY_HYBRID_BATCH_MIN_ADS", "40")),
        help="Use batch in hybrid mode when active fetched ads are at least this number.",
    )
    parser.add_argument(
        "--hybrid-batch-min-text-groups",
        type=int,
        default=int(os.environ.get("POLICY_HYBRID_BATCH_MIN_TEXT_GROUPS", "20")),
        help="Use batch in hybrid mode when unique fetched ad text groups are at least this number.",
    )
    parser.add_argument(
        "--batch-poll-interval",
        type=int,
        default=int(os.environ.get("BATCH_POLICY_POLL_INTERVAL", "60")),
        help="Seconds between Gemini Batch API status polls when --policy-runner batch is used.",
    )
    parser.add_argument(
        "--batch-timeout",
        type=int,
        default=int(os.environ.get("BATCH_POLICY_TIMEOUT", "7200")),
        help="Max seconds to wait for Gemini Batch API completion.",
    )
    parser.add_argument(
        "--batch-force-recheck",
        action="store_true",
        help="Force policy batch requests even if reusable DB results already exist.",
    )
    parser.add_argument("--source", default="", help="Run source label, e.g. webhook.")
    parser.add_argument("--new-ad-ids", default="", help="Comma-separated ad IDs that triggered this run.")
    parser.add_argument("--event-ids", default="", help="Comma-separated meta_ad_status_events IDs to mark processed.")
    parser.add_argument(
        "--mark-events-processed",
        action="store_true",
        help="Mark matching meta_ad_status_events rows processed after a successful run.",
    )
    parser.add_argument("--check-slack-routing", action="store_true", help="Print Slack routing and exit.")
    parser.add_argument("--require-env", action="store_true")
    parser.add_argument("--require-slack", action="store_true")
    parser.add_argument("--require-policy", action="store_true")
    args = parser.parse_args()

    if args.mode == "doctor":
        return run_doctor(args)

    if args.check_slack_routing:
        return check_slack_routing(args)

    if args.all_accounts:
        return run_all_accounts(args)

    if args.accounts:
        return run_selected_accounts(args)

    if not args.account:
        raise SystemExit("Missing --account, --accounts, or --all-accounts")

    return run_single_account(args.account, args)


def run_all_accounts(args: argparse.Namespace) -> int:
    accounts = load_active_accounts()
    if not accounts:
        print("No active accounts found in Supabase.")
        return 0
    accounts = filter_accounts_with_sheet_slack(accounts)
    if not accounts:
        print("No active accounts with Slack Channel ID in Client sheet.")
        return 0
    return run_account_list(accounts, args)


def run_selected_accounts(args: argparse.Namespace) -> int:
    requested = [normalize_account(item) for item in str(args.accounts).split(",") if item.strip()]
    if not requested:
        raise SystemExit("Missing --accounts values")

    active_accounts = load_active_accounts()
    active_by_id = {str(acc.get("ad_account_act_id") or "").lower(): acc for acc in active_accounts}
    missing = [account for account in requested if account.lower() not in active_by_id]
    if missing:
        raise SystemExit(
            "Requested account(s) are not Active in meta_adaccounts: " + ", ".join(missing)
        )

    accounts = [active_by_id[account.lower()] for account in requested]
    accounts = filter_accounts_with_sheet_slack(accounts)
    if not accounts:
        print("No selected active accounts with Slack Channel ID in Client sheet.")
        return 0
    return run_account_list(accounts, args)


def run_account_list(accounts: list[dict], args: argparse.Namespace) -> int:
    print(f"\nRunning {len(accounts)} active accounts\n{'─' * 50}")
    errors: list[tuple[str, str]] = []
    timings: list[dict] = []
    slack_send_tracker: set[str] = set()

    for i, acc in enumerate(accounts, 1):
        account_id = acc["ad_account_act_id"]
        account_name = acc.get("account_name") or account_id
        started = time.monotonic()
        print(f"\n[{i}/{len(accounts)}] {account_name} ({account_id})")
        status = "success"
        error_msg = ""
        try:
            run_single_account(account_id, args, slack_send_tracker=slack_send_tracker)
        except SystemExit as exc:
            msg = str(exc)
            print(f"  ERROR: {msg}")
            errors.append((account_id, msg))
            status = "failed"
            error_msg = msg
        except Exception as exc:
            print(f"  ERROR: {exc}")
            errors.append((account_id, str(exc)))
            status = "failed"
            error_msg = str(exc)
        elapsed = time.monotonic() - started
        timings.append({
            "account": account_id,
            "account_name": account_name,
            "status": status,
            "elapsed_sec": round(elapsed, 1),
            "elapsed": format_duration(elapsed),
            "error": error_msg,
        })
        print(f"  account_done status={status} elapsed={format_duration(elapsed)} elapsed_sec={elapsed:.1f}")

        if i < len(accounts) and args.account_delay > 0:
            print(f"  Waiting {args.account_delay}s before next account...")
            time.sleep(args.account_delay)

    print(f"\n{'─' * 50}")
    print(f"Done: {len(accounts) - len(errors)}/{len(accounts)} accounts succeeded")
    if errors:
        print(f"\nFailed accounts ({len(errors)}):")
        for account_id, msg in errors:
            print(f"  {account_id}: {msg}")
    print("\nAccount timings:")
    for item in timings:
        suffix = f" error={item['error']}" if item["error"] else ""
        print(
            f"  {item['account']} | {item['account_name']} | "
            f"{item['status']} | {item['elapsed']} ({item['elapsed_sec']}s){suffix}"
        )
    print("ACCOUNT_TIMINGS_JSON=" + json.dumps(timings, ensure_ascii=False))
    if errors:
        return 1
    return 0


def format_duration(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    minutes, secs = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def build_slack_dedupe_key(route) -> str:
    client = (route.client_id or route.account_name or route.account or "").strip().lower()
    channel = (route.channel_id or "").strip().lower()
    return f"{client}|{channel}"


def should_check_recent_slack_send(args: argparse.Namespace, slack_route) -> bool:
    if args.disable_recent_slack_skip:
        return False
    if args.recent_slack_skip_hours <= 0:
        return False
    if args.mode == "full" and args.skip_slack:
        return False
    if args.mode not in {"full", "slack"}:
        return False
    if not slack_route or not slack_route.channel_id:
        return False
    return True


def find_recent_slack_send(account: str, args: argparse.Namespace) -> dict | None:
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY") or ""
    if not supabase_url or not supabase_key:
        print("  Recent Slack skip disabled for this account (missing Supabase env).")
        return None

    cutoff = datetime.fromtimestamp(
        time.time() - (float(args.recent_slack_skip_hours) * 60 * 60),
        tz=timezone.utc,
    ).isoformat()
    query = urllib.parse.urlencode(
        {
            "select": "id,account_id,channel_id,slack_ts,report_url,viewer_url,sent_at,status",
            "account_id": f"eq.{account}",
            "status": "eq.sent",
            "sent_at": f"gte.{cutoff}",
            "order": "sent_at.desc",
            "limit": "1",
        }
    )
    url = f"{supabase_url}/rest/v1/ad_compliance_slack_sends?{query}"
    try:
        rows = get_supabase_rows(url, supabase_key)
    except Exception as exc:
        print(f"  Recent Slack skip check failed; continuing run: {exc}")
        return None
    return rows[0] if rows else None


def run_single_account(
    account_raw: str,
    args: argparse.Namespace,
    slack_send_tracker: set[str] | None = None,
) -> int:
    account = normalize_account(account_raw)
    account_num = account.replace("act_", "")
    new_ad_ids = parse_csv_values(args.new_ad_ids)
    event_ids = parse_csv_values(args.event_ids)
    event_batch_id = str(uuid.uuid4())
    slack_route = None
    if args.mode in {"policy", "slack", "full"}:
        slack_route = resolve_slack_route(
            account,
            policy_python=_policy_python(),
            policy_dir=POLICY_DIR,
            fallback_channel=args.channel,
        )
        override_channel = str(args.channel or "").strip()
        if override_channel:
            slack_route = replace(
                slack_route,
                channel_id=override_channel,
                channel_name=override_channel,
                source="override",
            )

    recent_send = find_recent_slack_send(account, args) if should_check_recent_slack_send(args, slack_route) else None
    if recent_send:
        print(
            "  Recent Slack send found; skipping account "
            f"sent_at={recent_send.get('sent_at') or '-'} channel={recent_send.get('channel_id') or '-'} "
            f"slack_ts={recent_send.get('slack_ts') or '-'}"
        )
        if args.mark_events_processed:
            mark_status_events_processed(
                account_num,
                new_ad_ids=new_ad_ids,
                event_ids=event_ids,
                batch_id=event_batch_id,
                source=args.source,
            )
        return 0

    account_output_dir = OUTPUT_DIR / account_num
    account_output_dir.mkdir(parents=True, exist_ok=True)

    placement_report = (
        Path(args.placement_report) if args.placement_report
        else account_output_dir / "report-latest.json"
    )
    unified_report = (
        Path(args.unified_report) if args.unified_report
        else account_output_dir / f"unified-alert-{account_num}.json"
    )

    if args.mode in {"policy", "full"}:
        client_id = (slack_route.client_id if slack_route else "").strip()
        if should_skip_policy(account, account_num, client_id, new_ad_ids, args):
            print("  Policy smart skip: active ad content unchanged and no webhook new ad IDs.")
        else:
            policy_runner = args.policy_runner
            if new_ad_ids and policy_runner != "batch":
                policy_runner = "batch"
                print("  Webhook new ad IDs detected; using batch policy fetch-by-id (no ACTIVE filter).")
            elif policy_runner == "hybrid":
                policy_runner = choose_hybrid_policy_runner(account, args)
            if policy_runner == "batch":
                if not client_id:
                    raise SystemExit(f"Cannot run batch policy without a meta_adaccounts Client for {account}")
                run_policy_batch(
                    account,
                    client_id=client_id,
                    poll_interval=args.batch_poll_interval,
                    timeout=args.batch_timeout,
                    force_recheck=args.batch_force_recheck,
                    new_ad_ids=new_ad_ids,
                )
            else:
                run_policy(account, channel=slack_route.channel_id if slack_route else args.channel)

    if args.mode in {"placement", "full"}:
        run_placement(account, account_output_dir, new_ad_ids=new_ad_ids)

    if args.mode in {"unified", "full"}:
        run_unified(
            account,
            placement_report,
            unified_report,
            source=args.source,
            new_ad_ids=new_ad_ids,
        )

    if args.mode == "slack" or (args.mode == "full" and not args.skip_slack):
        if slack_route.channel_id:
            print(format_slack_route(slack_route))
            slack_key = build_slack_dedupe_key(slack_route)
            if slack_send_tracker is not None and slack_key in slack_send_tracker:
                print("  Slack dedupe: report indexed only; client/channel already received an alert this run.")
                run_slack_index(unified_report, slack_route.channel_id, args.viewer_url)
            else:
                slack_result = run_slack(unified_report, slack_route.channel_id, args.viewer_url)
                if slack_result.get("slack"):
                    if slack_send_tracker is not None:
                        slack_send_tracker.add(slack_key)
                elif slack_result.get("skippedSlack"):
                    print("  Slack skipped; indexing report so account dropdown can include it.")
                    run_slack_index(unified_report, slack_route.channel_id, args.viewer_url)
        else:
            print("  Skipping Slack (no Client sheet Slack Channel ID, --channel, or SLACK_OVERRIDE_CHANNEL_ID set)")

    if args.mark_events_processed:
        mark_status_events_processed(
            account_num,
            new_ad_ids=new_ad_ids,
            event_ids=event_ids,
            batch_id=event_batch_id,
            source=args.source,
        )

    print(
        f"done mode={args.mode} account={account} "
        f"placement_report={placement_report} unified_report={unified_report}"
    )
    return 0


def check_slack_routing(args: argparse.Namespace) -> int:
    if args.all_accounts:
        routes = resolve_slack_routes(
            policy_python=_policy_python(),
            policy_dir=POLICY_DIR,
            fallback_channel=args.channel,
        )
    elif args.account:
        routes = [
            resolve_slack_route(
                args.account,
                policy_python=_policy_python(),
                policy_dir=POLICY_DIR,
                fallback_channel=args.channel,
            )
        ]
    else:
        raise SystemExit("Missing --account or --all-accounts for --check-slack-routing")

    missing = 0
    for route in routes:
        if not route.channel_id:
            missing += 1
        print(format_slack_route(route))
    if missing:
        print(f"Slack routing missing for {missing}/{len(routes)} account(s)")
        return 1
    return 0


def format_slack_route(route) -> str:
    channel = route.channel_id or "MISSING"
    channel_name = route.channel_name or channel
    client = route.client_id or "unknown-client"
    account_name = route.account_name or route.account
    return (
        f"  Slack route: {account_name} ({route.account}) "
        f"client={client} -> {channel_name} ({channel}) source={route.source}"
    )


def filter_accounts_with_sheet_slack(accounts: list[dict]) -> list[dict]:
    routes = resolve_slack_routes(
        policy_python=_policy_python(),
        policy_dir=POLICY_DIR,
        fallback_channel="",
    )
    route_by_account = {route.account.lower(): route for route in routes}
    runnable: list[dict] = []
    skipped: list[tuple[str, str]] = []
    for account in accounts:
        account_id = str(account.get("ad_account_act_id") or "")
        route = route_by_account.get(account_id.lower())
        if route and route.channel_id and route.source == "client_sheet":
            runnable.append(account)
        else:
            client_id = str(account.get("client_id") or "").strip() or "unknown-client"
            skipped.append((account_id, client_id))

    if skipped:
        print(f"Skipping {len(skipped)} active account(s) without Slack Channel ID in Client sheet:")
        for account_id, client_id in skipped:
            print(f"  - {account_id}: client={client_id}")
    return runnable


def load_active_accounts() -> list[dict]:
    """Load active ad accounts from Supabase via policy venv Python."""
    python_bin = _policy_python()
    script = (
        "from env_loader import load_project_env; load_project_env(); "
        "import supabase_db_helper, json; "
        "print(json.dumps(supabase_db_helper.list_active_ad_accounts()))"
    )
    result = subprocess.run(
        [str(python_bin), "-c", script],
        cwd=str(POLICY_DIR),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"Failed to load accounts from Supabase:\n{result.stderr.strip()}")
    try:
        return json.loads(result.stdout.strip())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Could not parse Supabase accounts response: {exc}") from exc


def run_doctor(args: argparse.Namespace) -> int:
    command = [sys.executable, "production/worker/doctor.py", "--check-node-syntax"]
    if args.require_env:
        command.append("--require-env")
    if args.require_slack:
        command.append("--require-slack")
    if args.require_policy:
        command.append("--require-policy")
    completed = subprocess.run(command, cwd=str(PROJECT_ROOT), check=False)
    return completed.returncode


def normalize_account(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise SystemExit("Missing --account")
    return raw if raw.startswith("act_") else f"act_{raw}"


def _policy_python() -> Path:
    python_bin = POLICY_DIR / ".venv" / "bin" / "python"
    return python_bin if python_bin.exists() else Path(sys.executable)


def run_policy(account: str, channel: str = "") -> None:
    env = os.environ.copy()
    env["DISABLE_LEGACY_TEXT_SLACK"] = "1"
    if channel:
        env["SLACK_OVERRIDE_CHANNEL_ID"] = channel
    run_command([str(_policy_python()), "worker.py", "--once", account], cwd=POLICY_DIR, env=env)


def run_policy_batch(
    account: str,
    *,
    client_id: str,
    poll_interval: int,
    timeout: int,
    force_recheck: bool,
    new_ad_ids: list[str] | None = None,
) -> None:
    command = [
        str(_policy_python()),
        "batch_policy.py",
        "submit",
        "--client-id",
        client_id,
        "--account",
        account,
        "--wait",
        "--poll-interval",
        str(max(1, int(poll_interval))),
        "--timeout",
        str(max(1, int(timeout))),
    ]
    if new_ad_ids:
        command.extend(["--new-ad-ids", ",".join(new_ad_ids)])
    if force_recheck:
        command.append("--force-recheck")
    run_command(command, cwd=POLICY_DIR)


def choose_hybrid_policy_runner(account: str, args: argparse.Namespace) -> str:
    plan = get_hybrid_policy_plan(account)
    min_ads = max(1, int(args.hybrid_batch_min_ads))
    min_text_groups = max(1, int(args.hybrid_batch_min_text_groups))
    fetched_ads = int(plan.get("fetched_ads") or 0)
    unique_text_groups = int(plan.get("unique_text_groups") or 0)
    ads_with_text = int(plan.get("ads_with_text") or 0)
    ads_missing_text = int(plan.get("ads_missing_text") or 0)
    use_batch = fetched_ads >= min_ads or unique_text_groups >= min_text_groups
    runner = "batch" if use_batch else "legacy"
    reason = []
    if fetched_ads >= min_ads:
        reason.append(f"fetched_ads>={min_ads}")
    if unique_text_groups >= min_text_groups:
        reason.append(f"unique_text_groups>={min_text_groups}")
    if not reason:
        reason.append("below_threshold")
    print(
        "  Policy runner hybrid decision: "
        f"runner={runner} fetched_ads={fetched_ads} ads_with_text={ads_with_text} "
        f"ads_missing_text={ads_missing_text} unique_text_groups={unique_text_groups} "
        f"thresholds=ads:{min_ads},text_groups:{min_text_groups} "
        f"reason={','.join(reason)}"
    )
    return runner


def should_skip_policy(
    account: str,
    account_num: str,
    client_id: str,
    new_ad_ids: list[str],
    args: argparse.Namespace,
) -> bool:
    if args.disable_policy_smart_skip:
        print("  Policy smart skip disabled.")
        return False
    if args.batch_force_recheck:
        print("  Policy smart skip bypassed: --batch-force-recheck set.")
        return False
    if new_ad_ids:
        print(f"  Policy smart skip bypassed: webhook new_ad_ids={len(new_ad_ids)}.")
        return False
    if not client_id:
        print("  Policy smart skip bypassed: missing client id.")
        return False
    plan = get_policy_smart_skip_plan(account, account_num, client_id)
    print(
        "  Policy smart skip preflight: "
        f"fetched_ads={plan.get('fetched_ads', 0)} ads_with_text={plan.get('ads_with_text', 0)} "
        f"unchanged={plan.get('unchanged', 0)} changed={plan.get('changed', 0)} "
        f"missing_db={plan.get('missing_db', 0)} missing_text={plan.get('missing_text', 0)}"
    )
    if int(plan.get("ads_with_text") or 0) <= 0:
        return True
    return bool(plan.get("can_skip"))


def get_policy_smart_skip_plan(account: str, account_num: str, client_id: str) -> dict:
    script = (
        "import json, os; "
        "from env_loader import load_project_env; load_project_env(); "
        "import creative_utils, meta_api, supabase_db_helper; "
        "account=os.environ['POLICY_SKIP_ACCOUNT']; "
        "account_num=int(os.environ['POLICY_SKIP_ACCOUNT_NUM']); "
        "client_id=os.environ['POLICY_SKIP_CLIENT_ID']; "
        "ads=meta_api.get_active_ads_with_creatives(account_id=account); "
        "snapshot=supabase_db_helper.fetch_meta_check_db_snapshot(client_id, account_num); "
        "changed=[]; missing_db=[]; unchanged=0; missing_text=0; ads_with_text=0; "
        "\nfor ad in ads:\n"
        "    creative=ad.get('creative') or {}\n"
        "    text=creative_utils.extract_text(creative)\n"
        "    clean=' '.join(str(text or '').split())\n"
        "    if not clean or clean == '(no caption)':\n"
        "        missing_text += 1\n"
        "        continue\n"
        "    ads_with_text += 1\n"
        "    ad_id=str(ad.get('id') or '')\n"
        "    creative_id=str(creative.get('id') or '')\n"
        "    prev=snapshot.get(ad_id)\n"
        "    if not prev:\n"
        "        missing_db.append(ad_id)\n"
        "        continue\n"
        "    prev_text=' '.join(str(prev.get('ad_text') or '').split())\n"
        "    prev_creative=str(prev.get('creative_id') or '')\n"
        "    if prev_text == clean and prev_creative == creative_id:\n"
        "        unchanged += 1\n"
        "    else:\n"
        "        changed.append(ad_id)\n"
        "print(json.dumps({"
        "'fetched_ads': len(ads), "
        "'ads_with_text': ads_with_text, "
        "'missing_text': missing_text, "
        "'unchanged': unchanged, "
        "'changed': len(changed), "
        "'missing_db': len(missing_db), "
        "'changed_ad_ids': changed[:20], "
        "'missing_db_ad_ids': missing_db[:20], "
        "'can_skip': ads_with_text > 0 and not changed and not missing_db"
        "}, ensure_ascii=False))"
    )
    env = os.environ.copy()
    env["POLICY_SKIP_ACCOUNT"] = account
    env["POLICY_SKIP_ACCOUNT_NUM"] = account_num
    env["POLICY_SKIP_CLIENT_ID"] = client_id
    result = subprocess.run(
        [str(_policy_python()), "-c", script],
        cwd=str(POLICY_DIR),
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        raise SystemExit(f"Policy smart skip preflight failed for {account}: {result.stderr.strip()}")
    try:
        return json.loads(result.stdout.strip())
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"Policy smart skip preflight returned invalid JSON for {account}: {result.stdout.strip()}"
        ) from exc


def get_hybrid_policy_plan(account: str) -> dict:
    script = (
        "import json, os; "
        "from env_loader import load_project_env; load_project_env(); "
        "import creative_utils, meta_api; "
        "account=os.environ['HYBRID_PREFLIGHT_ACCOUNT']; "
        "ads=meta_api.get_active_ads_with_creatives(account_id=account); "
        "texts=[]; missing=0; "
        "\nfor ad in ads:\n"
        "    creative=ad.get('creative') or {}\n"
        "    text=creative_utils.extract_text(creative)\n"
        "    clean=' '.join(str(text or '').split())\n"
        "    if clean and clean != '(no caption)':\n"
        "        texts.append(clean)\n"
        "    else:\n"
        "        missing += 1\n"
        "print(json.dumps({"
        "'fetched_ads': len(ads), "
        "'ads_with_text': len(texts), "
        "'ads_missing_text': missing, "
        "'unique_text_groups': len(set(texts))"
        "}, ensure_ascii=False))"
    )
    env = os.environ.copy()
    env["HYBRID_PREFLIGHT_ACCOUNT"] = account
    result = subprocess.run(
        [str(_policy_python()), "-c", script],
        cwd=str(POLICY_DIR),
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        raise SystemExit(f"Hybrid policy preflight failed for {account}: {result.stderr.strip()}")
    try:
        return json.loads(result.stdout.strip())
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"Hybrid policy preflight returned invalid JSON for {account}: {result.stdout.strip()}"
        ) from exc


def run_placement(account: str, account_output_dir: Path, *, new_ad_ids: list[str] | None = None) -> None:
    env = os.environ.copy()
    env["META_AD_ACCOUNT_ID"] = account
    env["ACTIVE_CLIENTS_CSV_URL"] = ""
    env["SPEND_DATE_PRESET"] = ""
    env["OUTPUT_DIR"] = str(account_output_dir)
    env.setdefault("AD_LIMIT", "all")
    env.setdefault("MIN_SPEND", "0")
    if new_ad_ids:
        env["NEW_AD_IDS"] = ",".join(new_ad_ids)
    run_command(["node", "src/index.js", "--json-summary"], cwd=PROJECT_ROOT, env=env)


def run_unified(
    account: str,
    placement_report: Path,
    unified_report: Path,
    *,
    source: str = "",
    new_ad_ids: list[str] | None = None,
) -> None:
    if not placement_report.exists():
        print(f"  Placement report missing; building policy-only unified report: {placement_report}")
        placement_report.parent.mkdir(parents=True, exist_ok=True)
        placement_report.write_text(
            json.dumps(
                {
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                    "results": [],
                    "accountAlerts": [],
                    "stats": {
                        "totalAds": 0,
                        "totalChecks": 0,
                        "placementsPerAd": 0,
                    },
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    assert_placement_report_account(placement_report, account)
    command = [
        "node",
        "src/build-unified-compliance-alert.js",
        "--report",
        str(placement_report),
        "--account",
        account,
        "--out",
        str(unified_report),
    ]
    if source:
        command.extend(["--source", source])
    if new_ad_ids:
        command.extend(["--new-ad-ids", ",".join(new_ad_ids)])
    run_command(command, cwd=PROJECT_ROOT)


def parse_csv_values(value: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in str(value or "").split(","):
        clean = item.strip()
        if clean and clean not in seen:
            seen.add(clean)
            out.append(clean)
    return out


def mark_status_events_processed(
    account_num: str,
    *,
    new_ad_ids: list[str],
    event_ids: list[str],
    batch_id: str,
    source: str,
) -> None:
    if not event_ids and not new_ad_ids:
        print("  Skipping meta_ad_status_events processed marker (no event IDs or new ad IDs).")
        return
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY") or ""
    if not supabase_url or not supabase_key:
        print("  Skipping meta_ad_status_events processed marker (missing Supabase env).")
        return

    query = urllib.parse.urlencode(
        {
            "ad_account_id": f"eq.{account_num}",
            "processed_at": "is.null",
        }
    )
    if event_ids:
        quoted = ",".join(event_ids)
        query += "&" + urllib.parse.urlencode({"id": f"in.({quoted})"})
    elif new_ad_ids:
        quoted = ",".join(new_ad_ids)
        query += "&" + urllib.parse.urlencode({"ad_object_id": f"in.({quoted})"})

    url = f"{supabase_url}/rest/v1/meta_ad_status_events?{query}"
    payload = {
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "batch_id": batch_id,
        "process_error": None,
    }

    try:
        rows = patch_supabase_rows(url, supabase_key, payload)
        print(f"  Marked meta_ad_status_events processed rows={len(rows)}")
    except Exception as exc:
        if "batch_id" in str(exc) or "process_error" in str(exc):
            try:
                fallback_payload = {"processed_at": payload["processed_at"]}
                if "batch_id" not in str(exc):
                    fallback_payload["batch_id"] = batch_id
                rows = patch_supabase_rows(url, supabase_key, fallback_payload)
                print(f"  Marked meta_ad_status_events processed rows={len(rows)}")
                return
            except Exception as retry_exc:
                exc = retry_exc
        print(f"  WARNING: Could not mark meta_ad_status_events processed: {exc}")


def patch_supabase_rows(url: str, supabase_key: str, payload: dict) -> list:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="PATCH",
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
        return json.loads(body or "[]")


def get_supabase_rows(url: str, supabase_key: str) -> list:
    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
        return json.loads(body or "[]")


def assert_placement_report_account(placement_report: Path, account: str) -> None:
    if not placement_report.exists():
        raise SystemExit(f"Placement report not found: {placement_report}")
    try:
        report = json.loads(placement_report.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"Could not read placement report {placement_report}: {exc}") from exc

    results = report.get("results") or []
    report_accounts = {
        normalize_account(result.get("account", {}).get("id", ""))
        for result in results
        if result.get("account", {}).get("id")
    }
    if not report_accounts:
        return
    if account not in report_accounts:
        accounts = ", ".join(sorted(report_accounts))
        raise SystemExit(
            "Placement report account mismatch: "
            f"requested {account}, but report contains {accounts}. "
            "Pass the correct --placement-report for this account."
        )


def run_slack(unified_report: Path, channel: str, viewer_url: str) -> dict:
    if not viewer_url:
        raise SystemExit("Missing --viewer-url or REPORT_VIEWER_URL for Slack send.")
    return run_command_json(
        [
            "node",
            "src/send-report-viewer-to-slack.js",
            "--json",
            str(unified_report),
            "--channel",
            channel,
            "--viewer-url",
            viewer_url,
        ],
        cwd=PROJECT_ROOT,
    )


def run_slack_index(unified_report: Path, channel: str, viewer_url: str) -> dict:
    if not viewer_url:
        raise SystemExit("Missing --viewer-url or REPORT_VIEWER_URL for report index.")
    return run_command_json(
        [
            "node",
            "src/send-report-viewer-to-slack.js",
            "--json",
            str(unified_report),
            "--channel",
            channel,
            "--viewer-url",
            viewer_url,
            "--index-only",
        ],
        cwd=PROJECT_ROOT,
    )


def run_command(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    printable = " ".join(command)
    print(f"\n$ ({cwd.relative_to(PROJECT_ROOT) if cwd != PROJECT_ROOT else '.'}) {printable}")
    completed = subprocess.run(command, cwd=str(cwd), env=env, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def run_command_json(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> dict:
    printable = " ".join(command)
    print(f"\n$ ({cwd.relative_to(PROJECT_ROOT) if cwd != PROJECT_ROOT else '.'}) {printable}")
    completed = subprocess.run(
        command,
        cwd=str(cwd),
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.stdout:
        print(completed.stdout, end="" if completed.stdout.endswith("\n") else "\n")
    if completed.stderr:
        print(completed.stderr, end="" if completed.stderr.endswith("\n") else "\n")
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)
    try:
        return json.loads(completed.stdout.strip() or "{}")
    except json.JSONDecodeError:
        return {}


if __name__ == "__main__":
    raise SystemExit(main())
