"""
Per-ad state for text assessment: datetime helpers, status enum, record mapping
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from zoneinfo import ZoneInfo

STATUS_NOT_VERIFIED = "not_verified"
STATUS_VERIFIED = "verified"
STATUS_REJECTED = "rejected"
STATUS_ERROR = "error"


def parse_meta_datetime(s: str | None) -> datetime | None:
    """Parse Meta Graph time strings like 2026-03-13T18:51:50+0700 for comparison."""
    if not s or not str(s).strip():
        return None
    t = str(s).strip()
    if len(t) >= 5 and t[-5] in "+-" and t[-3] != ":":
        t = t[:-2] + ":" + t[-2:]
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError:
        return None


def checked_at_is_before_updated(checked_at: str | None, updated_at: str | None) -> bool:
    """True if ad should be re-checked: updated_at is strictly after checked_at."""
    cu = parse_meta_datetime(updated_at)
    if cu is None:
        return False
    cc = parse_meta_datetime(checked_at)
    if cc is None:
        return True
    return cu > cc


def must_recheck_row(checked_at_str: str | None, updated_at_str: str | None) -> bool:
    """Re-check if never checked or Meta updated_at after last check."""
    if not (checked_at_str or "").strip():
        return True
    return checked_at_is_before_updated(checked_at_str, updated_at_str)


def normalize_status(s: str | None) -> str:
    """
    Normalize status to enum value.
    Unknown values become not_verified so we re-run.
    """
    v = (s or "").strip().lower()
    if v in (STATUS_NOT_VERIFIED, STATUS_VERIFIED, STATUS_REJECTED, STATUS_ERROR):
        return v
    if not v:
        return STATUS_NOT_VERIFIED
    return STATUS_NOT_VERIFIED


def _iso_or_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    # Supabase may return datetime
    s = str(v)
    return s if s else ""


def _assessment_result_from_jsonb(v: Any) -> dict | list | None:
    """ad_text_assessment_result is jsonb: keep dict/list; parse legacy string JSON if needed."""
    if v is None:
        return None
    if isinstance(v, dict):
        return v
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            o = json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return None
        if isinstance(o, (dict, list)):
            return o
        return None
    return None


def db_row_to_internal_record(row: dict[str, Any], ad_account_id_bigint: int) -> dict[str, Any]:
    """
    One meta_ad_check_db API row to internal record (works with ad_account_id = bigint in DB).
    ad_account_id (string) is always act_ form for Meta API / map_ad_row_to_fields.
    """
    n = int(ad_account_id_bigint)
    act = f"act_{n}"
    return {
        "client_id": (row.get("client_id") or "").strip() if row.get("client_id") is not None else "",
        "ad_account_id": act,
        "ad_account_id_num": n,
        "ad_id": (row.get("ad_id") or "").strip() if row.get("ad_id") is not None else "",
        "creative_id": (row.get("creative_id") or "").strip() if row.get("creative_id") is not None else "",
        "ad_text": (row.get("ad_text") or "") if row.get("ad_text") is not None else "",
        "ad_link": "",
        "created_at": _iso_or_str(row.get("ad_created_at")),
        "updated_at": _iso_or_str(row.get("ad_updated_at")),
        "checked_at": _iso_or_str(row.get("last_checked_at")),
        "text_check_status": normalize_status(row.get("ad_text_check_status")),
        "text_assessment_result": _assessment_result_from_jsonb(
            row.get("ad_text_assessment_result")
        ),
        "last_text_check_reported_state": "",
        "row_sort_key": (
            (row.get("ad_id") or "").strip() or "",
            (row.get("creative_id") or "").strip() or "",
        ),
    }


def build_snapshot_by_ad_id(records: list[dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
    """
    Map ad_id -> record. Records must include 'ad_id'.
    (Replaces the old header+grid parsing from Google Sheets.)
    """
    out: dict[str, dict[str, Any]] = {}
    if not records:
        return out
    for rec in records:
        aid = (rec.get("ad_id") or "").strip() if rec.get("ad_id") is not None else ""
        if not aid:
            continue
        out[aid] = rec
    return out


BKK = ZoneInfo("Asia/Bangkok")


def now_iso_bkk() -> str:
    """checked_at format: ISO in Bangkok."""
    return datetime.now(BKK).isoformat(timespec="seconds")
