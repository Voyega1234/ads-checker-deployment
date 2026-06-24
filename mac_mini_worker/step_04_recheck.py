"""
Step 4: optional re-check / revision loop.

Only runs when enabled by the caller (recheck_until_pass) and the first verdict
is "fail". It re-runs the checker on the model's revised_message against the same
rules, up to max_attempts, stopping early on "pass". This guards that our revised
text actually passes, while the prompt itself enforces "keep the same content".
"""
from __future__ import annotations

from typing import Any

import step_02_build_prompt as step_02
import step_03_run_llm as step_03


def verdict_of(analysis: dict | None) -> str:
    if not isinstance(analysis, dict):
        return "unknown"
    return (analysis.get("overall_result") or "").strip().lower() or "unknown"


def recheck(
    analysis: dict[str, Any],
    rows: list[dict[str, Any]],
    image: tuple[bytes, str] | None,
    max_attempts: int,
) -> tuple[dict[str, Any], int, list[str]]:
    """
    Re-assess the revised text until it passes or attempts run out.
    Returns (final_analysis, attempts, history) where attempts counts the
    initial assessment as 1 and history lists each verdict in order.
    """
    attempts = 1
    history = [verdict_of(analysis)]

    for _ in range(max(0, int(max_attempts))):
        revised = (analysis.get("revised_message") or "").strip()
        if not revised:
            break
        prompt = step_02.build_prompt(revised, rows)
        re_analysis = step_03.assess(prompt, image)
        attempts += 1
        v = verdict_of(re_analysis)
        history.append(v)
        analysis = re_analysis
        if v == "pass":
            break

    return analysis, attempts, history
