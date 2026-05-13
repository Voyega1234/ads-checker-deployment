"""
Load prompt content by name. Primary: Google Sheet tab "Prompt" (columns: name, prompt).
Fallback: docs/prompt.json under python_backend for debugging when sheet is unavailable.
"""
import json
from pathlib import Path

import creative_utils

PROMPTS_JSON_PATH = Path(__file__).resolve().parent / "docs" / "prompt.json"


def _get_prompt_from_sheet(name: str) -> str | None:
    """Fetch prompt content from Sheet tab 'Prompt' (columns: name, prompt)."""
    try:
        import main as main_module
        from google.oauth2.service_account import Credentials
        import gspread
    except Exception:
        return None
    try:
        creds = Credentials.from_service_account_file(
            "ai-sheet-manager-service-account.json",
            scopes=main_module.SCOPES_READ,
        )
        client = gspread.authorize(creds)
        sheet = client.open_by_key(main_module.SHEET_ID_META_ADS_CHECKER_SETUP)
        worksheet = sheet.worksheet(main_module.SHEET_TAB_PROMPT)
        records = worksheet.get_all_records()
        for record in records:
            if isinstance(record, dict) and record.get("name") == name:
                return record.get("prompt") or None
        return None
    except Exception:
        return None


def _get_prompt_from_json(name: str) -> str | None:
    """Load prompt from docs/prompt.json (debugging fallback)."""
    if not PROMPTS_JSON_PATH.exists():
        return None
    try:
        data = json.loads(PROMPTS_JSON_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    for item in data:
        if isinstance(item, dict) and item.get("name") == name:
            return item.get("content") or None
    return None


def get_prompt_by_name(name: str) -> str | None:
    """
    Return prompt content for the given name.
    Tries Sheet tab 'Prompt' first; falls back to docs/prompt.json for debugging.
    """
    content = _get_prompt_from_sheet(name)
    if content:
        creative_utils.logger.debug("Prompt '%s' loaded from Sheet tab Prompt", name)
        return content
    content = _get_prompt_from_json(name)
    if content:
        creative_utils.logger.debug("Prompt '%s' loaded from docs/prompt.json", name)
        return content
    creative_utils.logger.warning("Prompt '%s' not found", name)
    return None
