"""
Polling worker: every 15 min, load active ad accounts from Supabase, Client tab for Slack routing,
run Meta ad check (policy + spell) and persist to meta_ad_check_db.

Usage:
  conda activate trying_new_tools
  python worker.py              Run the worker loop (poll every 15 min).
  python worker.py --once     Run one verification cycle, then exit.
  python worker.py --once act_123   Run one cycle for that ad account only (must be Active in Supabase).
  python worker.py --once 123        Same; numeric id is accepted.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials
from gspread.exceptions import APIError

import creative_utils
from env_loader import load_project_env
import main as main_module
import supabase_db_helper
import verification_flow

load_project_env()

SHEET_ID = main_module.SHEET_ID_META_ADS_CHECKER_SETUP
SCOPES_READWRITE = main_module.SCOPES_READWRITE
POLL_INTERVAL_SEC = 900
GSHEETS_READ_DELAY_SEC = float(os.environ.get("GSHEETS_READ_DELAY_SEC", "0.20"))


def _get_spreadsheet():
    creds = Credentials.from_service_account_file(
        "ai-sheet-manager-service-account.json", scopes=SCOPES_READWRITE
    )
    client = gspread.authorize(creds)
    return client.open_by_key(SHEET_ID)


def _throttled_sheet_call(fn, *, is_write: bool = False):
    """Read throttling for Client tab only (writes disabled here)."""
    try:
        result = fn()
        delay = GSHEETS_READ_DELAY_SEC if not is_write else 0
        if delay > 0:
            time.sleep(delay)
        return result
    except APIError as e:
        creative_utils.logger.exception("Google Sheets APIError: %s", e)
        raise


def _has_any_history_payload(history_payload: dict) -> bool:
    return bool((history_payload.get("text_check_initial") or "").strip())


def run_once(
    spreadsheet, act_id_filter: str | None = None
) -> tuple[int, bool]:
    """
    For each row in meta_adaccounts (Status=Active), run verification for that client + account.
    If act_id_filter is set, only that ad account (must still be Active in Supabase).
    Returns (number of jobs processed, filter_no_match) where filter_no_match is True when
    act_id_filter was set but no active row matched.
    """
    try:
        client_ws = spreadsheet.worksheet(main_module.SHEET_TAB_CLIENT)
    except Exception as e:
        raise RuntimeError(
            f'Missing required worksheet: "{main_module.SHEET_TAB_CLIENT}" (Client tab for Slack routing)'
        ) from e

    client_rows = _throttled_sheet_call(lambda: client_ws.get("A:F"), is_write=False)
    client_map = main_module.load_client_map(client_rows)

    try:
        active_accounts = supabase_db_helper.list_active_ad_accounts()
    except Exception as e:
        creative_utils.logger.exception("Supabase list_active_ad_accounts failed: %s", e)
        return 0, False

    if not active_accounts:
        return 0, False

    if act_id_filter is not None and str(act_id_filter).strip() != "":
        want = main_module.normalize_ad_account_id(str(act_id_filter).strip())
        if not want:
            creative_utils.logger.error("Invalid or empty ad account id after normalization")
            return 0, True
        active_accounts = [
            a
            for a in active_accounts
            if (a.get("ad_account_act_id") or "").lower() == want.lower()
        ]
        if not active_accounts:
            creative_utils.logger.error(
                "No active meta_adaccounts row matched ad account id %s (check Status=Active and id).",
                want,
            )
            return 0, True
        creative_utils.print_log(
            f"Filtered to single ad account: {active_accounts[0].get('ad_account_act_id')}"
        )

    processed = 0
    for acc in active_accounts:
        client_id = (acc.get("client_id") or "").strip()
        ad_account_id_num = acc["ad_account_id"]
        ad_account_act_id = acc["ad_account_act_id"]
        if not client_id:
            creative_utils.logger.error(
                "Skip ad account: empty Client in meta_adaccounts for Account ID=%s",
                ad_account_id_num,
            )
            continue

        routing = client_map.get(client_id) or {}
        slack_channel_id = (routing.get("slack_channel_id") or "").strip()
        pm_slack_id = (routing.get("pm_slack_id") or "").strip()
        ad_op_slack_id = (routing.get("ad_op_slack_id") or "").strip()

        if not routing:
            creative_utils.logger.error(
                "Client ID not found in Client sheet (Slack); skip client_id=%s account act=%s",
                client_id,
                ad_account_act_id,
            )
            continue

        if not slack_channel_id:
            fallback = os.environ.get("SLACK_OVERRIDE_CHANNEL_ID", "").strip()
            if fallback:
                creative_utils.logger.warning(
                    "Missing Slack Channel ID in Client sheet; using fallback SLACK_OVERRIDE_CHANNEL_ID for client_id=%s",
                    client_id,
                )
                slack_channel_id = fallback
            else:
                creative_utils.logger.error(
                    "Missing Slack Channel ID in Client sheet; skip client_id=%s",
                    client_id,
                )
                continue

        creative_utils.print_log(
            f"Verification: client {client_id}, account {ad_account_act_id} (id={ad_account_id_num})"
        )
        try:
            result = verification_flow.run_client_verification(
                client_id=client_id,
                ad_account_id_num=ad_account_id_num,
                account_ids=[ad_account_act_id],
                fda_true=True,
                spell_true=True,
                slack_channel_id=slack_channel_id,
                pm_slack_id=pm_slack_id,
                ad_op_slack_id=ad_op_slack_id,
            )
            history_payload = result.get("history_payload") or {}
            if _has_any_history_payload(history_payload):
                creative_utils.print_log(
                    f"run_complete client_id={client_id} ad_account={ad_account_act_id} "
                    f"text_reports={result.get('text_reports', 0)}"
                )
            else:
                creative_utils.print_log(
                    f"run_complete client_id={client_id} ad_account={ad_account_act_id} no_text_slack"
                )
            processed += 1
        except Exception as e:
            creative_utils.logger.exception(
                "Verification failed for client %s account %s: %s",
                client_id,
                ad_account_act_id,
                e,
            )
            continue
        creative_utils.print_log(
            f"Finished verification for client {client_id} account {ad_account_act_id}"
        )
    return processed, False


def main():
    parser = argparse.ArgumentParser(
        description="Meta ad check worker: Supabase queue + Client sheet, poll every 15 min."
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one full cycle, then exit. With optional act_id, only that account.",
    )
    parser.add_argument(
        "act_id",
        nargs="?",
        default=None,
        help="Meta ad account id (act_... or numeric). Use with --once only; one account per run.",
    )
    args = parser.parse_args()

    if args.act_id is not None and not args.once:
        creative_utils.print_log(
            "Error: ad account act_id requires --once (single run). "
            "Example: python worker.py --once act_1234567890"
        )
        sys.exit(2)

    log_file = Path(__file__).resolve().parent / "temp" / "ads_check_worker.log"
    creative_utils.configure_logging(log_file=str(log_file))

    spreadsheet = _get_spreadsheet()

    if args.once:
        creative_utils.print_log("--once: single verification cycle")
        n, no_match = run_once(spreadsheet, act_id_filter=args.act_id)
        creative_utils.print_log(f"Done (processed={n})")
        if no_match:
            sys.exit(1)
        sys.exit(0 if n >= 0 else 1)

    creative_utils.print_log(
        f"Worker started: polling every {POLL_INTERVAL_SEC} sec (Supabase + Client sheet)"
    )
    while True:
        try:
            n, _ = run_once(spreadsheet, act_id_filter=None)
            if n > 0:
                creative_utils.print_log("Completed one verification cycle")
        except Exception as e:
            creative_utils.logger.exception("Worker cycle error: %s", e)
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
