"""Policy + spell check batch wrapper."""
import json
import os
from pathlib import Path

import assessment_single_ad
import creative_utils
import report_parsing

REPORTS_DIR = Path(__file__).resolve().parent / "reports"
TEMP_IMAGES_DIR = Path(__file__).resolve().parent / "temp" / "ads_check"


def _safe_filename(name: str) -> str:
    """Replace characters that are unsafe in filenames."""
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in name)


def run(
    client_name: str,
    account_ids: list[str],
    ads_data: list[tuple[dict, dict]],
) -> dict:
    """
    ads_data: list of (ad, creative_detail) from main._fetch_ads_data.
    Run the same policy v2 + legacy spell flow used by the worker for each ad.
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY environment variable is required")

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    active_ads = [(ad, creative) for ad, creative in ads_data if (ad.get("status") or "").strip().upper() == "ACTIVE"]
    creative_utils.print_log(f"Policy+spell check started for client {client_name}, accounts {account_ids}, {len(active_ads)} ACTIVE ads")

    thread_replies: list[str] = []
    action_index = 0
    for idx, (ad, creative) in enumerate(active_ads, start=1):
        ad_id = ad.get("id", "")
        ad_name = ad.get("name", "")
        creative_utils.print_log(f"Processing ad {idx}/{len(active_ads)} id={ad_id} name={ad_name[:40]}")

        text = creative_utils.extract_text(creative)
        try:
            result = assessment_single_ad.assess_single_ad(
                client_name,
                ad_id,
                ad_name,
                creative,
                fda_true=True,
                spell_true=True,
            )
        except Exception as e:
            action_index += 1
            reply = report_parsing.format_policy_and_spell_thread_reply(
                ad_id, ad_name, {}, str(e), index=action_index
            )
            thread_replies.append(reply)
            continue

        ar = result.get("assessment_result") or {}
        normalized = ar.get("normalized") if isinstance(ar.get("normalized"), dict) else {}
        policy_has_action = report_parsing.needs_policy_action(normalized)
        spell_has_action = (normalized.get("spell_total_errors") or 0) >= 1
        if ar.get("error") or ar.get("parse_error") or policy_has_action or spell_has_action:
            action_index += 1
            reply = report_parsing.format_policy_and_spell_thread_reply(
                ad_id,
                ad_name,
                normalized,
                ar.get("error") or ar.get("parse_error"),
                index=action_index,
                original_ad_text=text,
            )
            thread_replies.append(reply)

    accounts_str = ", ".join(f"`{aid}`" for aid in account_ids)
    if not thread_replies:
        initial = f"✅ _Policy & Spell Check: No action required_\nClient: {client_name}\nAccount: `{accounts_str}`"
    else:
        initial = f"🚨 _Policy & Spell Check: Action Required_\nClient: {client_name}\nAccount: `{accounts_str}`"
    report = {
        "client_name": client_name,
        "account_ids": account_ids,
        "initial": initial,
        "thread_replies": thread_replies,
    }

    safe_name = _safe_filename(client_name)
    report_path = REPORTS_DIR / f"{safe_name}_policy_and_spell_report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    creative_utils.print_log(f"Report saved to {report_path}")
    return report
