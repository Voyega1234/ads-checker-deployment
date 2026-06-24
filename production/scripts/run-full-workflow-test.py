#!/usr/bin/env python3
"""
Run a bounded full-workflow ad compliance test.

This wrapper selects up to N active ad accounts that have Slack routing in the
client sheet, then invokes the production worker with an explicit Slack channel
override. It is intended for manual QA/test sends, not scheduled production.

Examples:
  python production/scripts/run-full-workflow-test.py
  python production/scripts/run-full-workflow-test.py --count 10 --channel C08EA0XE2UU
  python production/scripts/run-full-workflow-test.py --accounts act_123,act_456 --channel C0B1ZT7S1HV
  python production/scripts/run-full-workflow-test.py --dry-run
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = PROJECT_ROOT / "production" / "worker"

sys.path.insert(0, str(WORKER_DIR))

import main as worker_main  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run full workflow test for selected ad accounts.")
    parser.add_argument("--count", type=int, default=10, help="Max account count for auto-selection (default: 10).")
    parser.add_argument(
        "--channel",
        default="C08EA0XE2UU",
        help="Slack channel ID override for test sends (default: C08EA0XE2UU).",
    )
    parser.add_argument(
        "--accounts",
        default="",
        help=(
            "Comma-separated account IDs to run. If omitted, picks the first --count "
            "active routed accounts matching --min-ads/--max-ads."
        ),
    )
    parser.add_argument("--min-ads", type=int, default=2, help="Minimum active ads for auto-selection (default: 2).")
    parser.add_argument("--max-ads", type=int, default=50, help="Maximum active ads for auto-selection (default: 50).")
    parser.add_argument("--account-delay", type=int, default=5, help="Seconds between accounts (default: 5).")
    parser.add_argument(
        "--policy-runner",
        choices=["legacy", "batch", "hybrid"],
        default="batch",
        help=(
            "Policy runner to pass to worker. Default is batch so test runs can "
            "force fresh policy checks."
        ),
    )
    parser.add_argument("--hybrid-batch-min-ads", type=int, default=40)
    parser.add_argument("--hybrid-batch-min-text-groups", type=int, default=20)
    parser.add_argument("--batch-poll-interval", type=int, default=60)
    parser.add_argument("--batch-timeout", type=int, default=7200)
    parser.add_argument("--catalog-max-cards", type=int, default=10)
    parser.add_argument(
        "--viewer-url",
        default=worker_main.DEFAULT_REPORT_VIEWER_URL,
        help="Report viewer URL passed to worker.",
    )
    parser.add_argument(
        "--respect-recent-slack-skip",
        action="store_true",
        help="Keep the 24h recent Slack skip guard. Default test mode disables it.",
    )
    parser.add_argument(
        "--reuse-policy",
        action="store_true",
        help="Allow existing policy results to be reused. Default forces policy recheck.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print selected accounts and worker command only.")
    return parser.parse_args()


def select_accounts(args: argparse.Namespace) -> list[str]:
    if args.accounts:
        return [
            worker_main.normalize_account(item)
            for item in str(args.accounts).split(",")
            if item.strip()
        ]

    active_accounts = worker_main.load_active_accounts()
    routed_accounts = worker_main.filter_accounts_with_sheet_slack(active_accounts)
    selected: list[str] = []
    min_ads = max(0, int(args.min_ads))
    max_ads = max(min_ads, int(args.max_ads))

    print(f"Selecting up to {args.count} routed account(s) with active ads in range {min_ads}-{max_ads}...", flush=True)

    for account_row in routed_accounts:
        account = str(account_row.get("ad_account_act_id") or "")
        if not account:
            continue

        try:
            plan = worker_main.get_hybrid_policy_plan(account)
            fetched_ads = int(plan.get("fetched_ads") or 0)
        except (Exception, SystemExit) as exc:  # Account probes should not abort the whole test selection.
            print(f"  skip {account}: ad count probe failed: {exc}")
            continue

        if fetched_ads < min_ads:
            print(f"  skip {account}: active_ads={fetched_ads} < {min_ads}")
            continue
        if fetched_ads > max_ads:
            print(f"  skip {account}: active_ads={fetched_ads} > {max_ads}")
            continue

        print(f"  select {account}: active_ads={fetched_ads}")
        selected.append(account)
        if len(selected) >= max(0, int(args.count)):
            break

    return selected


def build_worker_command(accounts: list[str], args: argparse.Namespace) -> list[str]:
    if not accounts:
        raise SystemExit("No accounts selected.")

    command = [
        sys.executable,
        "production/worker/main.py",
        "--mode",
        "full",
        "--accounts",
        ",".join(accounts),
        "--channel",
        args.channel,
        "--slack-format",
        "catalog",
        "--catalog-max-cards",
        str(max(1, int(args.catalog_max_cards))),
        "--viewer-url",
        args.viewer_url,
        "--policy-runner",
        args.policy_runner,
        "--hybrid-batch-min-ads",
        str(max(1, int(args.hybrid_batch_min_ads))),
        "--hybrid-batch-min-text-groups",
        str(max(1, int(args.hybrid_batch_min_text_groups))),
        "--batch-poll-interval",
        str(max(1, int(args.batch_poll_interval))),
        "--batch-timeout",
        str(max(1, int(args.batch_timeout))),
        "--account-delay",
        str(max(0, int(args.account_delay))),
        "--source",
        "manual-test",
    ]

    if not args.respect_recent_slack_skip:
        command.append("--disable-recent-slack-skip")

    if not args.reuse_policy:
        command.append("--batch-force-recheck")

    return command


def main() -> int:
    worker_main.load_project_env()
    args = parse_args()
    accounts = select_accounts(args)
    command = build_worker_command(accounts, args)

    print("Selected accounts:")
    for index, account in enumerate(accounts, 1):
        print(f"  {index}. {account}")

    print("\nWorker command:")
    print(" ".join(command))

    if args.dry_run:
        return 0

    completed = subprocess.run(command, cwd=str(PROJECT_ROOT), check=False)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
