#!/usr/bin/env python3
"""Minimal Gemini Batch API runner for policy caption checks.

This is intentionally separate from the production verification flow. It lets us
prove cost/latency behavior for policy checks before wiring batch mode into the
scheduled worker.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import requests

from env_loader import load_project_env
import policy_rule_checker
import report_parsing
import supabase_db_helper
import verification_flow
from meta_check_db_schema import STATUS_REJECTED, STATUS_VERIFIED, now_iso_bkk


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_OUT_DIR = BASE_DIR / "temp" / "batch_policy"
COMPLETED_STATES = {
    "JOB_STATE_SUCCEEDED",
    "JOB_STATE_FAILED",
    "JOB_STATE_CANCELLED",
    "JOB_STATE_EXPIRED",
    "BATCH_STATE_SUCCEEDED",
    "BATCH_STATE_FAILED",
    "BATCH_STATE_CANCELLED",
    "BATCH_STATE_EXPIRED",
}
SUCCESS_STATES = {"JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"}


load_project_env()


def main() -> int:
    parser = argparse.ArgumentParser(description="Submit/collect Gemini Batch API policy checks.")
    sub = parser.add_subparsers(dest="command", required=True)

    submit = sub.add_parser("submit", help="Create a policy-check batch job from one account.")
    submit.add_argument("--client-id", required=True)
    submit.add_argument("--account", required=True, help="act_<id> or numeric ad account id")
    submit.add_argument(
        "--new-ad-ids",
        default="",
        help="Comma-separated ad IDs from webhook/in-process events. Fetches these ads without ACTIVE filtering.",
    )
    submit.add_argument("--limit", type=int, default=0, help="Limit Gemini groups for a small test batch.")
    submit.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    submit.add_argument("--dry-run", action="store_true", help="Build JSONL/state without uploading/submitting.")
    submit.add_argument("--wait", action="store_true", help="Poll until the batch finishes, then collect and persist.")
    submit.add_argument("--poll-interval", type=int, default=60, help="Seconds between status polls when --wait is set.")
    submit.add_argument("--timeout", type=int, default=7200, help="Max seconds to wait for batch completion.")
    submit.add_argument("--no-persist", action="store_true", help="When used with --wait, parse results without DB writes.")
    submit.add_argument(
        "--force-recheck",
        action="store_true",
        help="Build batch requests even when current DB rows already have reusable policy results.",
    )

    status = sub.add_parser("status", help="Fetch a Gemini batch job status.")
    status.add_argument("--state", required=True, help="Path to state JSON from submit.")

    collect = sub.add_parser("collect", help="Download completed batch output and persist policy results.")
    collect.add_argument("--state", required=True, help="Path to state JSON from submit.")
    collect.add_argument("--output-file", default="", help="Optional existing result JSONL path.")
    collect.add_argument("--no-persist", action="store_true", help="Parse results without writing DB rows.")

    args = parser.parse_args()
    if args.command == "submit":
        return submit_batch(args)
    if args.command == "status":
        return print_status(args)
    if args.command == "collect":
        return collect_batch(args)
    raise RuntimeError(f"Unsupported command: {args.command}")


def submit_batch(args: argparse.Namespace) -> int:
    api_key = require_env("GEMINI_API_KEY")
    account_act = normalize_act_id(args.account)
    account_num = int(account_act.replace("act_", ""))
    run_id = str(uuid.uuid4())
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"batch_policy_submit_start client_id={args.client_id} account={account_act} run_id={run_id}")
    snapshot_before = supabase_db_helper.fetch_meta_check_db_snapshot(args.client_id, account_num)
    new_ad_ids = parse_csv_values(args.new_ad_ids)
    if new_ad_ids:
        print(f"batch_policy_new_ad_ids count={len(new_ad_ids)} active_filter=false")
    fetched = verification_flow.fetch_ads_for_client(
        args.client_id,
        [account_act],
        verification_flow._token(),
        new_ad_ids=new_ad_ids,
    )
    snapshot_after = verification_flow.sync_fetched_ads_to_db(
        snapshot_before,
        fetched,
        args.client_id,
        account_num,
        uuid.UUID(run_id),
    )
    fetch_map = {norm["ad_id"]: (ad, cr) for norm, ad, cr in fetched if norm.get("ad_id")}
    text_result_lookup = verification_flow._build_text_result_lookup(snapshot_after)
    text_groups = verification_flow._client_text_groups_by_caption(args.client_id, snapshot_after)

    gemini_groups = []
    reuse_groups = []
    for text_key, recs in text_groups:
        if args.force_recheck:
            queued = recs
            rep = verification_flow._pick_representative_for_text_assessment(recs, fetch_map, queued)
            gemini_groups.append((text_key, recs, rep))
            continue
        if not verification_flow._text_group_needs_work(recs, snapshot_before, text_key, text_result_lookup):
            continue
        queued = [r for r in recs if verification_flow._should_queue_text_assessment(r, snapshot_before)]
        if queued and text_key not in text_result_lookup:
            rep = verification_flow._pick_representative_for_text_assessment(recs, fetch_map, queued)
            gemini_groups.append((text_key, recs, rep))
        else:
            reuse_groups.append((text_key, recs))

    if args.limit and args.limit > 0:
        gemini_groups = gemini_groups[: args.limit]

    raw_prompt = policy_rule_checker.read_prompt_template()
    supabase_url = policy_rule_checker.get_required_env("SUPABASE_URL")
    supabase_key = policy_rule_checker.get_supabase_key()
    quick_reference_block = policy_rule_checker.build_quick_reference_block()
    task_instruction = policy_rule_checker.build_task_instruction_caption_only()

    requests_path = out_dir / f"batch-policy-{account_num}-{run_id}.jsonl"
    state_path = out_dir / f"batch-policy-{account_num}-{run_id}.state.json"
    mapping: dict[str, Any] = {}
    with requests_path.open("w", encoding="utf-8") as f:
        for index, (text_key, recs, rep) in enumerate(gemini_groups, start=1):
            key = f"{account_num}:{index}"
            ad_id = rep.get("ad_id") or recs[0].get("ad_id") or ""
            ad_name = ""
            if ad_id in fetch_map:
                ad_obj, _ = fetch_map[ad_id]
                ad_name = (ad_obj.get("name") or "")[:200]
            policy_rows, retrieval_meta = policy_rule_checker.get_policy_rules_for_caption(
                text_key,
                supabase_url=supabase_url,
                supabase_key=supabase_key,
            )
            rules_block = policy_rule_checker.build_rules_block(
                policy_rows,
                max_rules=policy_rule_checker.RULES_BLOCK_MAX_RULES,
            )
            prompt_text = policy_rule_checker.build_prompt_text(
                raw_prompt,
                rules_block=rules_block,
                quick_reference_block=quick_reference_block,
                message="",
            )
            system_instruction = "\n".join([prompt_text, "", task_instruction])
            payload = policy_rule_checker.build_gemini_payload(
                [{"text": f"=== INPUT_MESSAGE START ===\n{text_key}\n=== INPUT_MESSAGE END ==="}],
                system_instruction=system_instruction,
            )
            f.write(json.dumps({"key": key, "request": payload}, ensure_ascii=False) + "\n")
            mapping[key] = {
                "text_key": text_key,
                "representative_ad_id": ad_id,
                "representative_ad_name": ad_name,
                "policy_rule_count": len(policy_rows),
                "policy_rule_retrieval": retrieval_meta,
                "records": recs,
            }

    reused_records = persist_reuse_groups(reuse_groups, text_result_lookup, run_id)

    state = {
        "kind": "batch_policy_state",
        "created_at": now_iso_bkk(),
        "run_id": run_id,
        "client_id": args.client_id,
        "account": account_act,
        "account_num": account_num,
        "model": policy_rule_checker.MODEL_ID,
        "request_count": len(mapping),
        "reuse_group_count": len(reuse_groups),
        "reused_record_count": reused_records,
        "requests_path": str(requests_path),
        "mapping": mapping,
        "batch": None,
        "uploaded_file": None,
        "dry_run": bool(args.dry_run),
    }

    if not mapping:
        write_json(state_path, state)
        print(json.dumps({"ok": True, "state_path": str(state_path), "request_count": 0}, ensure_ascii=False, indent=2))
        return 0

    if not args.dry_run:
        uploaded_file = upload_jsonl_file(api_key, requests_path, f"batch-policy-{account_num}-{run_id}")
        batch = create_batch_job(api_key, uploaded_file["name"], f"batch-policy-{account_num}-{run_id}")
        state["uploaded_file"] = uploaded_file
        state["batch"] = batch

    write_json(state_path, state)
    summary = {
        "ok": True,
        "dry_run": bool(args.dry_run),
        "state_path": str(state_path),
        "requests_path": str(requests_path),
        "request_count": len(mapping),
        "reuse_group_count": len(reuse_groups),
        "batch_name": (state.get("batch") or {}).get("name"),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.wait and not args.dry_run:
        wait_summary = wait_collect_batch(
            state_path,
            poll_interval=max(1, int(args.poll_interval)),
            timeout_seconds=max(1, int(args.timeout)),
            persist=not args.no_persist,
        )
        print(json.dumps({"ok": True, **summary, **wait_summary}, ensure_ascii=False, indent=2))
    return 0


def print_status(args: argparse.Namespace) -> int:
    api_key = require_env("GEMINI_API_KEY")
    state = read_json(Path(args.state))
    batch_name = ((state.get("batch") or {}).get("name") or "").strip()
    if not batch_name:
        print(json.dumps({"ok": False, "error": "state has no batch.name", "state": args.state}, indent=2))
        return 1
    status = get_batch_status(api_key, batch_name)
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0


def collect_batch(args: argparse.Namespace) -> int:
    api_key = require_env("GEMINI_API_KEY")
    state_path = Path(args.state)
    state = read_json(state_path)
    output_path = Path(args.output_file) if args.output_file else None
    if output_path is None:
        batch_name = ((state.get("batch") or {}).get("name") or "").strip()
        if not batch_name:
            raise RuntimeError("State has no batch.name. Pass --output-file for dry-run/offline parsing.")
        status = get_batch_status(api_key, batch_name)
        batch_state = get_batch_state(status)
        if batch_state not in COMPLETED_STATES:
            print(json.dumps({"ok": False, "state": batch_state, "message": "batch_not_complete"}, indent=2))
            return 1
        if batch_state not in SUCCESS_STATES:
            print(json.dumps({"ok": False, "state": batch_state, "error": status.get("error")}, ensure_ascii=False, indent=2))
            return 1
        result_file = get_result_file_name(status)
        if not result_file:
            raise RuntimeError("Batch succeeded but no dest.fileName was found.")
        output_path = Path(state.get("requests_path", "batch-output.jsonl")).with_suffix(".results.jsonl")
        output_path.write_bytes(download_file(api_key, result_file))

    persisted = parse_and_persist_results(state, output_path, persist=not args.no_persist)
    state["collected_at"] = now_iso_bkk()
    state["output_path"] = str(output_path)
    state["collect_summary"] = persisted
    write_json(state_path, state)
    print(json.dumps({"ok": True, "output_path": str(output_path), **persisted}, ensure_ascii=False, indent=2))
    return 0


def wait_collect_batch(
    state_path: Path,
    *,
    poll_interval: int,
    timeout_seconds: int,
    persist: bool,
) -> dict[str, Any]:
    api_key = require_env("GEMINI_API_KEY")
    state = read_json(state_path)
    batch_name = ((state.get("batch") or {}).get("name") or "").strip()
    if not batch_name:
        raise RuntimeError("State has no batch.name; cannot wait for batch completion.")

    started = time.monotonic()
    status: dict[str, Any] = {}
    batch_state = ""
    while True:
        status = get_batch_status(api_key, batch_name)
        batch_state = get_batch_state(status)
        elapsed = int(time.monotonic() - started)
        print(f"batch_policy_wait state={batch_state or 'unknown'} elapsed_sec={elapsed}")
        if batch_state in COMPLETED_STATES:
            break
        if elapsed >= timeout_seconds:
            state["last_status"] = status
            write_json(state_path, state)
            raise TimeoutError(f"Batch did not complete within {timeout_seconds}s: {batch_state}")
        time.sleep(poll_interval)

    state["last_status"] = status
    if batch_state not in SUCCESS_STATES:
        write_json(state_path, state)
        raise RuntimeError(f"Batch finished without success: {batch_state}: {status.get('error')}")

    result_file = get_result_file_name(status)
    if not result_file:
        raise RuntimeError("Batch succeeded but no result file was found.")
    output_path = Path(state.get("requests_path", "batch-output.jsonl")).with_suffix(".results.jsonl")
    output_path.write_bytes(download_file(api_key, result_file))
    persisted = parse_and_persist_results(state, output_path, persist=persist)
    state["collected_at"] = now_iso_bkk()
    state["output_path"] = str(output_path)
    state["collect_summary"] = persisted
    write_json(state_path, state)

    duration_sec = batch_duration_seconds(status)
    return {
        "batch_state": batch_state,
        "batch_duration_sec": duration_sec,
        "batch_duration_human": format_duration(duration_sec) if duration_sec is not None else None,
        "output_path": str(output_path),
        **persisted,
    }


def persist_reuse_groups(
    reuse_groups: list[tuple[str, list[dict[str, Any]]]],
    text_result_lookup: dict[str, tuple[str, dict]],
    run_id: str,
) -> int:
    records = []
    checked = now_iso_bkk()
    for text_key, recs in reuse_groups:
        reused = text_result_lookup.get(text_key)
        if not reused:
            continue
        final_status, ar = reused
        for rec in recs:
            rec["checked_at"] = checked
            rec["text_check_status"] = final_status
            rec["text_assessment_result"] = ar
            records.append(rec)
    if records:
        supabase_db_helper.upsert_meta_check_db_rows(records, run_id)
    return len(records)


def parse_and_persist_results(state: dict[str, Any], output_path: Path, *, persist: bool) -> dict[str, Any]:
    mapping = state.get("mapping") or {}
    rows_to_persist = []
    ok_count = 0
    error_count = 0
    checked = now_iso_bkk()
    for line_no, raw_line in enumerate(output_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        item = json.loads(raw_line)
        key = extract_result_key(item)
        group = mapping.get(key)
        if not group:
            error_count += 1
            continue
        if item.get("error"):
            ar = {
                "mode": "policy_only",
                "error": json.dumps(item.get("error"), ensure_ascii=False),
                "original_caption": group.get("text_key") or "",
            }
            final_status = STATUS_REJECTED
        else:
            parsed = parse_batch_response_json(item)
            if parsed is None:
                ar = {
                    "mode": "policy_only",
                    "parse_error": "no valid JSON in batch response",
                    "raw_response": json.dumps(item, ensure_ascii=False)[:50000],
                    "original_caption": group.get("text_key") or "",
                }
                final_status = STATUS_REJECTED
            else:
                text = group.get("text_key") or ""
                normalized = report_parsing.normalize_policy_v2_result(parsed, text)
                has_action = report_parsing.needs_policy_action(normalized)
                final_status = STATUS_REJECTED if has_action else STATUS_VERIFIED
                ar = {
                    "ad_id": group.get("representative_ad_id") or "",
                    "ad_name": group.get("representative_ad_name") or "",
                    "mode": "policy_only",
                    "raw_response": json.dumps(item, ensure_ascii=False)[:50000],
                    "parsed": parsed,
                    "normalized": normalized,
                    "original_caption": text,
                    "batch_key": key,
                }
        for rec in group.get("records") or []:
            rec["checked_at"] = checked
            rec["text_check_status"] = final_status
            rec["text_assessment_result"] = ar
            rows_to_persist.append(rec)
        ok_count += 1

    if persist and rows_to_persist:
        supabase_db_helper.upsert_meta_check_db_rows(rows_to_persist, state.get("run_id"))
        supabase_db_helper.insert_historical_run_rows(
            rows_to_persist,
            state.get("run_id"),
            state.get("client_id") or "",
            int(state.get("account_num")),
        )
    return {
        "parsed_groups": ok_count,
        "unmatched_or_error_lines": error_count,
        "persisted_rows": len(rows_to_persist) if persist else 0,
    }


def parse_batch_response_json(item: dict[str, Any]) -> Optional[dict[str, Any]]:
    response = item.get("response") or item.get("inlineResponse") or item
    parts = (((response.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
    full_text = "\n".join(
        policy_rule_checker.to_clean_string(part.get("text"))
        for part in parts
        if isinstance(part, dict)
    ).strip()
    if not full_text:
        return None
    try:
        return policy_rule_checker.parse_json_lenient(full_text)
    except Exception:
        return None


def extract_result_key(item: dict[str, Any]) -> str:
    return (
        str(item.get("key") or "")
        or str((item.get("metadata") or {}).get("key") or "")
        or str((item.get("request") or {}).get("key") or "")
    )


def upload_jsonl_file(api_key: str, path: Path, display_name: str) -> dict[str, Any]:
    data = path.read_bytes()
    headers = {
        "x-goog-api-key": api_key,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(len(data)),
        "X-Goog-Upload-Header-Content-Type": "application/jsonl",
        "Content-Type": "application/json",
    }
    start = requests.post(
        "https://generativelanguage.googleapis.com/upload/v1beta/files",
        headers=headers,
        data=json.dumps({"file": {"display_name": display_name}}),
        timeout=120,
    )
    raise_for_status_with_body(start, "Gemini upload start failed")
    upload_url = start.headers.get("x-goog-upload-url")
    if not upload_url:
        raise RuntimeError("Gemini upload start did not return x-goog-upload-url")
    upload = requests.post(
        upload_url,
        headers={
            "Content-Length": str(len(data)),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
        data=data,
        timeout=240,
    )
    raise_for_status_with_body(upload, "Gemini upload finalize failed")
    return upload.json().get("file") or upload.json()


def create_batch_job(api_key: str, file_name: str, display_name: str) -> dict[str, Any]:
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{policy_rule_checker.MODEL_ID}:batchGenerateContent",
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        data=json.dumps({
            "batch": {
                "display_name": display_name,
                "input_config": {"file_name": file_name},
            }
        }),
        timeout=120,
    )
    raise_for_status_with_body(response, "Gemini batch create failed")
    return response.json()


def get_batch_status(api_key: str, batch_name: str) -> dict[str, Any]:
    response = requests.get(
        f"https://generativelanguage.googleapis.com/v1beta/{batch_name}",
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        timeout=120,
    )
    raise_for_status_with_body(response, "Gemini batch status failed")
    return response.json()


def download_file(api_key: str, file_name: str) -> bytes:
    direct = requests.get(
        f"https://generativelanguage.googleapis.com/download/v1beta/{file_name}:download?alt=media",
        headers={"x-goog-api-key": api_key},
        timeout=240,
    )
    if direct.ok:
        return direct.content

    meta = requests.get(
        f"https://generativelanguage.googleapis.com/v1beta/{file_name}",
        headers={"x-goog-api-key": api_key},
        timeout=120,
    )
    raise_for_status_with_body(meta, "Gemini file metadata failed")
    file_meta = meta.json().get("file") or meta.json()
    download_uri = file_meta.get("downloadUri") or file_meta.get("download_uri")
    if download_uri:
        response = requests.get(download_uri, headers={"x-goog-api-key": api_key}, timeout=240)
        raise_for_status_with_body(response, "Gemini file download failed")
        return response.content
    raise_for_status_with_body(direct, "Gemini direct file download failed")
    raise RuntimeError(f"Could not download result file: {file_name}")


def get_batch_state(status: dict[str, Any]) -> str:
    return (
        str(status.get("state") or "")
        or str((status.get("metadata") or {}).get("state") or "")
        or str((status.get("batch") or {}).get("state") or "")
    )


def get_result_file_name(status: dict[str, Any]) -> str:
    dest = status.get("dest") or (status.get("batch") or {}).get("dest") or {}
    response = status.get("response") or {}
    metadata_output = ((status.get("metadata") or {}).get("output") or {})
    return str(
        dest.get("fileName")
        or dest.get("file_name")
        or response.get("responsesFile")
        or response.get("responses_file")
        or metadata_output.get("responsesFile")
        or metadata_output.get("responses_file")
        or ""
    )


def batch_duration_seconds(status: dict[str, Any]) -> Optional[int]:
    from datetime import datetime

    meta = status.get("metadata") or {}
    start = parse_rfc3339_datetime(meta.get("createTime"))
    end = parse_rfc3339_datetime(meta.get("endTime"))
    if not start or not end:
        return None
    return max(0, int((end - start).total_seconds()))


def parse_rfc3339_datetime(value: Any):
    from datetime import datetime

    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        if "." in text:
            head, tail = text.split(".", 1)
            tz = "+00:00" if tail.endswith("+00:00") else ""
            frac = tail.replace("+00:00", "")[:6]
            try:
                return datetime.fromisoformat(f"{head}.{frac}{tz}")
            except ValueError:
                return None
        return None


def format_duration(seconds: Optional[int]) -> str:
    if seconds is None:
        return ""
    minutes, sec = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {sec}s"
    if minutes:
        return f"{minutes}m {sec}s"
    return f"{sec}s"


def normalize_act_id(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Missing account id")
    return raw if raw.startswith("act_") else f"act_{raw}"


def parse_csv_values(value: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in str(value or "").split(","):
        clean = item.strip()
        if clean and clean not in seen:
            seen.add(clean)
            out.append(clean)
    return out


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def raise_for_status_with_body(response: requests.Response, label: str) -> None:
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        body = response.text[:4000]
        raise RuntimeError(f"{label}: HTTP {response.status_code}: {body}") from exc


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
