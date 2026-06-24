"""
Step 3: run the LLM and parse the assessment JSON.

Keeps the stricter rule-applicability filter from the new worker while preserving
the Gemini/OpenRouter backend switch used by the Slack workflow.
"""
from __future__ import annotations

import base64
import json
import re
import time
from typing import Any

import requests
from google.genai import types

import pipeline as core

_LLM_CONFIG = types.GenerateContentConfig(
    temperature=core.LLM_TEMPERATURE,
    seed=core.LLM_SEED,
)

_MAX_FILTER_ATTEMPTS = 3


def _build_rule_relevance_prompt(ad_text: str, rows: list[dict[str, Any]]) -> str:
    """Compact inline prompt: ad caption + retrieved rules -> applicability JSON."""
    rule_lines: list[str] = []
    for i, row in enumerate(rows, start=1):
        rule_id = row.get("rule_id") or ""
        title = (row.get("rule_title") or "").strip()
        rule_text = (row.get("rule_text") or "").strip()
        src_display = (row.get("src_display") or "").strip()
        parts = [f"[{i}] rule_id: {rule_id}"]
        if title:
            parts.append(f"rule_title: {title}")
        if rule_text:
            parts.append(f"rule_text: {rule_text}")
        if src_display:
            parts.append(f"source: {src_display}")
        rule_lines.append("\n".join(parts))

    rules_block = "\n\n".join(rule_lines)
    return (
        "You are a rule applicability classifier for Thai advertising policy compliance.\n\n"
        "Given an ad caption and retrieved policy rules, decide for EACH rule whether it "
        "applies to this ad's product, service, or industry context.\n\n"
        "Mark applicable=false when the rule clearly belongs to a different sector "
        "(e.g. a cosmetic advertising rule for a toilet cleaner ad).\n"
        "Mark applicable=true when the rule could reasonably apply to this ad, including "
        "general cross-industry consumer-protection or misleading-claim rules.\n\n"
        "Return JSON only, no other text:\n"
        '{"rules": [{"rule_id": "<id>", "applicable": true}, '
        '{"rule_id": "<id>", "applicable": false}]}\n\n'
        "You must include every rule_id listed below exactly once.\n\n"
        f"AD CAPTION:\n{ad_text or '(no caption)'}\n\n"
        f"RETRIEVED RULES:\n{rules_block}"
    )


def _validate_relevance_response(
    parsed: dict[str, Any] | None, expected_rule_ids: set[str]
) -> list[dict[str, Any]] | None:
    if not parsed or not isinstance(parsed.get("rules"), list):
        return None
    relevance: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for entry in parsed["rules"]:
        if not isinstance(entry, dict):
            return None
        rule_id = (entry.get("rule_id") or "").strip()
        if not rule_id or rule_id in seen_ids:
            return None
        applicable = entry.get("applicable")
        if not isinstance(applicable, bool):
            return None
        seen_ids.add(rule_id)
        relevance.append({"rule_id": rule_id, "applicable": applicable})
    if seen_ids != expected_rule_ids:
        return None
    return relevance


def filter_applicable_rules(
    ad_text: str, rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    Label each retrieved rule as applicable to the ad text; drop non-applicable rules.
    Retries on parse failure, then keeps all rows.
    """
    if not rows or not (ad_text or "").strip():
        return rows, {"skipped": True}

    expected_ids = {r.get("rule_id") for r in rows if r.get("rule_id")}
    if not expected_ids:
        return rows, {"skipped": True, "reason": "no rule_ids"}

    prompt = _build_rule_relevance_prompt(ad_text, rows)
    relevance: list[dict[str, Any]] | None = None
    attempts = 0

    for attempt in range(1, _MAX_FILTER_ATTEMPTS + 1):
        attempts = attempt
        raw = run_llm(prompt, image=None)
        parsed = parse_json(raw)
        relevance = _validate_relevance_response(parsed, expected_ids)
        if relevance is not None:
            break
        core.log(
            f"[WARN] rule relevance parse failed attempt {attempt}/{_MAX_FILTER_ATTEMPTS}"
        )

    if relevance is None:
        core.log(
            f"[WARN] rule relevance filter failed after {_MAX_FILTER_ATTEMPTS} attempts; "
            "keeping all retrieved rules"
        )
        return rows, {
            "retrieved_count": len(rows),
            "applicable_count": len(rows),
            "filtered_out_rule_ids": [],
            "relevance": [],
            "attempts": attempts,
            "fallback": "keep_all",
        }

    applicable_ids = {entry["rule_id"] for entry in relevance if entry["applicable"]}
    filtered = [row for row in rows if row.get("rule_id") in applicable_ids]
    filtered_out = [rid for rid in expected_ids if rid not in applicable_ids]

    return filtered, {
        "retrieved_count": len(rows),
        "applicable_count": len(filtered),
        "filtered_out_rule_ids": filtered_out,
        "relevance": relevance,
        "attempts": attempts,
        "fallback": None,
    }


def run_llm(prompt: str, image: tuple[bytes, str] | None) -> str:
    """
    Single LLM backend switch.
    Returns the raw model response text.
    """
    if core.LLM_BACKEND == "gemini":
        client = core.get_gemini()
        if image is None:
            response = client.models.generate_content(
                model=core.LLM_MODEL,
                contents=prompt,
                config=_LLM_CONFIG,
            )
        else:
            image_bytes, mime = image
            contents = [
                {
                    "role": "user",
                    "parts": [
                        {"inline_data": {"data": image_bytes, "mime_type": mime}},
                        {"text": prompt},
                    ],
                }
            ]
            response = client.models.generate_content(
                model=core.LLM_MODEL,
                contents=contents,
                config=_LLM_CONFIG,
            )
        return (response.text or "").strip()

    if core.LLM_BACKEND == "openrouter":
        return _run_openrouter(prompt, image)

    if core.LLM_BACKEND == "ollama":
        raise NotImplementedError("LLM_BACKEND='ollama' is not implemented yet")

    raise ValueError(f"Unknown LLM_BACKEND: {core.LLM_BACKEND}")


def _run_openrouter(prompt: str, image: tuple[bytes, str] | None) -> str:
    """Run OpenRouter's OpenAI-compatible chat completions API."""
    if not core.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY is required when LLM_BACKEND=openrouter")

    headers = {
        "Authorization": f"Bearer {core.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    if core.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = core.OPENROUTER_SITE_URL
    if core.OPENROUTER_APP_NAME:
        headers["X-Title"] = core.OPENROUTER_APP_NAME

    content: str | list[dict[str, Any]]
    if image is None:
        content = prompt
    else:
        image_bytes, mime = image
        encoded = base64.b64encode(image_bytes).decode("ascii")
        content = [
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{encoded}"},
            },
        ]

    payload: dict[str, Any] = {
        "model": core.OPENROUTER_MODEL,
        "messages": [{"role": "user", "content": content}],
        "temperature": core.LLM_TEMPERATURE,
    }
    if core.LLM_SEED:
        payload["seed"] = core.LLM_SEED
    if core.OPENROUTER_REASONING_ENABLED:
        payload["reasoning"] = {"enabled": True}
    if core.OPENROUTER_RESPONSE_FORMAT_JSON:
        payload["response_format"] = {"type": "json_object"}

    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            response = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json=payload,
                timeout=core.OPENROUTER_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            try:
                body = response.json()
            except ValueError as exc:
                snippet = (response.text or "")[:500].replace("\n", "\\n")
                raise RuntimeError(
                    f"OpenRouter returned non-JSON response status={response.status_code} "
                    f"body_prefix={snippet!r}"
                ) from exc
            break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt >= 3:
                raise
            sleep_seconds = min(2**attempt, 10)
            core.log(
                f"[WARN] OpenRouter request failed attempt {attempt}/3: {exc}. "
                f"retry in {sleep_seconds}s"
            )
            time.sleep(sleep_seconds)
    else:
        raise RuntimeError(f"OpenRouter request failed: {last_error}")

    try:
        message = body["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Invalid OpenRouter response: {body}") from exc

    content_value = message.get("content")
    if isinstance(content_value, str):
        return content_value.strip()
    if isinstance(content_value, list):
        text_parts = [
            str(part.get("text") or "")
            for part in content_value
            if isinstance(part, dict)
        ]
        return "\n".join(part for part in text_parts if part).strip()
    return ""


def parse_json(raw: str) -> dict | None:
    """Extract the first JSON object from a raw model response."""
    if not raw or not isinstance(raw, str):
        return None
    match = re.search(r"\{[\s\S]*\}", raw.strip())
    if not match:
        return None
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        return None


def assess(prompt: str, image: tuple[bytes, str] | None) -> dict[str, Any]:
    """Run the LLM and return the parsed analysis dict (or a _parse_error dict)."""
    raw = run_llm(prompt, image)
    analysis = parse_json(raw)
    if analysis is None:
        return {"_parse_error": "no valid JSON", "raw_response": raw[:50000]}
    return analysis
