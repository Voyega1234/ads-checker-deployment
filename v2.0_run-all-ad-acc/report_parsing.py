"""
Parse Gemini raw output for spell_checker and policy_and_spell_checker.
Prompt source: Sheet tab Prompt (reference: docs/prompt.txt).
Spell error types from prompt: misspell | spacing. We accept "others" as legacy fallback for display.
"""
import json
import re


def parse_gemini_json(raw: str) -> dict | None:
    """Extract first JSON object from raw Gemini response. Return None on failure."""
    if not raw or not isinstance(raw, str):
        return None
    match = re.search(r"\{[\s\S]*\}", raw.strip())
    if not match:
        return None
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        return None


# --- Spell output (docs/prompt.txt: error types misspell | spacing) ---
# New: error_summary: { misspell, spacing, total_errors }, errors: [...], corrected_caption
# Old: fields.caption.error_level, wording_analysis.errors, wording_analysis.corrected_caption. Type "others" treated as spacing for display.


def _total_errors_from_parsed(parsed: dict) -> int:
    """Get total error count from new or old spell format."""
    summary = parsed.get("error_summary") or {}
    if isinstance(summary, dict) and "total_errors" in summary:
        return int(summary.get("total_errors") or 0)
    caption = (parsed.get("fields") or {}).get("caption") or {}
    if isinstance(caption, dict) and "typo_count" in caption:
        return int(caption.get("typo_count") or 0)
    errs = (parsed.get("wording_analysis") or {}).get("errors") or []
    return len(errs) if isinstance(errs, list) else 0


def _error_level_from_total(total: int) -> str:
    """Map total_errors to none | minor | moderate | severe."""
    if total <= 0:
        return "none"
    if total <= 2:
        return "minor"
    if total <= 5:
        return "moderate"
    return "severe"


def _is_misspell_error(item: object) -> bool:
    """True when error item is a dict with type=misspell."""
    if not isinstance(item, dict):
        return False
    t = str(item.get("type", "")).strip().lower()
    return t == "misspell"


def apply_misspell_fixes(original: str, errors: list) -> str:
    """
    Build corrected text from the original ad copy by applying each error's
    original→corrected in list order (first occurrence per error row). Preserves
    newlines and spacing outside replaced spans so output matches the source layout.
    """
    out = str(original) if original is not None else ""
    for item in errors:
        if not isinstance(item, dict):
            continue
        orig = item.get("original", item.get("original_text", ""))
        corr = item.get("corrected", item.get("corrected_text", ""))
        if orig is None or str(orig).strip() == "":
            continue
        o = str(orig)
        c = str(corr) if corr is not None else ""
        if o in out:
            out = out.replace(o, c, 1)
    return out


def _effective_corrected_caption_spell(normalized: dict, original_ad_text: str | None) -> str:
    """Prefer original + error list over model corrected_caption when original is known."""
    errors = normalized.get("errors") or []
    if original_ad_text is not None and errors:
        return apply_misspell_fixes(original_ad_text, errors)
    return (normalized.get("corrected_caption") or "").strip()


def _effective_revised_caption_policy_spell(normalized: dict, original_ad_text: str | None) -> str:
    """Spell fixes from original; if no spell errors, keep model revised_caption (policy edits)."""
    spell_errors = normalized.get("spell_errors") or []
    if original_ad_text is not None and spell_errors:
        return apply_misspell_fixes(original_ad_text, spell_errors)
    return (normalized.get("revised_caption") or "").strip()


def normalize_spell_result(parsed: dict, original_ad_text: str | None = None) -> dict:
    """
    Normalize spell checker JSON to a single shape.
    Accepts new format (error_summary, errors, corrected_caption) and
    old format (fields.caption.error_level/typo_count, wording_analysis.errors/corrected_caption).
    Returns: { "error_level": str, "errors": list, "corrected_caption": str, "total_errors": int }
    """
    total = _total_errors_from_parsed(parsed)
    error_level = _error_level_from_total(total)

    # Old format had fields.caption.error_level
    caption = (parsed.get("fields") or {}).get("caption") or {}
    if isinstance(caption, dict) and caption.get("error_level"):
        error_level = str(caption.get("error_level", "")).strip().lower() or error_level
    if error_level not in ("none", "minor", "moderate", "severe"):
        error_level = _error_level_from_total(total)

    errors = parsed.get("errors")
    if not isinstance(errors, list):
        errors = (parsed.get("wording_analysis") or {}).get("errors") or []
    if not isinstance(errors, list):
        errors = []
    # Alert only on misspell errors; ignore 'spacing' for actioning.
    errors = [e for e in errors if _is_misspell_error(e)]
    total = len(errors)
    error_level = _error_level_from_total(total)

    corrected = parsed.get("corrected_caption")
    if corrected is None or corrected == "":
        corrected = (parsed.get("wording_analysis") or {}).get("corrected_caption") or ""

    if original_ad_text is not None:
        if errors:
            corrected = apply_misspell_fixes(original_ad_text, errors)
        else:
            corrected = (original_ad_text or "").strip()
    else:
        corrected = (corrected or "").strip()

    return {
        "error_level": error_level,
        "total_errors": total,
        "errors": errors,
        "corrected_caption": corrected,
    }


def needs_spell_action(normalized: dict) -> bool:
    """True if spell result has at least 1 error (report only ads that need action)."""
    return (normalized.get("total_errors") or 0) >= 1


_POLICY_NO_RISK_VERDICTS = (
    "pass",
    "low risk",
    "no risk",
    "ok",
    "✅ pass",
    "✅ low risk",
    "✅ no risk",
)


def standardize_policy_risk_label(normalized: dict) -> str:
    """
    Single display label for Slack: High Risk, Some Risk, or Low Risk.
    Uses matches.red / matches.yellow first, then verdict heuristics.
    """
    matches = normalized.get("matches") or {}
    if not isinstance(matches, dict):
        matches = {}
    red = matches.get("red") or []
    yellow = matches.get("yellow") or []
    if isinstance(red, list) and len(red) > 0:
        return "High Risk"
    if isinstance(yellow, list) and len(yellow) > 0:
        return "Some Risk"
    verdict = (normalized.get("verdict") or "").strip().lower()
    if verdict in _POLICY_NO_RISK_VERDICTS:
        return "Low Risk"
    if "high risk" in verdict or verdict.startswith("high "):
        return "High Risk"
    if "low" in verdict or "pass" in verdict or verdict == "ok" or "no risk" in verdict:
        return "Low Risk"
    if "some" in verdict or "yellow" in verdict or "medium" in verdict:
        return "Some Risk"
    return "Some Risk"


def policy_risk_display_with_emoji(label: str) -> str:
    """Slack policy line: red / yellow / green circle + risk name (matches red/yellow semantics)."""
    if label == "High Risk":
        return "🔴 High Risk"
    if label == "Some Risk":
        return "🟡 Some Risk"
    if label == "Low Risk":
        return "🟢 Low Risk"
    return label


def needs_policy_action(normalized: dict) -> bool:
    """
    True only for High Risk or Some Risk (same labels as Slack).
    Low Risk does not require action, even if the model added fix_notes or wording.
    """
    return standardize_policy_risk_label(normalized) in ("High Risk", "Some Risk")


def _format_policy_fix_notes_slack(fix_notes: list) -> str:
    """Bullet list only, no heading; (none) when empty."""
    if not fix_notes or not isinstance(fix_notes, list):
        return "(none)"
    notes = [str(n).strip() for n in fix_notes[:10] if n is not None and str(n).strip()]
    if not notes:
        return "(none)"
    return "\n".join(f"- {n}" for n in notes)


def _format_flags_line(label: str, items: list, *, max_items: int = 10) -> str | None:
    """One line: *Label:* `a`, `b`, ... or None if no items."""
    if not items or not isinstance(items, list):
        return None
    parts = [str(x).strip() for x in items[:max_items] if x is not None and str(x).strip()]
    if not parts:
        return None
    ticked = ", ".join(f"`{p}`" for p in parts)
    return f"*{label}:* {ticked}"


def _format_policy_slack_blocks(normalized: dict) -> str:
    """Red/Yellow flag lines first, then fix notes as a bullet list only (newline-separated)."""
    matches = normalized.get("matches") or {}
    if not isinstance(matches, dict):
        matches = {}
    fix_notes = normalized.get("fix_notes") or []
    if not isinstance(fix_notes, list):
        fix_notes = []
    chunks: list[str] = []
    red_line = _format_flags_line("Red Flags", matches.get("red") or [])
    if red_line:
        chunks.append(red_line)
    yellow_line = _format_flags_line("Yellow Flags", matches.get("yellow") or [])
    if yellow_line:
        chunks.append(yellow_line)
    chunks.append(_format_policy_fix_notes_slack(fix_notes))
    return "\n".join(chunks)


def should_include_text_thread_reply_card(ar: dict) -> bool:
    """
    Whether to post a per-group Slack thread card for this text assessment.
    Skip cards that only restate success (e.g. spell 0 errors, policy pass) so the initial
    message can still show Action Required / Fixed counts without noisy empty-detail replies.
    Always include parse/API errors and any actionable policy or spell finding.
    """
    if ar.get("parse_error") or ar.get("error"):
        return True
    mode = ar.get("mode")
    normalized = ar.get("normalized") or {}
    if not isinstance(normalized, dict):
        return True
    if mode == "policy_only":
        return needs_policy_action(normalized)
    if mode == "spell_only":
        return needs_spell_action(normalized)
    if mode == "policy_and_spell":
        spell_n = int(normalized.get("spell_total_errors") or 0)
        return spell_n >= 1 or needs_policy_action(normalized)
    return True


def format_spell_thread_reply(
    ad_id: str,
    ad_name: str,
    normalized: dict,
    parse_error: str | None,
    index: int | None = None,
    *,
    original_ad_text: str | None = None,
) -> str:
    """Build one thread reply for spell check. If index given, Slack format: numbering, bold, errors before corrected, corrected in code block; risk = error amount."""
    if parse_error:
        if index is not None:
            return f"*{index}. Ad Name:* {ad_name}\n*Ad ID:* {ad_id} | Parse error – {parse_error}"
        return f"Ad ID: {ad_id}, Ad Name: {ad_name}, Spell: Parse error – {parse_error}"
    total = normalized.get("total_errors", 0)
    corrected = _effective_corrected_caption_spell(normalized, original_ad_text)
    errors_list = normalized.get("errors") or []
    risk_amount = f"{total} errors"
    if index is not None:
        errors_block = _format_spell_errors_slack(errors_list)
        corrected_block = f"```{corrected}```" if corrected else "```(no caption)```"
        head = f"*{index}. Ad Name:* {ad_name}\n*Ad ID:* {ad_id} | {risk_amount}"
        parts: list[str] = [head]
        if errors_block:
            parts.append(errors_block)
        parts.append(f"*Reviseds:*\n{corrected_block}")
        return "\n".join(parts)
    level = normalized.get("error_level", "N/A")
    base = f"Ad ID: {ad_id}, Ad Name: {ad_name}, Spell: {level} ({total} errors), Reviseds: {corrected[:500]}"
    if errors_list:
        err_str = _format_spell_errors_list(errors_list, max_len=500)
        if err_str:
            base = f"{base} | Spell errors: {err_str}"
    return base


# --- Policy output (wording_analysis.verdict, matches, revised_caption) ---


def _spell_error_type_for_display(t: str) -> str:
    """Normalize error type for display. Prompt returns misspell | spacing; accept 'others' as legacy -> show as 'spacing'."""
    normalized = (t or "").strip().lower()
    if normalized != "misspell":
        return "spacing"
    return (t or "").strip()


def _format_spell_errors_list(errors: list, max_len: int = 500) -> str:
    """Format list of spell errors for report; cap total length. Item: dict with original/corrected/type or str."""
    if not errors:
        return ""
    parts = []
    for i, item in enumerate(errors, 1):
        if isinstance(item, dict):
            orig = item.get("original", item.get("original_text", ""))
            corr = item.get("corrected", item.get("corrected_text", ""))
            t = _spell_error_type_for_display(item.get("type", ""))
            part = f"({i}) {orig} → {corr}" + (f" [{t}]" if t else "")
        else:
            part = f"({i}) {item}"
        parts.append(part)
    s = "; ".join(parts)
    return s[:max_len] + ("..." if len(s) > max_len else "")


def _format_spell_errors_slack(errors: list) -> str:
    """Format spell errors for Slack: *Spell Errors:* then one line per error '- orig → corrected (type)'. Omitted if empty."""
    if not errors:
        return ""
    lines = ["*Spell Errors:*"]
    for item in errors:
        if isinstance(item, dict):
            orig = item.get("original", item.get("original_text", ""))
            corr = item.get("corrected", item.get("corrected_text", ""))
            t = _spell_error_type_for_display(item.get("type", ""))
            line = f"- {orig} → {corr}" + (f" ({t})" if t else "")
        else:
            line = f"- {item}"
        lines.append(line)
    return "\n".join(lines)


def normalize_policy_result(parsed: dict) -> dict:
    """
    Normalize policy checker JSON.
    Returns: { "verdict", "matches": { "red", "yellow" }, "revised_caption", "fix_notes": [] }
    """
    wa = parsed.get("wording_analysis") or {}
    verdict = (wa.get("verdict") or "").strip()
    matches = wa.get("matches") or {}
    if not isinstance(matches, dict):
        matches = {}
    revised = (wa.get("revised_caption") or "").strip()
    fix_notes = wa.get("fix_notes")
    if not isinstance(fix_notes, list):
        fix_notes = []
    return {
        "verdict": verdict,
        "matches": matches,
        "revised_caption": revised,
        "fix_notes": fix_notes,
    }


def normalize_policy_v2_result(parsed: dict, original_ad_text: str | None = None) -> dict:
    """
    Normalize policy v2 JSON to the legacy policy shape used by Slack/reporting.
    Keeps the full v2 object under policy_v2 for richer downstream UI.
    """
    analysis = parsed.get("caption_analysis") if isinstance(parsed.get("caption_analysis"), dict) else parsed
    if not isinstance(analysis, dict):
        analysis = {}
    issues = analysis.get("issues") if isinstance(analysis.get("issues"), list) else []
    fail_issues = []
    for item in issues:
        if not isinstance(item, dict):
            continue
        verdict = str(item.get("verdict") or "").strip().lower()
        if verdict == "fail":
            fail_issues.append(item)

    red_flags = []
    fix_notes = []
    for issue in fail_issues:
        flag = (
            issue.get("flagged_text")
            or issue.get("issue_title")
            or issue.get("short_title")
            or issue.get("category")
            or ""
        )
        flag = str(flag).strip()
        if flag:
            red_flags.append(flag)
        note = issue.get("fix_note") or issue.get("issue_detail") or ""
        note = str(note).strip()
        if note:
            fix_notes.append(note)

    def _unique(items: list) -> list:
        out = []
        seen = set()
        for value in items:
            key = str(value).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(key)
        return out

    overall = str(analysis.get("overall_result") or (analysis.get("summary") or {}).get("overall_verdict") or "").strip().lower()
    verdict = "fail" if fail_issues or overall == "fail" else "pass"
    revised = str(analysis.get("revised_caption") or analysis.get("revised_message") or "").strip()
    if verdict == "pass" and original_ad_text is not None:
        revised = str(original_ad_text or "").strip()

    verification = parsed.get("revised_caption_verification") if isinstance(parsed.get("revised_caption_verification"), dict) else {}

    return {
        "verdict": verdict,
        "matches": {"red": _unique(red_flags), "yellow": []},
        "revised_caption": revised,
        "fix_notes": _unique(fix_notes),
        "policy_v2": analysis,
        "policy_v2_verification": verification,
    }


def format_policy_thread_reply(
    ad_id: str, ad_name: str, normalized: dict, parse_error: str | None, index: int | None = None
) -> str:
    """Build one thread reply for policy check. Slack format uses standardized Policy risk + flags + fix note list."""
    if parse_error:
        if index is not None:
            return f"*{index}. Ad Name:* {ad_name}\n*Ad ID:* {ad_id} | Parse error – {parse_error}"
        return f"Ad ID: {ad_id}, Ad Name: {ad_name}, Policy: Parse error – {parse_error}"
    label = standardize_policy_risk_label(normalized)
    revised = (normalized.get("revised_caption") or "").strip()
    policy_blocks = _format_policy_slack_blocks(normalized)
    if index is not None:
        revised_block = f"```{revised}```" if revised else "```(none)```"
        pol = policy_risk_display_with_emoji(label)
        out = (
            f"*{index}. Ad Name:* {ad_name}\n*Ad ID:* {ad_id} | *Policy:* {pol}\n"
            f"{policy_blocks}\n"
            f"*Revised:*\n{revised_block}"
        )
        return out
    base = f"Ad ID: {ad_id}, Ad Name: {ad_name}, Policy: {policy_risk_display_with_emoji(label)}, Revised: {revised}"
    return f"{base}\n{policy_blocks}" if policy_blocks else base


# --- Policy + Spell combined (single prompt, one revised_caption) ---
# From docs/promp.txt: wording_analysis.revised_caption = single final (policy + spell cleaned)
# spell_analysis: error_level, typo_count, errors (no separate corrected_caption)


def normalize_policy_and_spell_result(parsed: dict, original_ad_text: str | None = None) -> dict:
    """
    Normalize policy_and_spell_checker JSON (one prompt, one revised caption).
    Returns: verdict, matches, fix_notes, revised_caption, spell_error_level, spell_total_errors, spell_errors.
    """
    wa = parsed.get("wording_analysis") or {}
    verdict = (wa.get("verdict") or "").strip()
    matches = wa.get("matches") or {}
    if not isinstance(matches, dict):
        matches = {}
    fix_notes = wa.get("fix_notes")
    if not isinstance(fix_notes, list):
        fix_notes = []
    revised_caption = (wa.get("revised_caption") or "").strip()

    spell = parsed.get("spell_analysis") or {}
    summary = spell.get("error_summary") or {}
    if isinstance(summary, dict) and "total_errors" in summary:
        spell_total_errors = int(summary.get("total_errors") or 0)
    else:
        spell_total_errors = int(spell.get("typo_count") or 0)
    spell_error_level = str(spell.get("error_level") or "").strip().lower()
    if spell_error_level not in ("none", "minor", "moderate", "severe"):
        spell_error_level = _error_level_from_total(spell_total_errors)
    spell_errors = spell.get("errors")
    if not isinstance(spell_errors, list):
        spell_errors = []
    # Alert only on misspell errors; ignore spacing for actioning.
    spell_errors = [e for e in spell_errors if _is_misspell_error(e)]
    spell_total_errors = len(spell_errors)
    spell_error_level = _error_level_from_total(spell_total_errors)

    if original_ad_text is not None and spell_errors:
        revised_caption = apply_misspell_fixes(original_ad_text, spell_errors)

    return {
        "verdict": verdict,
        "matches": matches,
        "fix_notes": fix_notes,
        "revised_caption": revised_caption,
        "spell_error_level": spell_error_level,
        "spell_total_errors": spell_total_errors,
        "spell_errors": spell_errors,
    }


def format_policy_and_spell_thread_reply(
    ad_id: str,
    ad_name: str,
    normalized: dict,
    parse_error: str | None,
    index: int | None = None,
    *,
    original_ad_text: str | None = None,
) -> str:
    """Build one thread reply for policy+spell. If index given, Slack format: policy verdict kept, spell = risk amount, errors before corrected."""
    if parse_error:
        if index is not None:
            return f"*{index}. Ad Name:* {ad_name}\n*Ad ID:* {ad_id} | Policy+Spell: Parse error – {parse_error}"
        return f"Ad ID: {ad_id}, Ad Name: {ad_name}, Policy+Spell: Parse error – {parse_error}"
    label = standardize_policy_risk_label(normalized)
    spell_total = normalized.get("spell_total_errors", 0)
    revised = _effective_revised_caption_policy_spell(normalized, original_ad_text)
    policy_blocks = _format_policy_slack_blocks(normalized)
    spell_errors_list = normalized.get("spell_errors") or []
    if index is not None:
        risk_line = f"Policy: {policy_risk_display_with_emoji(label)}, Spell: {spell_total} errors"
        errors_block = _format_spell_errors_slack(spell_errors_list)
        corrected_block = f"```{revised}```" if revised else "```(none)```"
        head = f"*{index}. Ad Name:* {ad_name}\n*Ad ID:* {ad_id} | {risk_line}"
        parts: list[str] = [head, policy_blocks]
        if errors_block:
            parts.append(errors_block)
        parts.append(f"*Reviseds:*\n{corrected_block}")
        return "\n".join(parts)
    base = (
        f"Ad ID: {ad_id}, Ad Name: {ad_name}, "
        f"Policy: {policy_risk_display_with_emoji(label)}, Spell: {spell_total} errors, Revised: {revised[:500]}"
    )
    parts = [base]
    parts.append(policy_blocks)
    if spell_errors_list:
        parts.append("Spell errors: " + _format_spell_errors_list(spell_errors_list, max_len=500))
    return "\n".join(p for p in parts if p)


def _format_grouped_ads_header(index: int, ads: list[tuple[str, str]]) -> str:
    """One ad: *{index}. Ad:* `name (id)`. Multiple: *{index}. Ads:* then • lines with `name (id)` each."""
    if len(ads) == 1:
        ad_name, ad_id = ads[0]
        n = (ad_name or "").strip() or "(no name)"
        return f"*{index}. Ad:* `{n} ({ad_id})`"
    lines: list[str] = [f"*{index}. Ads:*"]
    for ad_name, ad_id in ads:
        n = (ad_name or "").strip() or "(no name)"
        lines.append(f"• `{n} ({ad_id})`")
    return "\n".join(lines)


def format_spell_thread_reply_grouped(
    ads: list[tuple[str, str]],
    normalized: dict,
    parse_error: str | None,
    index: int,
    original_ad_text: str,
    *,
    show_original_ad_text: bool = True,
) -> list[str]:
    """Grouped card: same caption + same spell assessment. Returns one or two thread messages (split after original text when shown)."""
    if parse_error:
        return [f"{_format_grouped_ads_header(index, ads)}\nSpell: Parse error – {parse_error}"]
    total = normalized.get("total_errors", 0)
    corrected = _effective_corrected_caption_spell(normalized, original_ad_text)
    errors_list = normalized.get("errors") or []
    errors_block = _format_spell_errors_slack(errors_list)
    corrected_block = f"```{corrected}```" if corrected else "```(no caption)```"
    orig_block = f"```{original_ad_text}```" if original_ad_text else "```(empty)```"
    header = _format_grouped_ads_header(index, ads)
    if not show_original_ad_text:
        parts: list[str] = [header]
        if errors_block:
            parts.append(errors_block)
        parts.append(f"*Reviseds:*\n{corrected_block}")
        return ["\n".join(parts)]
    part1 = f"{header}\n*Original Text — {total} spell errors*\n{orig_block}"
    part2_parts: list[str] = []
    if errors_block:
        part2_parts.append(errors_block)
    part2_parts.append(f"*Reviseds:*\n{corrected_block}")
    return [part1, "\n".join(part2_parts)]


def format_policy_thread_reply_grouped(
    ads: list[tuple[str, str]],
    normalized: dict,
    parse_error: str | None,
    index: int,
    original_ad_text: str,
    *,
    show_original_ad_text: bool = True,
) -> list[str]:
    """Grouped card for policy-only. Returns one or two thread messages (split after original text when shown)."""
    if parse_error:
        return [f"{_format_grouped_ads_header(index, ads)}\nPolicy: Parse error – {parse_error}"]
    label = standardize_policy_risk_label(normalized)
    revised = (normalized.get("revised_caption") or "").strip()
    policy_blocks = _format_policy_slack_blocks(normalized)
    revised_block = f"```{revised}```" if revised else "```(none)```"
    orig_block = f"```{original_ad_text}```" if original_ad_text else "```(empty)```"
    pol = policy_risk_display_with_emoji(label)
    header = _format_grouped_ads_header(index, ads)
    if not show_original_ad_text:
        return [
            f"{header}\n"
            f"*Policy:* {pol}\n"
            f"{policy_blocks}\n"
            f"*Revised:*\n{revised_block}"
        ]
    part1 = f"{header}\n*Original Text*\n{orig_block}"
    part2 = f"*Policy:* {pol}\n{policy_blocks}\n*Revised:*\n{revised_block}"
    return [part1, part2]


def format_policy_and_spell_thread_reply_grouped(
    ads: list[tuple[str, str]],
    normalized: dict,
    parse_error: str | None,
    index: int,
    original_ad_text: str,
    *,
    show_original_ad_text: bool = True,
) -> list[str]:
    """Grouped card: policy+spell. Returns one or two thread messages (split after original text when shown)."""
    if parse_error:
        return [f"{_format_grouped_ads_header(index, ads)}\nPolicy+Spell: Parse error – {parse_error}"]
    label = standardize_policy_risk_label(normalized)
    spell_total = normalized.get("spell_total_errors", 0)
    revised = _effective_revised_caption_policy_spell(normalized, original_ad_text)
    policy_blocks = _format_policy_slack_blocks(normalized)
    spell_errors_list = normalized.get("spell_errors") or []
    errors_block = _format_spell_errors_slack(spell_errors_list)
    corrected_block = f"```{revised}```" if revised else "```(none)```"
    orig_block = f"```{original_ad_text}```" if original_ad_text else "```(empty)```"
    pol = policy_risk_display_with_emoji(label)
    header = _format_grouped_ads_header(index, ads)
    if not show_original_ad_text:
        body_parts = [
            header,
            f"*Policy:* {pol}",
            policy_blocks,
        ]
        if errors_block:
            body_parts.append(errors_block)
        body_parts.append(f"*Reviseds:*\n{corrected_block}")
        return ["\n".join(body_parts)]
    part1 = f"{header}\n*Original Text — {spell_total} spell errors*\n{orig_block}"
    rest: list[str] = [f"*Policy:* {pol}", policy_blocks]
    if errors_block:
        rest.append(errors_block)
    rest.append(f"*Reviseds:*\n{corrected_block}")
    return [part1, "\n".join(rest)]


def assessment_payload_key(ar: dict) -> str:
    """Stable key for grouping Slack cards: ignores per-ad ad_id/ad_name in ar."""
    subset = {
        "mode": ar.get("mode"),
        "parse_error": ar.get("parse_error"),
        "error": ar.get("error"),
        "normalized": ar.get("normalized"),
    }
    return json.dumps(subset, sort_keys=True, default=str)


if __name__ == "__main__":
    assert policy_risk_display_with_emoji("High Risk") == "🔴 High Risk"
    assert policy_risk_display_with_emoji("Some Risk") == "🟡 Some Risk"
    assert policy_risk_display_with_emoji("Low Risk") == "🟢 Low Risk"
    assert standardize_policy_risk_label({"matches": {"red": ["a"]}, "verdict": ""}) == "High Risk"
    assert standardize_policy_risk_label({"matches": {"yellow": ["b"]}, "verdict": ""}) == "Some Risk"
    assert standardize_policy_risk_label({"matches": {}, "verdict": "pass"}) == "Low Risk"
    assert _format_policy_slack_blocks({"matches": {}, "fix_notes": []}) == "(none)"
    s = _format_policy_slack_blocks({"matches": {"red": ["x"]}, "fix_notes": ["fix one"]})
    assert "*Red Flags:*" in s and "- fix one" in s
    assert s.index("*Red Flags:*") < s.index("- fix one")

    print("report_parsing __main__ checks OK")
