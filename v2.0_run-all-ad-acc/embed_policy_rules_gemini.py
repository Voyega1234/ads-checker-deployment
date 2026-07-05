#!/usr/bin/env python3
"""
Embed policy_rules with Gemini Embedding 2 and store them in Supabase pgvector.

Works with the SQL init file that creates:
  - public.policy_rule_embeddings
  - public.get_policy_rule_embedding_refresh_queue(...)
  - public.upsert_policy_rule_embedding(...)
  - public.match_policy_rules_vector(...)

Default:
  model = gemini-embedding-2
  dimension = 1536

Why 1536?
  The SQL init file uses public.vector(1536). If you want 3072,
  change the SQL schema first from vector(1536) to vector(3072),
  then set EMBEDDING_DIMENSION=3072 here.

Install:
  pip install google-genai supabase python-dotenv

.env:
  GEMINI_API_KEY=...
  SUPABASE_URL=...
  SUPABASE_SERVICE_ROLE_KEY=...

Usage:
  python embed_policy_rules_gemini.py backfill

  python embed_policy_rules_gemini.py search \
    --text "ลดน้ำหนัก 10 โลใน 7 วัน เห็นผลชัวร์ รับประกัน"
"""

import argparse
import os
import sys
import time
from typing import Any, Dict, Iterable, List, Optional

from google.genai import types
from supabase import create_client
import google_adc


try:
    from env_loader import load_project_env
except Exception:
    load_project_env = None

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


def load_env() -> None:
    if load_project_env:
        load_project_env()
    elif load_dotenv:
        load_dotenv()

    alias_env("SUPABASE_URL", "VITE_SUPABASE_URL")
    alias_env("SUPABASE_SERVICE_KEY", "VITE_SUPABASE_SERVICE_KEY")


def alias_env(target: str, source: str) -> None:
    if os.environ.get(target):
        return
    value = os.getenv(source)
    if value:
        os.environ[target] = value


load_env()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or os.getenv("SUPABASE_SERVICE_KEY")
    or os.getenv("SUPABASE_KEY")
)

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "gemini-embedding-2")
EMBEDDING_DIMENSION = int(os.getenv("EMBEDDING_DIMENSION", "1536"))

# Store model + dimension in the DB so future re-embedding is clear.
# This must match what you pass into match_policy_rules_vector later.
EMBEDDING_MODEL_DB_NAME = os.getenv(
    "EMBEDDING_MODEL_DB_NAME",
    f"{EMBEDDING_MODEL}:{EMBEDDING_DIMENSION}",
)
DEFAULT_RULE_STATUS_FILTER = ["prohibited", "warning", "required", "conditional"]


def require_env() -> None:
    missing = []
    if not SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not SUPABASE_KEY:
        missing.append("SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY")

    if missing:
        raise RuntimeError("Missing env vars: " + ", ".join(missing))


def vector_to_pg_literal(values: Iterable[float]) -> str:
    """
    PostgREST/Supabase RPC casts this string into public.vector(1536).
    Example: "[0.1,0.2,0.3]"
    """
    return "[" + ",".join(f"{float(v):.10g}" for v in values) + "]"


def create_gemini_client():
    return google_adc.create_gemini_client()


def create_supabase_client():
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def embed_text(
    gemini_client,
    text: str,
    *,
    task_type: str,
    title: Optional[str] = None,
    max_retries: int = 5,
) -> List[float]:
    """
    task_type:
      - RETRIEVAL_DOCUMENT for policy rules being indexed
      - RETRIEVAL_QUERY for Facebook caption/post search query
    """
    if not text or not text.strip():
        raise ValueError("Cannot embed blank text")

    config_kwargs: Dict[str, Any] = {
        "task_type": task_type,
        "output_dimensionality": EMBEDDING_DIMENSION,
    }

    # title is only useful for RETRIEVAL_DOCUMENT
    if title and task_type == "RETRIEVAL_DOCUMENT":
        config_kwargs["title"] = title[:500]

    last_error: Optional[Exception] = None

    for attempt in range(1, max_retries + 1):
        try:
            result = gemini_client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=text,
                config=types.EmbedContentConfig(**config_kwargs),
            )

            embedding = result.embeddings[0].values
            values = [float(x) for x in embedding]

            if len(values) != EMBEDDING_DIMENSION:
                raise RuntimeError(
                    f"Embedding dimension mismatch: got {len(values)}, "
                    f"expected {EMBEDDING_DIMENSION}"
                )

            return values

        except Exception as exc:
            last_error = exc
            sleep_seconds = min(2 ** attempt, 30)
            print(
                f"[WARN] embed failed attempt {attempt}/{max_retries}: {exc}. "
                f"Retrying in {sleep_seconds}s..."
            )
            time.sleep(sleep_seconds)

    raise RuntimeError(f"Embedding failed after retries: {last_error}")


def fetch_embedding_queue(supabase, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    result = supabase.rpc(
        "get_policy_rule_embedding_refresh_queue",
        {
            "embedding_model_filter": EMBEDDING_MODEL_DB_NAME,
        },
    ).execute()

    rows = result.data or []
    if limit is not None:
        rows = rows[:limit]

    return rows


def upsert_rule_embedding(
    supabase,
    *,
    rule_id: str,
    embedding_values: List[float],
) -> None:
    supabase.rpc(
        "upsert_policy_rule_embedding",
        {
            "p_rule_id": rule_id,
            "p_embedding": vector_to_pg_literal(embedding_values),
            "p_embedding_model": EMBEDDING_MODEL_DB_NAME,
        },
    ).execute()


def backfill_embeddings(limit: Optional[int] = None, sleep_between: float = 0.15) -> None:
    require_env()

    gemini_client = create_gemini_client()
    supabase = create_supabase_client()

    queue = fetch_embedding_queue(supabase, limit=limit)

    print(f"Embedding model: {EMBEDDING_MODEL}")
    print(f"DB model name:   {EMBEDDING_MODEL_DB_NAME}")
    print(f"Dimension:       {EMBEDDING_DIMENSION}")
    print(f"Queue size:      {len(queue)}")

    if not queue:
        print("No rules need embedding. Done.")
        return

    for idx, item in enumerate(queue, start=1):
        rule_id = item["rule_id"]
        retrieval_text = item["retrieval_text"]
        metadata = item.get("metadata") or {}
        title = (
            metadata.get("short_title")
            or metadata.get("normalized_concept")
            or metadata.get("type_id")
            or str(rule_id)
        )

        print(f"[{idx}/{len(queue)}] Embedding rule_id={rule_id} title={title!r}")

        values = embed_text(
            gemini_client,
            retrieval_text,
            task_type="RETRIEVAL_DOCUMENT",
            title=str(title),
        )

        upsert_rule_embedding(
            supabase,
            rule_id=rule_id,
            embedding_values=values,
        )

        if sleep_between > 0:
            time.sleep(sleep_between)

    print("Backfill complete.")


def search_policy_rules(
    text: str,
    *,
    final_match_count: int = 100,
    vector_candidate_count: int = 150,
    policy_type_filter: Optional[str] = None,
    rule_status_filter: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Return policy_rules rows ranked by hybrid keyword/vector relevance."""
    require_env()

    gemini_client = create_gemini_client()
    supabase = create_supabase_client()

    query_embedding = embed_text(
        gemini_client,
        text,
        task_type="RETRIEVAL_QUERY",
    )

    result = supabase.rpc(
        "match_policy_rules_vector",
        {
            "query_embedding": vector_to_pg_literal(query_embedding),
            "match_count": final_match_count,
            "embedding_model_filter": EMBEDDING_MODEL_DB_NAME,
            "policy_type_filter": policy_type_filter,
            "rule_status_filter": rule_status_filter or DEFAULT_RULE_STATUS_FILTER,
        },
    ).execute()

    return result.data or []


def search_policy_rules_for_prompt(
    text: str,
    *,
    final_match_count: int = 100,
    vector_candidate_count: int = 150,
    policy_type_filter: Optional[str] = None,
    rule_status_filter: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Reusable helper for future policy prompt filtering.

    This intentionally only returns matched policy_rules rows. It does not build
    prompts and is not wired into the current full/API flow yet.
    """
    return search_policy_rules(
        text,
        final_match_count=final_match_count,
        vector_candidate_count=vector_candidate_count,
        policy_type_filter=policy_type_filter,
        rule_status_filter=rule_status_filter,
    )


def summarize_search_rows(rows: List[Dict[str, Any]], *, limit: int = 20) -> List[Dict[str, Any]]:
    """Small, log-friendly shape for inspecting retrieved policy rules."""
    return [
        {
            "rank": index,
            "match_source": row.get("match_source"),
            "similarity": row.get("similarity"),
            "rule_status": row.get("rule_status"),
            "type_id": row.get("type_id"),
            "short_title": row.get("short_title"),
            "ref_display": row.get("ref_display"),
            "rule_text": (row.get("rule_text") or "")[:240],
        }
        for index, row in enumerate(rows[:limit], start=1)
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    backfill_parser = subparsers.add_parser("backfill")
    backfill_parser.add_argument("--limit", type=int, default=None)
    backfill_parser.add_argument("--sleep", type=float, default=0.15)

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("--text", required=True)
    search_parser.add_argument("--final-match-count", type=int, default=100)
    search_parser.add_argument("--vector-candidate-count", type=int, default=150)

    args = parser.parse_args()

    if args.command == "backfill":
        backfill_embeddings(limit=args.limit, sleep_between=args.sleep)

    elif args.command == "search":
        rows = search_policy_rules(
            args.text,
            final_match_count=args.final_match_count,
            vector_candidate_count=args.vector_candidate_count,
        )

        print(f"Matched rules: {len(rows)}")
        for i, row in enumerate(rows[:20], start=1):
            print(
                f"\n{i}. [{row.get('match_source')}] "
                f"sim={row.get('similarity')} "
                f"status={row.get('rule_status')} "
                f"type={row.get('type_id')}"
            )
            print(f"   title: {row.get('short_title')}")
            print(f"   ref:   {row.get('ref_display')}")
            print(f"   rule:  {(row.get('rule_text') or '')[:240]}")

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
