"""
Step 2: assemble the prompt from editable parts + inject input/rules.

The prompt is split into prompts/0X_*.txt parts so each section is easy to edit.
This step reads them in filename order, wraps each in a section header, joins
them, then fills the injection placeholders:
  {{message}}                -> the caption / input text
  {{rules_block}}            -> the retrieved policy rules
  {{quick_reference_block}}  -> "(none)" for now

While the parts are still empty it falls back to the single-file prompt.txt,
so the pipeline keeps working until you fill the parts.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pipeline as core

PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


# --- sectioning helpers ---
def _section_title(path: Path) -> str:
    """'04_important_notes.txt' -> 'IMPORTANT NOTES'."""
    stem = path.stem
    head, _, tail = stem.partition("_")
    name = tail if (tail and head.isdigit()) else stem
    return name.replace("_", " ").strip().upper()


def _section_header(title: str) -> str:
    """One divider line that marks the start of a section."""
    return f"========== {title} =========="


def load_prompt_parts() -> list[tuple[str, str]]:
    """Return [(section_title, content), ...] for each non-empty prompts/*.txt, in order."""
    if not PROMPTS_DIR.exists():
        return []
    parts: list[tuple[str, str]] = []
    for path in sorted(PROMPTS_DIR.glob("*.txt")):
        content = path.read_text(encoding="utf-8").strip()
        if not content:
            continue
        parts.append((_section_title(path), content))
    return parts


def assemble_template() -> str:
    """Join all prompt parts with section headers into one template string."""
    parts = load_prompt_parts()
    if not parts:
        # Parts not filled yet -> use the single-file prompt as a fallback.
        return core.load_prompt()
    blocks = [f"{_section_header(title)}\n{content}" for title, content in parts]
    return "\n\n".join(blocks)


# --- rules block ---
def format_rules_block(rows: list[dict[str, Any]]) -> str:
    """Render matched rule rows into the RULES_BLOCK text injected into the prompt."""
    if not rows:
        return "(no rules matched)"
    chunks: list[str] = []
    for i, row in enumerate(rows, start=1):
        rule_id = row.get("rule_id") or ""
        title = (row.get("rule_title") or "").strip()
        rule_text = (row.get("rule_text") or "").strip()
        fix_note = (row.get("fix_note") or "").strip()
        src_display = (row.get("src_display") or "").strip()
        src_locator = (row.get("src_locator") or "").strip()
        lines = [f"[{i}] rule_id: {rule_id}"]
        if title:
            lines.append(f"short_title: {title}")
        if rule_text:
            lines.append(f"rule_text: {rule_text}")
        if fix_note:
            lines.append(f"fix_note: {fix_note}")
        if src_display:
            lines.append(f"source: {src_display}")
        if src_locator:
            lines.append(f"locator: {src_locator}")
        chunks.append("\n".join(lines))
    return "\n\n".join(chunks)


# --- final prompt ---
def build_prompt(input_text: str, rows: list[dict[str, Any]]) -> str:
    """Assemble the parts and fill placeholders -> a prompt ready to inject to the LLM."""
    template = assemble_template()
    rules_block = format_rules_block(rows)
    return (
        template.replace("{{message}}", input_text or "(no caption)")
        .replace("{{rules_block}}", rules_block)
        .replace("{{quick_reference_block}}", "(none)")
    )
