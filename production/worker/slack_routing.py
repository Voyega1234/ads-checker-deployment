from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SlackRoute:
    account: str
    account_name: str
    client_id: str
    channel_id: str
    channel_name: str
    source: str


def normalize_account(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return raw if raw.startswith("act_") else f"act_{raw}"


def resolve_slack_route(
    account: str,
    *,
    policy_python: Path,
    policy_dir: Path,
    fallback_channel: str = "",
) -> SlackRoute:
    wanted = normalize_account(account).lower()
    routes = resolve_slack_routes(
        policy_python=policy_python,
        policy_dir=policy_dir,
        fallback_channel=fallback_channel,
    )
    for route in routes:
        if route.account.lower() == wanted:
            return route
    fallback = str(fallback_channel or "").strip()
    return SlackRoute(
        account=normalize_account(account),
        account_name="",
        client_id="",
        channel_id=fallback,
        channel_name=fallback,
        source="fallback" if fallback else "missing",
    )


def resolve_slack_routes(
    *,
    policy_python: Path,
    policy_dir: Path,
    fallback_channel: str = "",
) -> list[SlackRoute]:
    script = """
from env_loader import load_project_env
load_project_env()
import json
import main as main_module
import supabase_db_helper
from google.oauth2.service_account import Credentials
import gspread

def normalize_header(value):
    return " ".join(str(value or "").strip().lower().split())

def build_client_map(rows):
    if not rows:
        return {}
    headers = [normalize_header(item) for item in rows[0]]

    def index_of(*names):
        wanted = {normalize_header(name) for name in names}
        for index, header in enumerate(headers):
            if header in wanted:
                return index
        return -1

    client_idx = index_of("Client ID")
    channel_idx = index_of("Slack Channel ID")
    channel_name_idx = index_of("Slack Channel Name")
    if client_idx < 0:
        raise RuntimeError("Client sheet is missing Client ID column")
    if channel_idx < 0:
        raise RuntimeError("Client sheet is missing Slack Channel ID column")

    out = {}
    for row in rows[1:]:
        client_id = str(row[client_idx]).strip() if len(row) > client_idx else ""
        if not client_id:
            continue
        channel_id = str(row[channel_idx]).strip() if len(row) > channel_idx else ""
        channel_name = (
            str(row[channel_name_idx]).strip()
            if channel_name_idx >= 0 and len(row) > channel_name_idx
            else ""
        )
        out[client_id] = {
            "slack_channel_id": channel_id,
            "slack_channel_name": channel_name,
        }
    return out

fallback = __FALLBACK__
creds = Credentials.from_service_account_file(
    "ai-sheet-manager-service-account.json",
    scopes=main_module.SCOPES_READWRITE,
)
sheet = gspread.authorize(creds).open_by_key(main_module.SHEET_ID_META_ADS_CHECKER_SETUP)
rows = sheet.worksheet(main_module.SHEET_TAB_CLIENT).get_all_values()
client_map = build_client_map(rows)
accounts = supabase_db_helper.list_active_ad_accounts()
routes = []
for account in accounts:
    client_id = (account.get("client_id") or "").strip()
    routing = client_map.get(client_id) or {}
    channel_id = (routing.get("slack_channel_id") or "").strip()
    channel_name = (routing.get("slack_channel_name") or "").strip()
    source = "client_sheet"
    if not channel_id and fallback:
        channel_id = fallback
        channel_name = fallback
        source = "fallback"
    elif not channel_id:
        source = "missing"
    routes.append({
        "account": account.get("ad_account_act_id") or "",
        "account_name": account.get("account_name") or "",
        "client_id": client_id,
        "channel_id": channel_id,
        "channel_name": channel_name,
        "source": source,
    })
print(json.dumps(routes))
""".replace("__FALLBACK__", repr(str(fallback_channel or "").strip()))
    result = subprocess.run(
        [str(policy_python), "-c", script],
        cwd=str(policy_dir),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Could not resolve Slack routing: {result.stderr.strip()}")
    try:
        rows = json.loads(result.stdout.strip())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Could not parse Slack routing response: {result.stdout.strip()}") from exc
    return [
        SlackRoute(
            account=str(row.get("account") or ""),
            account_name=str(row.get("account_name") or ""),
            client_id=str(row.get("client_id") or ""),
            channel_id=str(row.get("channel_id") or ""),
            channel_name=str(row.get("channel_name") or ""),
            source=str(row.get("source") or ""),
        )
        for row in rows
    ]
