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
from pathlib import Path

from slack_routing import resolve_slack_route, resolve_slack_routes


PROJECT_ROOT = Path(__file__).resolve().parents[2]
POLICY_DIR = PROJECT_ROOT / "v2.0_run-all-ad-acc"
OUTPUT_DIR = PROJECT_ROOT / os.environ.get("OUTPUT_DIR", "output")
DEFAULT_REPORT_VIEWER_URL = "https://report-viewer-theta.vercel.app/report-viewer"


def main() -> int:
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

    for i, acc in enumerate(accounts, 1):
        account_id = acc["ad_account_act_id"]
        account_name = acc.get("account_name") or account_id
        print(f"\n[{i}/{len(accounts)}] {account_name} ({account_id})")
        try:
            run_single_account(account_id, args)
        except SystemExit as exc:
            msg = str(exc)
            print(f"  ERROR: {msg}")
            errors.append((account_id, msg))
        except Exception as exc:
            print(f"  ERROR: {exc}")
            errors.append((account_id, str(exc)))

        if i < len(accounts) and args.account_delay > 0:
            print(f"  Waiting {args.account_delay}s before next account...")
            time.sleep(args.account_delay)

    print(f"\n{'─' * 50}")
    print(f"Done: {len(accounts) - len(errors)}/{len(accounts)} accounts succeeded")
    if errors:
        print(f"\nFailed accounts ({len(errors)}):")
        for account_id, msg in errors:
            print(f"  {account_id}: {msg}")
        return 1
    return 0


def run_single_account(account_raw: str, args: argparse.Namespace) -> int:
    account = normalize_account(account_raw)
    account_num = account.replace("act_", "")
    slack_route = None
    if args.mode in {"policy", "slack", "full"}:
        slack_route = resolve_slack_route(
            account,
            policy_python=_policy_python(),
            policy_dir=POLICY_DIR,
            fallback_channel=args.channel,
        )

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
        run_policy(account, channel=slack_route.channel_id if slack_route else args.channel)

    if args.mode in {"placement", "full"}:
        run_placement(account, account_output_dir)

    if args.mode in {"unified", "full"}:
        run_unified(account, placement_report, unified_report)

    if args.mode == "slack" or (args.mode == "full" and not args.skip_slack):
        if slack_route.channel_id:
            print(format_slack_route(slack_route))
            run_slack(unified_report, slack_route.channel_id, args.viewer_url)
        else:
            print("  Skipping Slack (no Client sheet Slack Channel ID, --channel, or SLACK_OVERRIDE_CHANNEL_ID set)")

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


def run_placement(account: str, account_output_dir: Path) -> None:
    env = os.environ.copy()
    env["META_AD_ACCOUNT_ID"] = account
    env["ACTIVE_CLIENTS_CSV_URL"] = ""
    env["SPEND_DATE_PRESET"] = ""
    env["OUTPUT_DIR"] = str(account_output_dir)
    env.setdefault("AD_LIMIT", "all")
    env.setdefault("MIN_SPEND", "0")
    run_command(["node", "src/index.js", "--json"], cwd=PROJECT_ROOT, env=env)


def run_unified(account: str, placement_report: Path, unified_report: Path) -> None:
    assert_placement_report_account(placement_report, account)
    run_command(
        [
            "node",
            "src/build-unified-compliance-alert.js",
            "--report",
            str(placement_report),
            "--account",
            account,
            "--out",
            str(unified_report),
        ],
        cwd=PROJECT_ROOT,
    )


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


def run_slack(unified_report: Path, channel: str, viewer_url: str) -> None:
    if not viewer_url:
        raise SystemExit("Missing --viewer-url or REPORT_VIEWER_URL for Slack send.")
    run_command(
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


def run_command(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    printable = " ".join(command)
    print(f"\n$ ({cwd.relative_to(PROJECT_ROOT) if cwd != PROJECT_ROOT else '.'}) {printable}")
    completed = subprocess.run(command, cwd=str(cwd), env=env, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
