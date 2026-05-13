"""
Supabase: queue from meta_adaccounts; meta_ad_check_db (current state);
meta_ad_check_historical_run + meta_ad_check_historical_slack_message (per-run history).

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY) — use a key with RLS/permissions
appropriate for server-side worker use.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

import meta_check_db_schema

# Space-preserved column names on meta_adaccounts (see docs/supabase_db_schema.sql)
COL_ACCOUNT_ID = "Account ID"
COL_ACCOUNT_NAME = "Account name"
COL_STATUS = "Status"
COL_CLIENT = "Client"


def _get_client():
    from supabase import create_client  # type: ignore

    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY") or "").strip()
    if not url or not key:
        raise ValueError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY) are required in the environment"
        )
    return create_client(url, key)


def is_active_status(value: str | None) -> bool:
    return (value or "").strip().lower() == "active"


def list_active_ad_accounts() -> list[dict[str, Any]]:
    """
    All rows in meta_adaccounts with Status = Active (case-insensitive, trimmed).
    Each dict: ad_account_id (int), ad_account_act_id (str act_...), account_name, client, status, raw.
    """
    supabase = _get_client()
    r = supabase.table("meta_adaccounts").select("*").execute()
    out: list[dict[str, Any]] = []
    for row in r.data or []:
        st = row.get(COL_STATUS)
        if not is_active_status(str(st) if st is not None else None):
            continue
        acc_id = row.get(COL_ACCOUNT_ID)
        if acc_id is None:
            continue
        try:
            acc_int = int(acc_id)
        except (TypeError, ValueError):
            continue
        client = (row.get(COL_CLIENT) or "").strip() if row.get(COL_CLIENT) is not None else ""
        name = row.get(COL_ACCOUNT_NAME) or ""
        if isinstance(name, str):
            name = name.strip()
        out.append(
            {
                "ad_account_id": acc_int,
                "ad_account_act_id": f"act_{acc_int}",
                "account_name": name,
                "client_id": client,
                "status": (st or "").strip() if st is not None else "",
                "raw": row,
            }
        )
    return out


def fetch_meta_check_db_snapshot(
    client_id: str, ad_account_id: int,
) -> dict[str, dict[str, Any]]:
    """
    Return map ad_id -> internal record (same keys as meta_check_db row_to_record, minus link fields).
    """
    supabase = _get_client()
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = (
                supabase.table("meta_ad_check_db")
                .select("*")
                .eq("client_id", client_id)
                .eq("ad_account_id", ad_account_id)
                .execute()
            )
            last = None
            break
        except Exception as e:
            last = e
            time.sleep(2**attempt)
    if last is not None:
        raise last

    out: dict[str, dict[str, Any]] = {}
    for row in r.data or []:
        rec = meta_check_db_schema.db_row_to_internal_record(row, ad_account_id)
        aid = rec.get("ad_id") or ""
        if aid:
            out[aid] = rec
    return out


def _record_to_upsert_row(
    rec: dict[str, Any], run_id: str | None
) -> dict[str, Any]:
    """Internal record to meta_ad_check_db; ad_text_assessment_result is jsonb (dict/list or null)."""
    ad_text_ar = rec.get("text_assessment_result")
    if ad_text_ar in (None, ""):
        ad_text_ar = None
    elif isinstance(ad_text_ar, str) and ad_text_ar.strip():
        try:
            ad_text_ar = json.loads(ad_text_ar)
        except (json.JSONDecodeError, TypeError):
            ad_text_ar = None
    elif not isinstance(ad_text_ar, (dict, list)):
        ad_text_ar = None

    client_id = (rec.get("client_id") or "").strip()
    ad_account_num = int(rec["ad_account_id_num"])
    ad_id = (rec.get("ad_id") or "").strip()
    creative_id = (rec.get("creative_id") or "").strip()
    ad_text = rec.get("ad_text") or ""
    ad_created = rec.get("created_at") or None
    ad_updated = rec.get("updated_at") or None
    last_checked = rec.get("checked_at") or None
    text_status = rec.get("text_check_status") or "not_verified"
    if text_status not in ("not_verified", "verified", "rejected", "error"):
        text_status = "not_verified"

    out: dict[str, Any] = {
        "client_id": client_id,
        "ad_account_id": ad_account_num,
        "ad_id": ad_id,
        "creative_id": creative_id,
        "ad_text": ad_text,
        "ad_media": None,
        "ad_created_at": ad_created,
        "ad_updated_at": ad_updated,
        "last_checked_at": last_checked,
        "last_checked_run_id": run_id,
        "ad_text_check_status": text_status,
        "ad_text_assessment_result": ad_text_ar,
        "ad_media_check_status": "not_verified",
        "ad_media_assessment_result": None,
    }
    return out


def upsert_meta_check_db_rows(
    records: list[dict[str, Any]],
    run_id: str | None,
) -> None:
    """Batch upsert internal records into meta_ad_check_db (primary key: client, account, ad, creative)."""
    if not records:
        return
    supabase = _get_client()
    rows = [_record_to_upsert_row(r, run_id) for r in records]
    chunk = 100
    for i in range(0, len(rows), chunk):
        part = rows[i : i + chunk]
        last: Exception | None = None
        for attempt in range(4):
            try:
                supabase.table("meta_ad_check_db").upsert(
                    part,
                    on_conflict="client_id,ad_account_id,ad_id,creative_id",
                ).execute()
                last = None
                break
            except Exception as e:
                last = e
                time.sleep(2**attempt)
        if last is not None:
            raise last


def _rec_to_historical_run_row(
    rec: dict[str, Any], run_id: str, client_id: str, ad_account_id: int
) -> dict[str, Any]:
    """
    One internal assessed rec -> meta_ad_check_historical_run insert row
    (same fields as current-state upsert, plus run_id; ad_account_act_id is generated in DB).
    """
    base = _record_to_upsert_row(rec, run_id)
    return {
        "run_id": run_id,
        "client_id": (client_id or base.get("client_id") or "").strip(),
        "ad_account_id": int(ad_account_id),
        "ad_id": base["ad_id"],
        "creative_id": base["creative_id"],
        "ad_text": base["ad_text"],
        "ad_media": base["ad_media"],
        "ad_created_at": base["ad_created_at"],
        "ad_updated_at": base["ad_updated_at"],
        "last_checked_at": base["last_checked_at"],
        "last_checked_run_id": run_id,
        "ad_text_check_status": base["ad_text_check_status"],
        "ad_text_assessment_result": base["ad_text_assessment_result"],
        "ad_media_check_status": base["ad_media_check_status"],
        "ad_media_assessment_result": base["ad_media_assessment_result"],
    }


def insert_historical_run_rows(
    recs: list[dict[str, Any]],
    run_id: str,
    client_id: str,
    ad_account_id: int,
) -> None:
    """
    Append one row per text-assessed ad in this run to meta_ad_check_historical_run.
    """
    if not recs:
        return
    supabase = _get_client()
    rows = [_rec_to_historical_run_row(r, run_id, client_id, ad_account_id) for r in recs]
    chunk = 100
    for i in range(0, len(rows), chunk):
        part = rows[i : i + chunk]
        last: Exception | None = None
        for attempt in range(4):
            try:
                supabase.table("meta_ad_check_historical_run").insert(part).execute()
                last = None
                break
            except Exception as e:
                last = e
                time.sleep(2**attempt)
        if last is not None:
            raise last


def upsert_historical_slack_message(
    run_id: str,
    client_id: str,
    ad_account_id: int,
    assessed_at: str | None,
    slack_message: dict[str, Any],
) -> None:
    """
    One row per ad-account run: Slack payload (initial + thread_replies) in jsonb.
    """
    supabase = _get_client()
    row: dict[str, Any] = {
        "run_id": run_id,
        "client_id": client_id,
        "ad_account_id": ad_account_id,
        "assessed_at": assessed_at,
        "slack_message": slack_message,
    }
    last: Exception | None = None
    for attempt in range(4):
        try:
            supabase.table("meta_ad_check_historical_slack_message").upsert(
                row,
                on_conflict="run_id",
            ).execute()
            last = None
            break
        except Exception as e:
            last = e
            time.sleep(2**attempt)
    if last is not None:
        raise last
