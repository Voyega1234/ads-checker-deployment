"""
Policy check: data gathering, download image, Gemini (policy_checker prompt), report.
Parses Gemini output for verdict, matches, fix_notes, revised_caption; includes lists in report.
"""
import json
import os
from pathlib import Path

import creative_utils
import policy_rule_checker
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
    Filter ACTIVE ads; for each: extract text, download image if present,
    call Gemini with policy_checker prompt; build report with raw assessment text.
    """
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    active_ads = [(ad, creative) for ad, creative in ads_data if (ad.get("status") or "").strip().upper() == "ACTIVE"]
    creative_utils.print_log(f"Policy check started for client {client_name}, accounts {account_ids}, {len(active_ads)} ACTIVE ads")

    thread_replies: list[str] = []
    action_index = 0
    for idx, (ad, creative) in enumerate(active_ads, start=1):
        ad_id = ad.get("id", "")
        ad_name = ad.get("name", "")
        creative_utils.print_log(f"Processing ad {idx}/{len(active_ads)} id={ad_id} name={ad_name[:40]}")

        text = creative_utils.extract_text(creative)
        image_url = creative_utils.get_image_url(creative)
        image_path = None
        if image_url:
            image_path = creative_utils.download_image(
                image_url, TEMP_IMAGES_DIR, prefix="policy"
            )

        try:
            parsed = policy_rule_checker.run_policy_caption_check(text)
        except Exception as e:
            action_index += 1
            reply = report_parsing.format_policy_thread_reply(
                ad_id, ad_name, {}, str(e), index=action_index
            )
            thread_replies.append(reply)
            continue

        normalized = report_parsing.normalize_policy_v2_result(parsed, text)
        if report_parsing.needs_policy_action(normalized):
            action_index += 1
            reply = report_parsing.format_policy_thread_reply(
                ad_id, ad_name, normalized, None, index=action_index
            )
            thread_replies.append(reply)

    accounts_str = ", ".join(f"`{aid}`" for aid in account_ids)
    if not thread_replies:
        initial = f"✅ _Policy Check: No action required_\nClient: {client_name}\nAccount: `{accounts_str}`"
    else:
        initial = f"🚨 _Policy Check: Action Required_\nClient: {client_name}\nAccount: `{accounts_str}`"
    report = {
        "client_name": client_name,
        "account_ids": account_ids,
        "initial": initial,
        "thread_replies": thread_replies,
    }

    safe_name = _safe_filename(client_name)
    report_path = REPORTS_DIR / f"{safe_name}_policy_report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    creative_utils.print_log(f"Report saved to {report_path}")
    return report
