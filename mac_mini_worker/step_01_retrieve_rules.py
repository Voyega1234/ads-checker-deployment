"""
Step 1: format input text + retrieve related policy rules.

The caption is normalized into a retrieval query, embedded with Gemini
(RETRIEVAL_QUERY), and used to fetch the top-N policy rules via the
match_policy_rules_vector RPC.

Shared clients/config come from pipeline.
"""
from __future__ import annotations

import time
from typing import Any, Iterable

import pipeline as core


def format_input_text(caption: str) -> str:
    """Normalize the caption into the text used for embedding search."""
    return (caption or "").strip()


def _vector_to_pg_literal(values: Iterable[float]) -> str:
    return "[" + ",".join(f"{float(v):.10g}" for v in values) + "]"


def embed_query(text: str, max_retries: int = 5) -> list[float]:
    """Embed a retrieval query with Gemini (RETRIEVAL_QUERY task type)."""
    if not text or not text.strip():
        raise ValueError("Cannot embed blank text")

    from google.genai import types

    client = core.get_gemini()
    last_error: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            result = client.models.embed_content(
                model=core.EMBEDDING_MODEL,
                contents=text,
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_QUERY",
                    output_dimensionality=core.EMBEDDING_DIMENSION,
                ),
            )
            if not result.embeddings:
                raise RuntimeError("Gemini returned no embeddings")
            values = [float(x) for x in result.embeddings[0].values]
            if len(values) != core.EMBEDDING_DIMENSION:
                raise RuntimeError(
                    f"Embedding dimension mismatch: got {len(values)}, "
                    f"expected {core.EMBEDDING_DIMENSION}"
                )
            return values
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            sleep_seconds = min(2**attempt, 30)
            core.log(f"[WARN] embed failed attempt {attempt}/{max_retries}: {exc}. retry in {sleep_seconds}s")
            time.sleep(sleep_seconds)
    raise RuntimeError(f"Embedding failed after retries: {last_error}")


def search_related_rules(query_text: str, match_count: int | None = None) -> list[dict[str, Any]]:
    """Top-N policy rules via match_policy_rules_vector RPC."""
    if match_count is None:
        match_count = core.RULES_MATCH_COUNT
    supabase = core.get_supabase()
    result = supabase.rpc(
        "match_policy_rules_vector",
        {
            "query_embedding": _vector_to_pg_literal(embed_query(query_text)),
            "match_count": match_count,
            "embedding_model_filter": core.EMBEDDING_MODEL_DB_NAME,
            "policy_type_filter": None,
            "rule_status_filter": None,
        },
    ).execute()
    return result.data or []


def fetch_client_ignored_rule_ids(client_id: str | None) -> set[str]:
    """Active ignored rule_ids for a client (client_policy_rule_ignores, is_ignored=true)."""
    if not client_id or not str(client_id).strip():
        return set()
    supabase = core.get_supabase()
    result = (
        supabase.table("client_policy_rule_ignores")
        .select("rule_id")
        .eq("client_id", str(client_id).strip())
        .eq("is_ignored", True)
        .execute()
    )
    return {
        str(row["rule_id"])
        for row in (result.data or [])
        if row.get("rule_id")
    }


def run(
    caption: str, client_id: str | None = None
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """
    Return (input_text, matched_rule_rows, ignore_meta).

    No rules when caption is blank. When `client_id` is provided, drop any retrieved
    rule whose rule_id is in that client's ignore list (is_ignored=true); ignore_meta
    records what was filtered.
    """
    input_text = format_input_text(caption)
    rows: list[dict[str, Any]] = []
    if input_text:
        rows = search_related_rules(input_text)

    retrieved_count = len(rows)
    ignored_rule_ids: list[str] = []
    applied = bool(client_id and str(client_id).strip())
    if applied:
        ignored = fetch_client_ignored_rule_ids(client_id)
        if ignored:
            ignored_rule_ids = [
                r.get("rule_id") for r in rows if r.get("rule_id") in ignored
            ]
            rows = [r for r in rows if r.get("rule_id") not in ignored]

    ignore_meta = {
        "client_id": (str(client_id).strip() if applied else None),
        "applied": applied,
        "retrieved_count": retrieved_count,
        "ignored_rule_ids": ignored_rule_ids,
        "after_ignore_count": len(rows),
    }
    return input_text, rows, ignore_meta
