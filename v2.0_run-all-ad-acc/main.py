import os
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials

import creative_utils
from env_loader import load_project_env
import meta_api
import supabase_db_helper
import verification_flow

load_project_env()

from check_policy import run as run_check_policy
from check_policy_and_spell import run as run_check_policy_and_spell
from check_spell import run as run_check_spell

SHEET_ID_META_ADS_CHECKER_SETUP = "1xSlmGR29tGUd5oBq6puBS2YAzt0BhG5yfHdV4H1wlYg"
SHEET_TAB_CLIENT = "Client"
SHEET_TAB_PROMPT = "Prompt"

CLIENT_SHEET_HEADERS = [
    "No",
    "Client ID",
    "Slack Channel Name",
    "Slack Channel ID",
    "PM Slack ID",
    "Ad Op 1 Slack ID",
]

SCOPES_READ = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
SCOPES_READWRITE = ["https://www.googleapis.com/auth/spreadsheets"]


def normalize_ad_account_id(value: str) -> str:
    """
    Normalize ad account IDs so both `act_123` and `123` are accepted.
    Returns `act_...` or "" if blank.
    """
    s = (value or "").strip()
    if not s:
        return ""
    return s if s.lower().startswith("act_") else f"act_{s}"


def to_ad_account_act_id(value: str) -> str:
    """Alias: Meta API ad account id as act_{numeric_id}."""
    return normalize_ad_account_id(value)


def has_ad_account_id(value) -> bool:
    return bool(normalize_ad_account_id(value))


def _cell(row: list, idx: int, default: str = "") -> str:
    if len(row) > idx:
        v = row[idx]
        if v is None:
            return default
        return str(v) if not isinstance(v, str) else v
    return default


def validate_sheet_header(rows: list[list], *, tab_name: str, expected_headers: list[str]) -> None:
    if not rows or len(rows) < 1:
        raise RuntimeError(f'Sheet "{tab_name}" is empty; expected header row: {expected_headers}')
    header = [str(x).strip() for x in (rows[0] or [])]
    need = expected_headers
    if header[: len(need)] != need:
        raise RuntimeError(
            f'Sheet "{tab_name}" header mismatch.\n'
            f"Expected: {need}\n"
            f"Got:      {header[:len(need)]}"
        )


def load_client_map(rows: list[list]) -> dict[str, dict[str, str]]:
    """
    Build Slack routing map from `Client` sheet rows (A:F, first row header).
    """
    if not rows or len(rows) < 2:
        return {}
    validate_sheet_header(rows, tab_name=SHEET_TAB_CLIENT, expected_headers=CLIENT_SHEET_HEADERS)
    data_rows = rows[1:]
    out: dict[str, dict[str, str]] = {}
    for i, row in enumerate(data_rows):
        client_id = _cell(row, 1).strip()
        slack_name = _cell(row, 2).strip()
        slack_id = _cell(row, 3).strip()
        pm_slack_id = _cell(row, 4).strip()
        ad_op_slack_id = _cell(row, 5).strip()
        if not client_id:
            continue
        out[client_id] = {
            "slack_channel_id": slack_id,
            "slack_channel_name": slack_name,
            "pm_slack_id": pm_slack_id,
            "ad_op_slack_id": ad_op_slack_id,
            "row_index": str(i + 2),
        }
    return out


def run_for_client(client_id: str, account_ids: list[str], fda_true: bool, spell_true: bool) -> dict | None:
    """
    Run batch policy/spell assessment for one client (fetch ads, then check module run).
    For full Meta check DB sync + Slack, use worker or verification_flow.run_client_verification.
    """
    ads_data = list(_fetch_ads_data(account_ids))
    debug_mode = os.environ.get("META_ADS_DEBUG", "").strip().upper() in ("1", "TRUE", "YES")
    if debug_mode and len(ads_data) > 3:
        total = len(ads_data)
        ads_data = ads_data[:3]
        creative_utils.print_log(f"Debug mode: limited to first 3 of {total} ads for {client_id}")
    creative_utils.print_log(f"Fetched {len(ads_data)} ads for client {client_id}")
    if fda_true and spell_true:
        return run_check_policy_and_spell(client_id, account_ids, ads_data)
    if fda_true:
        return run_check_policy(client_id, account_ids, ads_data)
    if spell_true:
        return run_check_spell(client_id, account_ids, ads_data)
    return None


def map_ad_row_to_fields(client_id: str, ad_account_id: str, ad: dict) -> dict:
    """
    Map one ad (with embedded creative) to column-style fields. ad_account_id is Meta act_... form.
    """
    act = ad_account_id if ad_account_id.startswith("act_") else f"act_{ad_account_id}"
    creative = ad.get("creative") or {}
    return {
        "client_id": client_id,
        "ad_account_id": act,
        "ad_id": ad.get("id") or "",
        "creative_id": creative.get("id") or "",
        "ad_text": creative_utils.extract_text(creative),
        "ad_link": ((creative.get("object_story_spec") or {}).get("link_data") or {}).get("link") or "",
        "created_at": ad.get("created_time") or "",
        "updated_at": ad.get("updated_time") or "",
    }


def _fetch_ads_data(account_ids: list[str]):
    """Fetch active ads with embedded creatives (one paginated query per account)."""
    token = os.environ.get("META_ACCESS_TOKEN")
    if not token:
        raise ValueError("META_ACCESS_TOKEN environment variable is required for Meta API")
    for account_id in account_ids:
        creative_utils.print_log(f"Fetching account {account_id}")
        try:
            ads = meta_api.get_active_ads_with_creatives(access_token=token, account_id=account_id)
            for ad in ads:
                ad.setdefault("status", ad.get("effective_status"))
                creative_detail = ad.get("creative") or {}
                if not creative_detail.get("id"):
                    continue
                yield ad, creative_detail
        except Exception as e:
            creative_utils.logger.warning("Error fetching account %s: %s", account_id, e)
            raise


def main():
    log_file = Path(__file__).resolve().parent / "temp" / "ads_check.log"
    creative_utils.configure_logging(log_file=str(log_file))
    creative_utils.print_log("Starting Meta Ads Checker (Supabase queue + Client sheet)")

    creds = Credentials.from_service_account_file(
        "ai-sheet-manager-service-account.json", scopes=SCOPES_READ
    )
    gclient = gspread.authorize(creds)
    sheet = gclient.open_by_key(SHEET_ID_META_ADS_CHECKER_SETUP)
    client_ws = sheet.worksheet(SHEET_TAB_CLIENT)
    client_rows = client_ws.get("A:F")
    client_map = load_client_map(client_rows)
    active_accounts = supabase_db_helper.list_active_ad_accounts()
    creative_utils.print_log(f"Active ad accounts from Supabase: {len(active_accounts)}")

    for acc in active_accounts:
        client_id = (acc.get("client_id") or "").strip()
        ad_num = acc["ad_account_id"]
        ad_act = acc["ad_account_act_id"]
        if not client_id:
            creative_utils.print_log(f"Skip account {ad_num}: no Client in Supabase")
            continue
        routing = client_map.get(client_id) or {}
        if not routing:
            creative_utils.logger.error("Client ID not in Client sheet: %s", client_id)
            continue
        slack_id = (routing.get("slack_channel_id") or "").strip()
        if not slack_id:
            creative_utils.logger.error("No Slack channel for client: %s", client_id)
            continue
        creative_utils.print_log(f"Run client {client_id} account {ad_act}")
        try:
            verification_flow.run_client_verification(
                client_id=client_id,
                ad_account_id_num=ad_num,
                account_ids=[ad_act],
                fda_true=True,
                spell_true=True,
                slack_channel_id=slack_id,
                pm_slack_id=(routing.get("pm_slack_id") or "").strip(),
                ad_op_slack_id=(routing.get("ad_op_slack_id") or "").strip(),
            )
        except Exception as e:
            creative_utils.logger.exception(
                "Error verification client %s account %s: %s", client_id, ad_act, e
            )


if __name__ == "__main__":
    main()
