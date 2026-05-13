"""
Single-ad Gemini assessment for Meta Check DB: same prompts and pass/fail rules as batch checkers.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import creative_utils
import gemini_utils
import policy_rule_checker
import prompt_utils
import report_parsing

TEMP_IMAGES_DIR = Path(__file__).resolve().parent / "temp" / "ads_check"


def assess_single_ad(
    client_name: str,
    ad_id: str,
    ad_name: str,
    creative: dict,
    *,
    fda_true: bool,
    spell_true: bool,
) -> dict:
    """
    Run Gemini for one ad. Returns:
      passed: bool
      assessment_result: JSON-serializable dict (raw, parsed, normalized, error if any)
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY environment variable is required")

    TEMP_IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    text = creative_utils.extract_text(creative)
    image_url = creative_utils.get_image_url(creative)
    image_path = None
    if image_url:
        image_path = creative_utils.download_image(
            image_url, TEMP_IMAGES_DIR, prefix="single"
        )

    if fda_true and spell_true:
        return _run_policy_and_spell(
            client_name, ad_id, ad_name, text, image_path, api_key
        )
    if fda_true:
        return _run_policy_only(ad_id, ad_name, text, image_path, api_key)
    if spell_true:
        return _run_spell_only(ad_id, ad_name, text, image_path, api_key)
    return {
        "passed": True,
        "assessment_result": {
            "skipped": True,
            "reason": "no FDA or Spell enabled",
            "original_caption": text,
        },
    }


def _run_policy_only(
    ad_id: str, ad_name: str, text: str, image_path: Path | None, api_key: str
) -> dict:
    _ = image_path
    try:
        parsed = policy_rule_checker.run_policy_caption_check(text, api_key=api_key)
    except Exception as e:
        return {
            "passed": False,
            "assessment_result": {
                "ad_id": ad_id,
                "ad_name": ad_name,
                "mode": "policy_only",
                "error": str(e),
                "original_caption": text,
            },
        }
    raw = json.dumps(parsed, ensure_ascii=False)
    normalized = report_parsing.normalize_policy_v2_result(parsed, text)
    passed = not report_parsing.needs_policy_action(normalized)
    return {
        "passed": passed,
        "assessment_result": {
            "ad_id": ad_id,
            "ad_name": ad_name,
            "mode": "policy_only",
            "raw_response": raw[:50000],
            "parsed": parsed,
            "normalized": normalized,
            "original_caption": text,
        },
    }


def _run_spell_only(
    ad_id: str, ad_name: str, text: str, image_path: Path | None, api_key: str
) -> dict:
    prompt_content = prompt_utils.get_prompt_by_name("spell_checker")
    if not prompt_content:
        raise ValueError("Prompt 'spell_checker' not found")
    result = gemini_utils.run_assessment(prompt_content, text, image_path, api_key)
    if isinstance(result, dict) and "_error" in result:
        return {
            "passed": False,
            "assessment_result": {
                "ad_id": ad_id,
                "ad_name": ad_name,
                "mode": "spell_only",
                "error": result["_error"],
                "original_caption": text,
            },
        }
    raw = str(result or "")
    parsed = report_parsing.parse_gemini_json(raw)
    if parsed is None:
        return {
            "passed": False,
            "assessment_result": {
                "ad_id": ad_id,
                "ad_name": ad_name,
                "mode": "spell_only",
                "raw_response": raw[:50000],
                "parse_error": "no valid JSON",
                "original_caption": text,
            },
        }
    normalized = report_parsing.normalize_spell_result(parsed, text)
    passed = not report_parsing.needs_spell_action(normalized)
    return {
        "passed": passed,
        "assessment_result": {
            "ad_id": ad_id,
            "ad_name": ad_name,
            "mode": "spell_only",
            "raw_response": raw[:50000],
            "parsed": parsed,
            "normalized": normalized,
            "original_caption": text,
        },
    }


def _run_policy_and_spell(
    client_name: str,
    ad_id: str,
    ad_name: str,
    text: str,
    image_path: Path | None,
    api_key: str,
) -> dict:
    _ = client_name
    try:
        policy_parsed = policy_rule_checker.run_policy_caption_check(text, api_key=api_key)
    except Exception as e:
        return {
            "passed": False,
            "assessment_result": {
                "ad_id": ad_id,
                "ad_name": ad_name,
                "mode": "policy_and_spell",
                "error": str(e),
                "original_caption": text,
            },
        }

    policy_normalized = report_parsing.normalize_policy_v2_result(policy_parsed, text)
    spell_result = _run_spell_only(ad_id, ad_name, text, image_path, api_key)
    spell_ar = spell_result.get("assessment_result") or {}
    if spell_ar.get("error") or spell_ar.get("parse_error"):
        return {
            "passed": False,
            "assessment_result": {
                "ad_id": ad_id,
                "ad_name": ad_name,
                "mode": "policy_and_spell",
                "raw_response": json.dumps(
                    {"policy_v2": policy_parsed, "spell": spell_ar},
                    ensure_ascii=False,
                )[:50000],
                "parsed": {"policy_v2": policy_parsed, "spell": spell_ar.get("parsed")},
                "normalized": policy_normalized,
                "error": spell_ar.get("error") or spell_ar.get("parse_error"),
                "original_caption": text,
            },
        }

    spell_normalized = spell_ar.get("normalized") if isinstance(spell_ar.get("normalized"), dict) else {}
    normalized = dict(policy_normalized)
    spell_errors = spell_normalized.get("errors") or []
    if not isinstance(spell_errors, list):
        spell_errors = []
    normalized["spell_error_level"] = spell_normalized.get("error_level") or "none"
    normalized["spell_total_errors"] = int(spell_normalized.get("total_errors") or 0)
    normalized["spell_errors"] = spell_errors
    if spell_errors:
        base_caption = (normalized.get("revised_caption") or text or "").strip()
        normalized["revised_caption"] = report_parsing.apply_misspell_fixes(base_caption, spell_errors)

    spell_has_action = (normalized.get("spell_total_errors") or 0) >= 1
    policy_has_action = report_parsing.needs_policy_action(normalized)
    passed = not policy_has_action and not spell_has_action
    parsed = {"policy_v2": policy_parsed, "spell": spell_ar.get("parsed")}
    raw = json.dumps(parsed, ensure_ascii=False)
    return {
        "passed": passed,
        "assessment_result": {
            "ad_id": ad_id,
            "ad_name": ad_name,
            "mode": "policy_and_spell",
            "raw_response": raw[:50000],
            "parsed": parsed,
            "normalized": normalized,
            "original_caption": text,
        },
    }
