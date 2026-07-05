"""
Shared infra + orchestration for the mac_mini policy-checker workers.

This module holds only the shared pieces; the actual pipeline logic lives in the
per-step files so each stage is easy to debug:
  step_01_retrieve_rules.py  format input text + retrieve rules
  step_02_build_prompt.py    build the prompt
  step_03_run_llm.py         run LLM + parse JSON
  step_04_recheck.py         re-check / revision loop
  step_05_write_back.py      write result back to Supabase

pipeline provides:
  - env/config + Gemini/Supabase clients
  - small helpers: log, _now_iso, load_prompt, download_image
  - polling helpers: fetch_pending_jobs, claim_job
  - run_pipeline(...) orchestrator (calls step_01..step_04)
  - run_loop(...) used by queue workers (uses step_05 for write-back)

Env (.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
Optional env: GEMINI_AUTH_MODE, GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT,
              GOOGLE_CLOUD_LOCATION, EMBEDDING_MODEL, EMBEDDING_DIMENSION, EMBEDDING_MODEL_DB_NAME,
              LLM_BACKEND, LLM_MODEL, LLM_TEMPERATURE, LLM_SEED,
              OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_REASONING_ENABLED,
              OPENROUTER_TIMEOUT_SECONDS, OPENROUTER_RESPONSE_FORMAT_JSON,
              RULES_MATCH_COUNT, WORKER_POLL_SECONDS
"""
from __future__ import annotations

import os
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

# --- env loading: prefer a local .env, fall back to the shared embedding .env ---
_HERE = Path(__file__).resolve().parent
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _load_env() -> None:
    candidates = [
        _HERE / ".env",
        _HERE.parent / "data_driven" / "02_vector_embedding" / ".env",
    ]
    loaded = False
    for path in candidates:
        if path.exists():
            load_dotenv(path, override=False)
            loaded = True
    if not loaded:
        load_dotenv(override=False)


_load_env()

# --- config ---
GEMINI_AUTH_MODE = os.getenv("GEMINI_AUTH_MODE", "adc").strip().lower()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GOOGLE_CLOUD_PROJECT = (
    os.getenv("GOOGLE_CLOUD_PROJECT")
    or os.getenv("GCLOUD_PROJECT")
    or os.getenv("GCP_PROJECT_ID")
    or ""
)
GOOGLE_CLOUD_LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION") or os.getenv("CLOUD_RUN_REGION") or "us-central1"
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or os.getenv("SUPABASE_SERVICE_KEY")
    or os.getenv("SUPABASE_KEY")
)

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "gemini-embedding-2")
EMBEDDING_DIMENSION = int(os.getenv("EMBEDDING_DIMENSION", "1536"))
EMBEDDING_MODEL_DB_NAME = os.getenv(
    "EMBEDDING_MODEL_DB_NAME", f"{EMBEDDING_MODEL}:{EMBEDDING_DIMENSION}"
)

LLM_BACKEND = os.getenv("LLM_BACKEND", "gemini").strip().lower()
LLM_MODEL = os.getenv("LLM_MODEL", "gemini-2.5-flash")
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.5"))
LLM_SEED = int(os.getenv("LLM_SEED", "42"))
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL") or LLM_MODEL
OPENROUTER_REASONING_ENABLED = (
    os.getenv("OPENROUTER_REASONING_ENABLED", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)
OPENROUTER_TIMEOUT_SECONDS = int(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "90"))
OPENROUTER_RESPONSE_FORMAT_JSON = (
    os.getenv("OPENROUTER_RESPONSE_FORMAT_JSON", "true").strip().lower()
    in {"1", "true", "yes", "on"}
)
OPENROUTER_SITE_URL = os.getenv("OPENROUTER_SITE_URL", "")
OPENROUTER_APP_NAME = os.getenv("OPENROUTER_APP_NAME", "Ad Compliance Worker")

RULES_MATCH_COUNT = int(os.getenv("RULES_MATCH_COUNT", "25"))
WORKER_POLL_SECONDS = int(os.getenv("WORKER_POLL_SECONDS", "30"))
WORKER_CONCURRENCY = int(
    os.getenv("MACMINI_WORKER_CONCURRENCY")
    or os.getenv("WORKER_CONCURRENCY")
    or "1"
)

JOBS_TABLE = "macmini_worker_jobs"
PROMPT_PATH = _HERE / "prompt.txt"

# --- lazy singletons ---
_gemini_client = None
_supabase_client = None
_prompt_template: str | None = None


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_gemini():
    global _gemini_client
    if _gemini_client is None:
        from google import genai

        if GEMINI_AUTH_MODE in {"api-key", "api_key", "apikey"}:
            if not GEMINI_API_KEY:
                raise RuntimeError("GEMINI_API_KEY is required when GEMINI_AUTH_MODE=api_key")
            _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        elif GEMINI_AUTH_MODE in {"adc", "oauth", "application-default", "application_default_credentials"}:
            _gemini_client = create_adc_gemini_client(genai)
        else:
            raise RuntimeError(f"Unsupported GEMINI_AUTH_MODE: {GEMINI_AUTH_MODE}")
    return _gemini_client


def create_adc_gemini_client(genai_module):
    use_vertexai = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    old_gemini_api_key = os.environ.pop("GEMINI_API_KEY", None)
    old_google_api_key = os.environ.pop("GOOGLE_API_KEY", None)
    try:
        if use_vertexai:
            if not GOOGLE_CLOUD_PROJECT:
                raise RuntimeError("GOOGLE_CLOUD_PROJECT is required when GOOGLE_GENAI_USE_VERTEXAI=1")
            return genai_module.Client(
                vertexai=True,
                project=GOOGLE_CLOUD_PROJECT,
                location=GOOGLE_CLOUD_LOCATION,
            )
        return genai_module.Client()
    finally:
        if old_gemini_api_key is not None:
            os.environ["GEMINI_API_KEY"] = old_gemini_api_key
        if old_google_api_key is not None:
            os.environ["GOOGLE_API_KEY"] = old_google_api_key


def get_supabase():
    global _supabase_client
    if _supabase_client is None:
        if not SUPABASE_URL or not SUPABASE_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) are required"
            )
        from supabase import create_client

        _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _supabase_client


def load_prompt() -> str:
    global _prompt_template
    if _prompt_template is None:
        _prompt_template = PROMPT_PATH.read_text(encoding="utf-8")
    return _prompt_template


def download_image(url: str) -> tuple[bytes, str] | None:
    """Return (image_bytes, mime) or None on failure."""
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        log(f"[WARN] image download failed: {exc}")
        return None
    mime = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
    if not mime.startswith("image/"):
        mime = "image/png" if url.lower().endswith(".png") else "image/jpeg"
    return resp.content, mime


def ocr_image(image: tuple[bytes, str] | None) -> str:
    """
    Extract the raw visible text from an image with Gemini (temperature 0, plain text).

    Used only to build the retrieval query for the image run, so the image is
    judged against image-derived policy rules. Returns "" on failure.
    """
    if not image:
        return ""
    image_bytes, mime = image
    from google.genai import types

    instruction = (
        "Extract ALL visible text from the attached image exactly as written, "
        "including Thai and English text, headlines, overlays, watermarks, "
        "disclaimers, fine print, and any numbers or prices. "
        "Output only the raw extracted text with no commentary, labels, or formatting. "
        "If there is no readable text, output an empty string."
    )
    client = get_gemini()
    contents = [
        {
            "role": "user",
            "parts": [
                {"inline_data": {"data": image_bytes, "mime_type": mime}},
                {"text": instruction},
            ],
        }
    ]
    try:
        response = client.models.generate_content(
            model=LLM_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                temperature=0,
                response_mime_type="text/plain",
            ),
        )
    except Exception as exc:  # noqa: BLE001
        log(f"[WARN] image OCR failed: {exc}")
        return ""
    return (response.text or "").strip()


# --- the pure pipeline (no DB writes); delegates to step_01..step_04 ---
def _passed_after_ignore_analysis(ignore_meta: dict[str, Any]) -> dict[str, Any]:
    """Synthetic pass analysis when the client ignore filter leaves no rules to check."""
    return {
        "overall_result": "pass",
        "summary": {
            "overall_verdict": "pass",
            "policy_fail_count": 0,
            "total_issue_count": 0,
        },
        "policy_check": [],
        "_short_circuit": "no_rules_after_client_ignore",
        "_client_ignore": ignore_meta,
    }


def _run_single_analysis(
    query_text: str,
    image: tuple[bytes, str] | None,
    recheck_until_pass: bool,
    max_recheck_attempts: int,
    client_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Run one full assessment (retrieve -> filter -> prompt -> assess -> recheck).

    `query_text` is the retrieval query and the prompt's INPUT_MESSAGE (the caption
    for a caption run, the OCR text for an image run). `image`, when present, is
    attached to the LLM call. When `client_id` is provided, retrieved rules in that
    client's ignore list are dropped in step_01; if none remain, the run short-circuits
    to a pass without calling the LLM. Returns (analysis, run_meta).
    """
    import step_01_retrieve_rules as step_01
    import step_02_build_prompt as step_02
    import step_03_run_llm as step_03
    import step_04_recheck as step_04

    input_text, rows, ignore_meta = step_01.run(query_text, client_id)
    retrieved_rule_count = ignore_meta["retrieved_count"]

    # Slack client ignore filter removed every retrieved rule -> nothing to check.
    if ignore_meta["applied"] and not rows:
        analysis = _passed_after_ignore_analysis(ignore_meta)
        run_meta = {
            "matched_rule_ids": [],
            "rules_match_count": retrieved_rule_count,
            "rules_applicable_count": 0,
            "rule_relevance": {"skipped": True, "reason": "no_rules_after_client_ignore"},
            "client_ignore": ignore_meta,
            "recheck": {
                "enabled": bool(recheck_until_pass),
                "attempts": 1,
                "history": ["pass"],
            },
        }
        return analysis, run_meta

    rows, rule_relevance = step_03.filter_applicable_rules(input_text, rows)
    matched_rule_ids = [r.get("rule_id") for r in rows if r.get("rule_id")]

    prompt = step_02.build_prompt(input_text, rows)
    analysis = step_03.assess(prompt, image)

    attempts = 1
    history = [step_04.verdict_of(analysis)]
    if recheck_until_pass and history[0] == "fail":
        analysis, attempts, history = step_04.recheck(
            analysis, rows, image, max_recheck_attempts
        )
    sanitize_meta = sanitize_policy_issue_rule_ids(analysis, rows)

    run_meta = {
        "matched_rule_ids": matched_rule_ids,
        "rules_match_count": retrieved_rule_count,
        "rules_applicable_count": rule_relevance.get("applicable_count", len(rows)),
        "rule_relevance": rule_relevance,
        "client_ignore": ignore_meta,
        "recheck": {
            "enabled": bool(recheck_until_pass),
            "attempts": attempts,
            "history": history,
        },
        "rule_id_sanitization": sanitize_meta,
    }
    return analysis, run_meta


def sanitize_policy_issue_rule_ids(
    analysis: dict[str, Any] | None,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Resolve, repair, or clear fail issue rule_ids that are not exact retrieved UUIDs.

    The model is instructed to identify rules by rule_index, which the backend
    maps to the canonical UUID from retrieved rows. If older prompts or rechecks
    still emit rule_id directly, accept exact retrieved UUIDs or repair a unique
    near-match among retrieved rules. Otherwise keep the issue visible but clear
    rule_id so downstream ignore flows cannot insert a bad foreign key.
    """
    if not isinstance(analysis, dict):
        return {"resolved_by_index": [], "repaired": [], "cleared": [], "kept": 0}

    issue_lists = find_policy_issue_lists(analysis)
    if not issue_lists:
        return {"resolved_by_index": [], "repaired": [], "cleared": [], "kept": 0}

    index_to_rule_id = {
        i: str(row.get("rule_id") or "").strip()
        for i, row in enumerate(rows, start=1)
        if _UUID_RE.match(str(row.get("rule_id") or "").strip())
    }
    valid_rule_ids = set(index_to_rule_id.values())
    resolved_by_index: list[dict[str, Any]] = []
    repaired: list[dict[str, str]] = []
    cleared: list[dict[str, str]] = []
    kept = 0
    for issue_path, issues in issue_lists:
        kept += len(issues)
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            rule_index = parse_rule_index(issue.get("rule_index"))
            if rule_index is not None:
                canonical_rule_id = index_to_rule_id.get(rule_index)
                if canonical_rule_id:
                    rule_id = str(issue.get("rule_id") or "").strip()
                    if rule_id and rule_id != canonical_rule_id:
                        issue["original_rule_id"] = rule_id
                    issue["rule_id"] = canonical_rule_id
                    resolved_by_index.append(
                        {
                            "path": issue_path,
                            "rule_index": rule_index,
                            "rule_id": canonical_rule_id,
                        }
                    )
                    continue
                issue["invalid_rule_index"] = rule_index

            rule_id = str(issue.get("rule_id") or "").strip()
            if not _UUID_RE.match(rule_id):
                repaired_rule_id = resolve_near_miss_rule_id(rule_id, valid_rule_ids)
                if repaired_rule_id:
                    issue["original_rule_id"] = rule_id
                    issue["rule_id"] = repaired_rule_id
                    repaired.append({"rule_id": rule_id, "repaired_to": repaired_rule_id})
                    continue
                if rule_id:
                    issue["invalid_rule_id"] = rule_id
                    issue["rule_id"] = ""
                    cleared.append({"rule_id": rule_id, "reason": "invalid_uuid"})
                continue
            if rule_id not in valid_rule_ids:
                repaired_rule_id = resolve_near_miss_rule_id(rule_id, valid_rule_ids)
                if repaired_rule_id:
                    issue["original_rule_id"] = rule_id
                    issue["rule_id"] = repaired_rule_id
                    repaired.append({"rule_id": rule_id, "repaired_to": repaired_rule_id})
                    continue
                issue["invalid_rule_id"] = rule_id
                issue["rule_id"] = ""
                cleared.append({"rule_id": rule_id, "reason": "not_in_retrieved_rules"})
                continue
    return {
        "resolved_by_index": resolved_by_index,
        "repaired": repaired,
        "cleared": cleared,
        "kept": kept,
    }


def find_policy_issue_lists(analysis: dict[str, Any]) -> list[tuple[str, list[Any]]]:
    candidates: list[tuple[str, Any]] = [
        ("policy_check", analysis.get("policy_check")),
        ("issues", analysis.get("issues")),
    ]
    caption = analysis.get("caption_analysis")
    if isinstance(caption, dict):
        candidates.extend(
            [
                ("caption_analysis.policy_check", caption.get("policy_check")),
                ("caption_analysis.issues", caption.get("issues")),
            ]
        )
    image = analysis.get("image_analysis")
    if isinstance(image, dict):
        candidates.extend(
            [
                ("image_analysis.policy_check", image.get("policy_check")),
                ("image_analysis.issues", image.get("issues")),
            ]
        )
    return [(path, issues) for path, issues in candidates if isinstance(issues, list)]


def parse_rule_index(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def resolve_near_miss_rule_id(rule_id: str, valid_rule_ids: set[str]) -> str | None:
    """Resolve near-miss rule_id copy errors only when the match is unique."""
    candidate = (rule_id or "").strip()
    if not candidate:
        return None
    if candidate in valid_rule_ids:
        return candidate
    compact = candidate.replace("-", "").lower()
    scored: list[tuple[float, str]] = []
    for valid_rule_id in valid_rule_ids:
        valid_compact = valid_rule_id.replace("-", "").lower()
        if edit_distance_at_most_one(compact, valid_compact):
            scored.append((1.0, valid_rule_id))
            continue
        prefix_len = common_prefix_len(compact, valid_compact)
        ratio = SequenceMatcher(None, compact, valid_compact).ratio()
        if prefix_len >= 24 and ratio >= 0.94:
            scored.append((ratio, valid_rule_id))
    if not scored:
        return None
    scored.sort(reverse=True)
    if len(scored) == 1 or scored[0][0] > scored[1][0]:
        return scored[0][1]
    return None


def common_prefix_len(left: str, right: str) -> int:
    count = 0
    for lchar, rchar in zip(left, right):
        if lchar != rchar:
            break
        count += 1
    return count


def edit_distance_at_most_one(left: str, right: str) -> bool:
    """True when two strings are identical or one insert/delete/substitute apart."""
    if left == right:
        return True
    if abs(len(left) - len(right)) > 1:
        return False
    i = j = edits = 0
    while i < len(left) and j < len(right):
        if left[i] == right[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(left) == len(right):
            i += 1
            j += 1
        elif len(left) < len(right):
            j += 1
        else:
            i += 1
    if i < len(left) or j < len(right):
        edits += 1
    return edits <= 1


def _combine_verdict(*analyses: dict[str, Any] | None) -> str:
    """fail if any present analysis failed, else pass (unknown when none present)."""
    import step_04_recheck as step_04

    verdicts = [step_04.verdict_of(a) for a in analyses if a is not None]
    if not verdicts:
        return "unknown"
    return "fail" if "fail" in verdicts else "pass"


def run_pipeline(
    caption: str,
    image_url: str | None = None,
    recheck_until_pass: bool = False,
    max_recheck_attempts: int = 3,
    process_image: bool = True,
    client_id: str | None = None,
) -> dict[str, Any]:
    """
    Orchestrate the checker: a caption (text) run and, when an image is present and
    `process_image` is enabled, an image run (OCR-retrieved rules + image attached).

    Returns an output_json shaped like the Apps Script wrapper:
      { overall_result, caption_analysis?, image_analysis?, meta }
    No DB access here. `process_image=False` is a hard kill-switch (e.g. Slack).
    `client_id`, when provided (Slack jobs), filters retrieved rules against that
    client's ignore list.
    """
    image = download_image(image_url) if (image_url and process_image) else None
    has_caption = bool((caption or "").strip())

    caption_analysis: dict[str, Any] | None = None
    image_analysis: dict[str, Any] | None = None
    caption_meta: dict[str, Any] | None = None
    image_meta: dict[str, Any] | None = None
    ocr_chars = 0

    if has_caption:
        caption_analysis, caption_meta = _run_single_analysis(
            caption, None, recheck_until_pass, max_recheck_attempts, client_id
        )
    if image is not None:
        ocr_text = ocr_image(image)
        ocr_chars = len(ocr_text)
        image_analysis, image_meta = _run_single_analysis(
            ocr_text, image, recheck_until_pass, max_recheck_attempts, client_id
        )
    if caption_analysis is None and image_analysis is None:
        # blank caption + no usable image: preserve today's behavior (one empty run)
        caption_analysis, caption_meta = _run_single_analysis(
            caption, None, recheck_until_pass, max_recheck_attempts, client_id
        )

    # Surface the caption run's retrieval fields at top level (image run as fallback)
    # so existing meta consumers keep working; nest image run details under image_run.
    primary_meta = caption_meta or image_meta or {}
    meta: dict[str, Any] = {
        "llm_backend": LLM_BACKEND,
        "llm_model": LLM_MODEL,
        "llm_temperature": LLM_TEMPERATURE,
        "llm_seed": LLM_SEED,
        "embedding_model": EMBEDDING_MODEL_DB_NAME,
        "matched_rule_ids": primary_meta.get("matched_rule_ids", []),
        "rules_match_count": primary_meta.get("rules_match_count", 0),
        "rules_applicable_count": primary_meta.get("rules_applicable_count", 0),
        "rule_relevance": primary_meta.get("rule_relevance", {}),
        "client_ignore": primary_meta.get("client_ignore", {}),
        "process_image": bool(process_image),
        "image_used": image is not None,
        "recheck": primary_meta.get(
            "recheck", {"enabled": bool(recheck_until_pass), "attempts": 1, "history": []}
        ),
    }
    if image_meta is not None:
        meta["image_run"] = {**image_meta, "ocr_chars": ocr_chars}

    out: dict[str, Any] = {
        "overall_result": _combine_verdict(caption_analysis, image_analysis),
        "meta": meta,
    }
    if caption_analysis is not None:
        out["caption_analysis"] = caption_analysis
    if image_analysis is not None:
        out["image_analysis"] = image_analysis
    return out


# --- polling helpers ---
def fetch_pending_jobs(job_source: str, limit: int = 10) -> list[dict[str, Any]]:
    supabase = get_supabase()
    result = (
        supabase.table(JOBS_TABLE)
        .select("*")
        .eq("status", "pending")
        .eq("job_source", job_source)
        .order("created_at")
        .limit(limit)
        .execute()
    )
    return result.data or []


def claim_job(run_id: str) -> bool:
    """Atomically flip pending -> running. Returns True if this worker won the row."""
    supabase = get_supabase()
    result = (
        supabase.table(JOBS_TABLE)
        .update({"status": "running", "started_at": _now_iso()})
        .eq("run_id", run_id)
        .eq("status", "pending")
        .execute()
    )
    return bool(result.data)


def _process_claimed_job(job: dict[str, Any], extract_input, on_complete=None) -> None:
    import step_05_write_back as step_05

    run_id = job.get("run_id")
    log(f"processing run_id={run_id}")
    try:
        inp = extract_input(job)
        output = run_pipeline(
            inp.get("caption") or "",
            inp.get("image_url"),
            bool(inp.get("recheck_until_pass", False)),
            int(inp.get("max_recheck_attempts", 3)),
            process_image=bool(inp.get("process_image", True)),
            client_id=inp.get("client_id"),
        )
        step_05.complete(run_id, output)
        log(f"done run_id={run_id} result={output.get('overall_result')}")
        if on_complete is not None:
            try:
                on_complete(job, output)
            except Exception as exc:  # noqa: BLE001
                log(f"[WARN] on_complete failed for run_id={run_id}: {exc}")
    except Exception as exc:  # noqa: BLE001
        log(f"[ERROR] run_id={run_id} failed: {exc}")
        try:
            step_05.fail(run_id, traceback.format_exc())
        except Exception as inner:  # noqa: BLE001
            log(f"[ERROR] could not mark run_id={run_id} as error: {inner}")


def run_loop(
    job_source: str,
    extract_input,
    on_complete=None,
    concurrency: int | None = None,
) -> None:
    """
    Poll macmini_worker_jobs for one job_source, claim + process each pending row,
    write output_json on success (step_05.complete) or error_text on failure
    (step_05.fail), and sleep when idle.

    extract_input(job: dict) -> dict with keys:
      caption (str), image_url (str|None),
      recheck_until_pass (bool, optional), max_recheck_attempts (int, optional),
      process_image (bool, optional; default True),
      client_id (str|None, optional; Slack jobs filter rules via the ignore list)

    concurrency (int, optional): max claimed jobs processed at once. Default is
    env `MACMINI_WORKER_CONCURRENCY` / `WORKER_CONCURRENCY`, otherwise 1.

    on_complete(job: dict, output: dict) -> Any (optional): called after a job is
    written back to Supabase. Failures here only log a warning and never fail the
    job because Supabase already holds the result.
    """
    worker_count = max(1, int(concurrency or WORKER_CONCURRENCY or 1))
    log(
        f"worker started for job_source={job_source} "
        f"concurrency={worker_count} (poll every {WORKER_POLL_SECONDS}s)"
    )
    while True:
        try:
            jobs = fetch_pending_jobs(job_source, limit=max(10, worker_count))
        except Exception as exc:  # noqa: BLE001
            log(f"[ERROR] fetch_pending_jobs failed: {exc}")
            time.sleep(WORKER_POLL_SECONDS)
            continue

        if not jobs:
            time.sleep(WORKER_POLL_SECONDS)
            continue

        claimed_jobs: list[dict[str, Any]] = []
        for job in jobs:
            run_id = job.get("run_id")
            if not run_id or not claim_job(run_id):
                continue
            claimed_jobs.append(job)
            if len(claimed_jobs) >= worker_count:
                break

        if not claimed_jobs:
            continue

        if worker_count == 1 or len(claimed_jobs) == 1:
            for job in claimed_jobs:
                _process_claimed_job(job, extract_input, on_complete)
            continue

        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [
                executor.submit(_process_claimed_job, job, extract_input, on_complete)
                for job in claimed_jobs
            ]
            for future in as_completed(futures):
                future.result()
