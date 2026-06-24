#!/usr/bin/env python3
"""Run one Meta ad account through the queue-based macmini policy engine."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
LEGACY_DIR = PROJECT_ROOT / "v2.0_run-all-ad-acc"

load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(HERE / ".env", override=False)
sys.path.insert(0, str(LEGACY_DIR))

import creative_utils  # noqa: E402
import meta_api  # noqa: E402
import supabase_db_helper  # noqa: E402
from meta_check_db_schema import STATUS_REJECTED, STATUS_VERIFIED, now_iso_bkk  # noqa: E402

import pipeline  # noqa: E402


def normalize_account(value: str) -> str:
    clean = str(value or "").strip()
    if not clean:
        raise ValueError("account is required")
    return clean if clean.startswith("act_") else f"act_{clean}"


def normalize_caption(value: str) -> str:
    return " ".join(str(value or "").split())


def parse_csv(value: str) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in str(value or "").split(",") if item.strip()))


def fetch_ads(account: str, new_ad_ids: list[str]) -> list[dict[str, Any]]:
    token = os.getenv("META_ACCESS_TOKEN", "")
    if not token:
        raise RuntimeError("META_ACCESS_TOKEN is required")
    if new_ad_ids:
        return meta_api.get_ads_with_creatives_by_ids(
            access_token=token,
            account_id=account,
            ad_ids=new_ad_ids,
        )
    return meta_api.get_active_ads_with_creatives(
        access_token=token,
        account_id=account,
    )


def build_groups(ads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for ad in ads:
        creative = ad.get("creative") or {}
        caption = creative_utils.extract_text(creative)
        key = normalize_caption(caption)
        if not key or key == "(no caption)":
            continue
        group = grouped.setdefault(
            key,
            {"caption": caption, "ads": [], "creative_ids": set()},
        )
        group["ads"].append(ad)
        creative_id = str(creative.get("id") or "").strip()
        if creative_id:
            group["creative_ids"].add(creative_id)
    return list(grouped.values())


def enqueue_group(
    group: dict[str, Any],
    *,
    workflow_run_id: str,
    client_id: str,
    account: str,
    source: str,
) -> str:
    job = {
        "job_source": "slack_alert",
        "input_json": {"caption": group["caption"]},
        "metadata_json": {
            "workflow_run_id": workflow_run_id,
            "client_id": client_id,
            "account_id": account,
            "ad_ids": [str(ad.get("id") or "") for ad in group["ads"] if ad.get("id")],
            "creative_ids": sorted(group["creative_ids"]),
            "source": source or "workflow",
        },
    }
    result = pipeline.get_supabase().table(pipeline.JOBS_TABLE).insert(job).execute()
    rows = result.data or []
    if not rows or not rows[0].get("run_id"):
        raise RuntimeError("macmini_worker_jobs insert returned no run_id")
    return str(rows[0]["run_id"])


def wait_for_jobs(
    job_ids: list[str],
    poll_seconds: int,
    timeout_seconds: int,
) -> dict[str, dict[str, Any]]:
    pending = set(job_ids)
    results: dict[str, dict[str, Any]] = {}
    started = time.monotonic()
    while pending:
        if time.monotonic() - started >= timeout_seconds:
            abort_jobs(
                list(pending),
                f"aborted after timeout waiting for macmini jobs ({timeout_seconds}s)",
            )
            raise TimeoutError(
                f"Timed out waiting for {len(pending)} macmini job(s): {', '.join(sorted(pending))}"
            )
        response = (
            pipeline.get_supabase()
            .table(pipeline.JOBS_TABLE)
            .select("run_id,status,output_json,error_text")
            .in_("run_id", list(pending))
            .execute()
        )
        for row in response.data or []:
            status = str(row.get("status") or "")
            run_id = str(row.get("run_id") or "")
            if status == "success":
                results[run_id] = row.get("output_json") or {}
                pending.discard(run_id)
            elif status in {"error", "aborted"}:
                abort_jobs(
                    [job_id for job_id in pending if job_id != run_id],
                    f"aborted because related macmini job {run_id} ended with status={status}",
                )
                raise RuntimeError(
                    f"macmini job {run_id} ended with status={status}: {row.get('error_text') or ''}"
                )
        if pending:
            pipeline.log(f"waiting macmini jobs pending={len(pending)}/{len(job_ids)}")
            time.sleep(max(1, poll_seconds))
    return results


def abort_jobs(job_ids: list[str], reason: str) -> None:
    ids = [job_id for job_id in job_ids if job_id]
    if not ids:
        return
    (
        pipeline.get_supabase()
        .table(pipeline.JOBS_TABLE)
        .update(
            {
                "status": "aborted",
                "error_text": reason[:5000],
                "finished_at": pipeline._now_iso(),
            }
        )
        .in_("run_id", ids)
        .in_("status", ["pending", "running"])
        .execute()
    )


def adapt_output(
    output: dict[str, Any],
    caption: str,
    job_run_id: str,
) -> tuple[str, dict[str, Any]]:
    raw_output = output
    analysis = output.get("caption_analysis") or output.get("analysis")
    if isinstance(analysis, dict):
        output = analysis
    policy_items = [
        item for item in (output.get("policy_check") or []) if isinstance(item, dict)
    ]
    spell_items = [
        item
        for item in ((output.get("spell_check") or {}).get("items") or [])
        if isinstance(item, dict)
    ]
    fail_policy_items = [
        item
        for item in policy_items
        if str(item.get("verdict") or "").strip().lower() == "fail"
    ]
    red_flags: list[str] = []
    fix_notes: list[str] = []
    for item in fail_policy_items:
        flag = (
            item.get("flagged_text")
            or item.get("issue_title")
            or item.get("category")
            or ""
        )
        if str(flag).strip():
            red_flags.append(str(flag).strip())
        note = item.get("fix_note") or item.get("issue_detail") or ""
        if str(note).strip():
            fix_notes.append(str(note).strip())

    spell_errors = [
        {
            "type": "misspell",
            "original": item.get("original_text") or "",
            "corrected": item.get("suggested_text") or "",
            "message": item.get("explanation") or "",
            "confidence": item.get("confidence") or "",
        }
        for item in spell_items
    ]
    overall = str(output.get("overall_result") or "").strip().lower()
    rejected = overall == "fail" or bool(fail_policy_items) or bool(spell_errors)
    status = STATUS_REJECTED if rejected else STATUS_VERIFIED
    revised = str(output.get("revised_message") or caption or "").strip()
    caption_analysis = {
        "original_message": output.get("original_message") or caption,
        "revised_message": revised,
        "revised_caption": revised,
        "overall_result": "fail" if fail_policy_items else "pass",
        "summary": output.get("summary") or {},
        "issues": fail_policy_items,
        "policy_context": output.get("policy_context") or {},
    }
    normalized = {
        "verdict": "fail" if fail_policy_items else "pass",
        "matches": {"red": list(dict.fromkeys(red_flags)), "yellow": []},
        "fix_notes": list(dict.fromkeys(fix_notes)),
        "revised_caption": revised,
        "spell_error_level": "error" if spell_errors else "none",
        "spell_total_errors": len(spell_errors),
        "spell_errors": spell_errors,
        "policy_v2": {"caption_analysis": caption_analysis},
    }
    return status, {
        "mode": "macmini_policy_and_spell",
        "worker_job_run_id": job_run_id,
        "parsed": raw_output,
        "normalized": normalized,
        "original_caption": caption,
    }


def load_completed_run(
    workflow_run_id: str,
    account: str,
) -> tuple[list[dict[str, Any]], list[str], dict[str, dict[str, Any]]]:
    response = (
        pipeline.get_supabase()
        .table(pipeline.JOBS_TABLE)
        .select("run_id,status,input_json,output_json,metadata_json,created_at")
        .contains("metadata_json", {"workflow_run_id": workflow_run_id})
        .order("created_at")
        .execute()
    )
    jobs = response.data or []
    if not jobs:
        raise RuntimeError(f"No macmini jobs found for workflow_run_id={workflow_run_id}")
    incomplete = [
        str(job.get("run_id") or "")
        for job in jobs
        if str(job.get("status") or "") != "success"
    ]
    if incomplete:
        raise RuntimeError(
            f"Cannot resume workflow run with incomplete jobs: {', '.join(incomplete)}"
        )

    ad_ids = list(
        dict.fromkeys(
            str(ad_id)
            for job in jobs
            for ad_id in ((job.get("metadata_json") or {}).get("ad_ids") or [])
            if str(ad_id).strip()
        )
    )
    ads = fetch_ads(account, ad_ids)
    ads_by_id = {str(ad.get("id") or ""): ad for ad in ads}
    groups: list[dict[str, Any]] = []
    job_ids: list[str] = []
    outputs: dict[str, dict[str, Any]] = {}
    for job in jobs:
        job_id = str(job.get("run_id") or "")
        metadata = job.get("metadata_json") or {}
        group_ads = [
            ads_by_id[str(ad_id)]
            for ad_id in (metadata.get("ad_ids") or [])
            if str(ad_id) in ads_by_id
        ]
        groups.append(
            {
                "caption": str((job.get("input_json") or {}).get("caption") or ""),
                "ads": group_ads,
                "creative_ids": set(metadata.get("creative_ids") or []),
            }
        )
        job_ids.append(job_id)
        outputs[job_id] = job.get("output_json") or {}
    return groups, job_ids, outputs


def delete_historical_run(workflow_run_id: str) -> None:
    (
        pipeline.get_supabase()
        .table("meta_ad_check_historical_run")
        .delete()
        .eq("run_id", workflow_run_id)
        .execute()
    )


def persist_results(
    *,
    workflow_run_id: str,
    client_id: str,
    account: str,
    groups: list[dict[str, Any]],
    job_ids: list[str],
    outputs: dict[str, dict[str, Any]],
) -> int:
    account_num = int(account.removeprefix("act_"))
    checked_at = now_iso_bkk()
    records: list[dict[str, Any]] = []
    for group, job_id in zip(groups, job_ids):
        status, assessment_result = adapt_output(outputs[job_id], group["caption"], job_id)
        for ad in group["ads"]:
            creative = ad.get("creative") or {}
            records.append(
                {
                    "client_id": client_id,
                    "ad_account_id": account,
                    "ad_account_id_num": account_num,
                    "ad_id": str(ad.get("id") or ""),
                    "creative_id": str(creative.get("id") or ""),
                    "ad_text": group["caption"],
                    "ad_link": "",
                    "created_at": ad.get("created_time") or "",
                    "updated_at": ad.get("updated_time") or "",
                    "checked_at": checked_at,
                    "text_check_status": status,
                    "text_assessment_result": assessment_result,
                    "last_text_check_reported_state": "",
                    "row_sort_key": (
                        str(ad.get("id") or ""),
                        str(creative.get("id") or ""),
                    ),
                }
            )
    supabase_db_helper.upsert_meta_check_db_rows(records, workflow_run_id)
    supabase_db_helper.insert_historical_run_rows(
        records,
        workflow_run_id,
        client_id,
        account_num,
    )
    return len(records)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run an account using macmini_worker_jobs.")
    parser.add_argument("--account", required=True)
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--new-ad-ids", default="")
    parser.add_argument("--source", default="workflow")
    parser.add_argument("--poll-interval", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument(
        "--resume-run-id",
        default="",
        help="Rebuild persistence from completed queue jobs without invoking Gemini again.",
    )
    args = parser.parse_args()

    account = normalize_account(args.account)
    if args.resume_run_id:
        groups, job_ids, outputs = load_completed_run(args.resume_run_id, account)
        delete_historical_run(args.resume_run_id)
        persisted = persist_results(
            workflow_run_id=args.resume_run_id,
            client_id=args.client_id,
            account=account,
            groups=groups,
            job_ids=job_ids,
            outputs=outputs,
        )
        result = {
            "run_id": args.resume_run_id,
            "resumed": True,
            "caption_groups": len(groups),
            "worker_jobs": len(job_ids),
            "persisted_rows": persisted,
        }
        pipeline.log(
            f"macmini account resumed run_id={args.resume_run_id} account={account} "
            f"persisted_rows={persisted}"
        )
        print("RESULT_JSON=" + json.dumps(result, ensure_ascii=False))
        return 0

    new_ad_ids = parse_csv(args.new_ad_ids)
    workflow_run_id = str(uuid.uuid4())
    ads = fetch_ads(account, new_ad_ids)
    groups = build_groups(ads)
    pipeline.log(
        f"macmini account start run_id={workflow_run_id} account={account} "
        f"ads={len(ads)} caption_groups={len(groups)}"
    )
    if not groups:
        print(
            "RESULT_JSON="
            + json.dumps(
                {
                    "run_id": workflow_run_id,
                    "fetched_ads": len(ads),
                    "caption_groups": 0,
                    "persisted_rows": 0,
                }
            )
        )
        return 0

    job_ids = [
        enqueue_group(
            group,
            workflow_run_id=workflow_run_id,
            client_id=args.client_id,
            account=account,
            source=args.source,
        )
        for group in groups
    ]
    outputs = wait_for_jobs(job_ids, args.poll_interval, args.timeout)
    persisted = persist_results(
        workflow_run_id=workflow_run_id,
        client_id=args.client_id,
        account=account,
        groups=groups,
        job_ids=job_ids,
        outputs=outputs,
    )
    result = {
        "run_id": workflow_run_id,
        "fetched_ads": len(ads),
        "caption_groups": len(groups),
        "worker_jobs": len(job_ids),
        "persisted_rows": persisted,
    }
    pipeline.log(
        f"macmini account done run_id={workflow_run_id} account={account} "
        f"persisted_rows={persisted}"
    )
    print("RESULT_JSON=" + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
