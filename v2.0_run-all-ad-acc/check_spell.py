"""
Spell check: data gathering, download image, Gemini (spell_checker prompt), report.
Parses Gemini output to match spell_checker format (new: error_summary, errors, corrected_caption).
"""
import json
import os
from pathlib import Path

import creative_utils
import gemini_utils
import prompt_utils
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
    call Gemini with spell_checker prompt; build report with raw assessment text.
    """
    prompt_content = prompt_utils.get_prompt_by_name("spell_checker")
    if not prompt_content:
        raise ValueError("Prompt 'spell_checker' not found (check Sheet tab 'Prompt' or fallback)")

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    active_ads = [(ad, creative) for ad, creative in ads_data if (ad.get("status") or "").strip().upper() == "ACTIVE"]
    creative_utils.print_log(f"Spell check started for client {client_name}, accounts {account_ids}, {len(active_ads)} ACTIVE ads")

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
                image_url, TEMP_IMAGES_DIR, prefix="spell"
            )

        result = gemini_utils.run_assessment(
            prompt_content, text, image_path
        )
        if isinstance(result, dict) and "_error" in result:
            action_index += 1
            reply = report_parsing.format_spell_thread_reply(
                ad_id, ad_name, {}, result["_error"], index=action_index
            )
            thread_replies.append(reply)
        else:
            parsed = report_parsing.parse_gemini_json(str(result or ""))
            if parsed is None:
                action_index += 1
                reply = report_parsing.format_spell_thread_reply(
                    ad_id, ad_name, {}, "no valid JSON", index=action_index
                )
                thread_replies.append(reply)
            else:
                normalized = report_parsing.normalize_spell_result(parsed, text)
                if report_parsing.needs_spell_action(normalized):
                    action_index += 1
                    reply = report_parsing.format_spell_thread_reply(
                        ad_id, ad_name, normalized, None, index=action_index, original_ad_text=text
                    )
                    thread_replies.append(reply)

    accounts_str = ", ".join(f"`{aid}`" for aid in account_ids)
    if not thread_replies:
        initial = f"✅ _Spell Check: No action required_\nClient: {client_name}\nAccount: `{accounts_str}`"
    else:
        initial = f"🚨 _Spell Check: Action Required_\nClient: {client_name}\nAccount: `{accounts_str}`"
    report = {
        "client_name": client_name,
        "account_ids": account_ids,
        "initial": initial,
        "thread_replies": thread_replies,
    }

    safe_name = _safe_filename(client_name)
    report_path = REPORTS_DIR / f"{safe_name}_spell_report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    creative_utils.print_log(f"Report saved to {report_path}")
    return report
