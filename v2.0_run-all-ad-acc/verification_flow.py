"""
Meta ad check: Supabase meta_ad_check_db snapshot, Meta sync, text assessment, Slack on status changes.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from typing import Any

import assessment_single_ad
import creative_utils
import main as main_module
import meta_api
import report_parsing
import supabase_db_helper
from meta_check_db_schema import (
    STATUS_NOT_VERIFIED,
    STATUS_REJECTED,
    STATUS_VERIFIED,
    must_recheck_row,
    now_iso_bkk,
)
from slack_send_message import (
    SLACK_DEBUG_CHANNEL,
    format_slack_user_mention_line,
    send_slack_report,
)


def _is_debug_mode() -> bool:
    return os.environ.get("META_ADS_DEBUG", "").strip().upper() in ("1", "TRUE", "YES")


def _is_force_text_recheck() -> bool:
    return os.environ.get("FORCE_TEXT_RECHECK", "").strip().upper() in ("1", "TRUE", "YES")


def _token() -> str:
    t = os.environ.get("META_ACCESS_TOKEN", "")
    if not t:
        raise ValueError("META_ACCESS_TOKEN environment variable is required for Meta API")
    return t


def fetch_ads_for_client(
    client_id: str, account_ids: list[str], access_token: str, new_ad_ids: list[str] | None = None
) -> list[tuple[dict[str, Any], dict, dict]]:
    """
    Ads with embedded creatives (id, name, body on nested creative).
    Scheduled runs fetch active ads. Webhook/new-ad runs fetch explicit IDs
    without ACTIVE filtering because in-process ads are usually PENDING_REVIEW.
    Returns list of (normalized map, ad dict, creative dict).
    """
    out: list[tuple[dict[str, Any], dict, dict]] = []
    started = time.time()
    total_ads = 0
    for account_id in account_ids:
        account_started = time.time()
        fetch_mode = "new_ad_ids" if new_ad_ids else "active"
        creative_utils.print_log(f"meta_fetch_start account_id={account_id} mode={fetch_mode}")
        ads = (
            meta_api.get_ads_with_creatives_by_ids(
                access_token=access_token,
                account_id=account_id,
                ad_ids=new_ad_ids,
            )
            if new_ad_ids
            else meta_api.get_active_ads_with_creatives(access_token=access_token, account_id=account_id)
        )
        creative_utils.print_log(
            f"meta_fetch_done account_id={account_id} fetched={len(ads)} elapsed_sec={time.time() - account_started:.2f}"
        )
        for ad in ads:
            ad.setdefault("status", ad.get("effective_status"))
            creative_detail = ad.get("creative") or {}
            if not creative_detail.get("id"):
                continue
            norm = main_module.map_ad_row_to_fields(client_id, account_id, ad)
            if (norm.get("ad_text") or "").strip() == "(no caption)":
                creative_utils.print_log(
                    f"skip_no_caption client_id={client_id} account_id={account_id} ad_id={norm.get('ad_id','')}"
                )
                continue
            out.append((norm, ad, dict(creative_detail)))
        total_ads += len(ads)
    creative_utils.print_log(
        f"meta_fetch_summary client_id={client_id} accounts={len(account_ids)} total_ads={total_ads} elapsed_sec={time.time() - started:.2f}"
    )
    return out


def _new_internal_record_from_norm(
    norm: dict[str, Any], client_id: str, ad_account_id_num: int
) -> dict[str, Any]:
    ad_id = norm["ad_id"]
    return {
        "client_id": client_id,
        "ad_account_id": norm["ad_account_id"],
        "ad_account_id_num": ad_account_id_num,
        "ad_id": ad_id,
        "creative_id": norm.get("creative_id") or "",
        "ad_text": norm.get("ad_text") or "",
        "ad_link": norm.get("ad_link") or "",
        "created_at": norm.get("created_at") or "",
        "updated_at": norm.get("updated_at") or "",
        "checked_at": "",
        "text_check_status": STATUS_NOT_VERIFIED,
        "text_assessment_result": None,
        "last_text_check_reported_state": "",
        "row_sort_key": (ad_id, (norm.get("creative_id") or "")),
    }


def _should_force_text_recheck(prev: dict[str, Any], norm: dict[str, Any]) -> bool:
    if _is_force_text_recheck():
        return True
    if must_recheck_row(prev.get("checked_at"), norm["updated_at"]):
        return True
    if (prev.get("creative_id") or "") != (norm.get("creative_id") or ""):
        return True
    if (prev.get("ad_text") or "").strip() != (norm.get("ad_text") or "").strip():
        return True
    return False


def _should_queue_text_assessment(
    rec: dict[str, Any], snapshot_before: dict[str, dict[str, Any]]
) -> bool:
    """
    True if this row should run text assessment: not_verified, has caption, and either
    new this cycle (no pre-sync row) or same invalidation as sync (_should_force_text_recheck).
    """
    if rec.get("text_check_status") != STATUS_NOT_VERIFIED:
        return False
    if (rec.get("ad_text") or "").strip() == "(no caption)":
        return False
    ad_id = rec.get("ad_id") or ""
    prev = snapshot_before.get(ad_id)
    if prev is None:
        return True
    norm_like = {
        "creative_id": rec.get("creative_id") or "",
        "ad_text": rec.get("ad_text") or "",
        "updated_at": rec.get("updated_at") or "",
    }
    return _should_force_text_recheck(prev, norm_like)


def sync_fetched_ads_to_db(
    snapshot_before: dict[str, dict[str, Any]],
    fetched: list[tuple[dict[str, Any], dict, dict]],
    client_id: str,
    ad_account_id_num: int,
    run_id: uuid.UUID,
) -> dict[str, dict[str, Any]]:
    """Insert/merge from Meta into in-memory map and upsert to Supabase (no link checks)."""
    out: dict[str, dict[str, Any]] = {k: {**v} for k, v in snapshot_before.items()}
    to_upsert: list[dict[str, Any]] = []
    insert_count = 0
    update_count = 0

    for norm, _ad, _cr in fetched:
        if norm["client_id"] != client_id:
            continue
        if (norm.get("ad_text") or "").strip() == "(no caption)":
            creative_utils.print_log(
                f"skip_no_caption_sync client_id={client_id} ad_id={norm.get('ad_id','')}"
            )
            continue
        ad_id = norm["ad_id"]
        if not ad_id:
            continue
        prev = out.get(ad_id)
        if prev is None:
            rec = _new_internal_record_from_norm(norm, client_id, ad_account_id_num)
            to_upsert.append(rec)
            out[ad_id] = rec
            insert_count += 1
            creative_utils.print_log(f"upsert_decision ad_id={ad_id} action=insert")
            continue
        if (prev.get("client_id") or "").strip() != (client_id or "").strip():
            creative_utils.logger.warning(
                "ad_id %s belongs to another client in DB; skipping update", ad_id
            )
            continue

        text_status = prev.get("text_check_status") or STATUS_NOT_VERIFIED
        reasons: list[str] = []
        if not (prev.get("checked_at") or "").strip():
            reasons.append("checked_blank")
        if must_recheck_row(prev.get("checked_at"), norm["updated_at"]):
            reasons.append("updated_after_checked")
        if (prev.get("creative_id") or "") != (norm.get("creative_id") or ""):
            reasons.append("creative_changed")
        if (prev.get("ad_text") or "").strip() != (norm.get("ad_text") or "").strip():
            reasons.append("text_changed")
        if _should_force_text_recheck(prev, norm):
            text_status = STATUS_NOT_VERIFIED
        creative_utils.print_log(
            f"upsert_decision ad_id={ad_id} action=update reasons={','.join(reasons) if reasons else 'none'} text_status={text_status}"
        )

        rec = {
            "client_id": client_id,
            "ad_account_id": norm["ad_account_id"],
            "ad_account_id_num": ad_account_id_num,
            "ad_id": ad_id,
            "creative_id": norm.get("creative_id") or "",
            "ad_text": norm.get("ad_text") or "",
            "ad_link": norm.get("ad_link") or "",
            "created_at": norm.get("created_at") or "",
            "updated_at": norm.get("updated_at") or "",
            "checked_at": prev.get("checked_at") or "",
            "text_check_status": text_status,
            "text_assessment_result": _norm_assessment_tr(prev.get("text_assessment_result")),
            "last_text_check_reported_state": prev.get("last_text_check_reported_state") or "",
            "row_sort_key": (ad_id, (norm.get("creative_id") or "")),
        }
        to_upsert.append(rec)
        out[ad_id] = rec
        update_count += 1

    if to_upsert:
        supabase_db_helper.upsert_meta_check_db_rows(to_upsert, str(run_id))

    creative_utils.print_log(
        f"upsert_summary client_id={client_id} inserts={insert_count} updates={update_count}"
    )
    return out


def _norm_assessment_tr(v: Any) -> dict | list | None:
    """Empty string / None -> None; keep dict/list; parse legacy string JSON once."""
    if v is None or v == "":
        return None
    if isinstance(v, (dict, list)):
        return v
    if isinstance(v, str) and v.strip():
        try:
            o = json.loads(v)
        except (json.JSONDecodeError, TypeError):
            return None
        if isinstance(o, (dict, list)):
            return o
        return None
    return None


def _as_assessment_dict_for_reuse(v: Any) -> dict | None:
    """Caption reuse lookup: need a single dict; ignore lists."""
    t = _norm_assessment_tr(v)
    if isinstance(t, dict):
        return t
    return None


def _build_text_result_lookup(
    snapshot: dict[str, dict[str, Any]],
) -> dict[str, tuple[str, dict]]:
    """
    Build lookup: normalized ad_text -> (text_check_status, assessment_result_dict)
    using already-assessed rows only.
    """
    out: dict[str, tuple[str, dict]] = {}
    for rec in snapshot.values():
        text = (rec.get("ad_text") or "").strip()
        status = (rec.get("text_check_status") or "").strip()
        ar = _as_assessment_dict_for_reuse(rec.get("text_assessment_result"))
        if not text:
            continue
        if status not in (STATUS_VERIFIED, STATUS_REJECTED):
            continue
        if ar is None:
            continue
        if text not in out:
            out[text] = (status, ar)
    return out


def _is_valid_caption_for_text_group(rec: dict[str, Any]) -> bool:
    t = (rec.get("ad_text") or "").strip()
    return bool(t) and t != "(no caption)"


def _client_text_groups_by_caption(
    client_id: str, snapshot: dict[str, dict[str, Any]]
) -> list[tuple[str, list[dict[str, Any]]]]:
    g: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rec in snapshot.values():
        if (rec.get("client_id") or "").strip() != (client_id or "").strip():
            continue
        if not _is_valid_caption_for_text_group(rec):
            continue
        k = (rec.get("ad_text") or "").strip()
        g[k].append(rec)
    out: list[tuple[str, list[dict[str, Any]]]] = []
    for k in sorted(g.keys()):
        recs = sorted(
            g[k], key=lambda r: (r.get("row_sort_key") or (r.get("ad_id", ""), r.get("creative_id", "")))
        )
        out.append((k, recs))
    return out


def _text_group_needs_work(
    recs: list[dict[str, Any]],
    snapshot_before: dict[str, dict[str, Any]],
    text_key: str,
    text_result_lookup: dict[str, tuple[str, dict]],
) -> bool:
    if any(_should_queue_text_assessment(r, snapshot_before) for r in recs):
        return True
    if text_key in text_result_lookup and any(
        (r.get("text_check_status") or "") == STATUS_NOT_VERIFIED for r in recs
    ):
        return True
    return False


def _pick_representative_for_text_assessment(
    recs: list[dict[str, Any]],
    fetch_map: dict[str, tuple[dict, dict]],
    queued: list[dict[str, Any]],
) -> dict[str, Any]:
    def sk(r: dict[str, Any]) -> tuple:
        return (r.get("row_sort_key") or (r.get("ad_id", ""), r.get("creative_id", "")))

    if queued:
        with_fetch = [r for r in queued if (r.get("ad_id") or "") in fetch_map]
        if with_fetch:
            return sorted(with_fetch, key=sk)[0]
        return sorted(queued, key=sk)[0]
    with_fetch = [r for r in recs if (r.get("ad_id") or "") in fetch_map]
    if with_fetch:
        return sorted(with_fetch, key=sk)[0]
    return sorted(recs, key=sk)[0]


def _text_transition_action(transition: str) -> str | None:
    if transition in ("not_verified->verified", "verified->verified"):
        return None
    if transition == "not_verified->rejected":
        return "new_issue"
    if transition == "rejected->rejected":
        return "still_failing"
    if transition == "rejected->verified":
        return "fixed"
    if transition == "verified->rejected":
        return "new_error_after_update"
    if transition.endswith("->rejected"):
        return "new_issue"
    return None


def _ads_label(n: int) -> str:
    return "1 Ad" if n == 1 else f"{n} Ads"


def _transition_action_counts(
    transitions: list[tuple],
) -> tuple[int, int]:
    n_action = 0
    n_fixed = 0
    for row in transitions:
        action = row[2]
        if action == "fixed":
            n_fixed += 1
        elif action in ("new_issue", "still_failing", "new_error_after_update"):
            n_action += 1
    return n_action, n_fixed


def _format_check_stream_header(stream_name: str, n_action: int, n_fixed: int) -> str:
    lines: list[str] = []
    if n_action > 0:
        lines.append(f"🚨 _{stream_name}: {_ads_label(n_action)} Action Required_")
    if n_fixed > 0:
        lines.append(f"🟢 _{stream_name}: {_ads_label(n_fixed)} Fixed_")
    return "\n".join(lines) if lines else f"🚨 _{stream_name}: Action Required_"


def _text_check_stream_title(fda_true: bool, spell_true: bool) -> str:
    if fda_true and spell_true:
        return "Spell & Policy Check"
    if fda_true:
        return "Policy Check"
    return "Spell Check"


def _policy_risk_counts_from_text_transitions(
    transitions: list[tuple[str, str, str, dict, str, str]],
) -> tuple[int, int]:
    n_high = 0
    n_some = 0
    seen: set[tuple[str, str]] = set()
    for row in transitions:
        gk = _text_transition_group_key(row)
        if gk in seen:
            continue
        seen.add(gk)
        ar = row[3]
        if not isinstance(ar, dict):
            continue
        mode = ar.get("mode")
        if mode not in ("policy_only", "policy_and_spell"):
            continue
        normalized = ar.get("normalized") or {}
        if not isinstance(normalized, dict):
            continue
        label = report_parsing.standardize_policy_risk_label(normalized)
        if label == "High Risk":
            n_high += 1
        elif label == "Some Risk":
            n_some += 1
    return n_high, n_some


def _format_text_check_stream_header(
    fda_true: bool,
    spell_true: bool,
    transitions: list[tuple[str, str, str, dict, str, str]],
    n_action: int,
    n_fixed: int,
) -> str:
    title = _text_check_stream_title(fda_true, spell_true)
    lines: list[str] = []
    if n_action > 0:
        if fda_true:
            n_high, n_some = _policy_risk_counts_from_text_transitions(transitions)
            lines.append(
                f"🚨 _{title}: {_ads_label(n_action)} Action Required "
                f"({n_high} High risk | {n_some} Some risk)_"
            )
        else:
            lines.append(f"🚨 _{title}: {_ads_label(n_action)} Action Required_")
    if n_fixed > 0:
        lines.append(f"🟢 _{title}: {_ads_label(n_fixed)} Fixed_")
    return "\n".join(lines) if lines else f"🚨 _{title}: Action Required_"


def _text_transition_group_key(
    row: tuple[str, str, str, dict, str, str],
) -> tuple[str, str]:
    _ad_id, _transition, _action, ar, _ad_name, ad_text = row
    text_key = (ad_text or "").strip()
    return (text_key, report_parsing.assessment_payload_key(ar))


def _group_text_transitions(
    transitions: list[tuple[str, str, str, dict, str, str]],
) -> list[list[tuple[str, str, str, dict, str, str]]]:
    groups: dict[tuple[str, str], list[tuple[str, str, str, dict, str, str]]] = {}
    order: list[tuple[str, str]] = []
    for row in transitions:
        k = _text_transition_group_key(row)
        if k not in groups:
            order.append(k)
            groups[k] = []
        groups[k].append(row)
    return [groups[k] for k in order]


def _build_text_thread_reply_grouped(
    group: list[tuple[str, str, str, dict, str, str]],
    index: int,
    *,
    show_original_ad_text: bool = True,
) -> list[str]:
    first = group[0]
    ar = first[3]
    ad_text = (ar.get("original_caption") or first[5] or "").strip()
    parse_error = ar.get("parse_error") or ar.get("error")
    mode = ar.get("mode")
    normalized = ar.get("normalized") or {}
    ads = [(row[4], row[0]) for row in group]
    if mode == "policy_only":
        return report_parsing.format_policy_thread_reply_grouped(
            ads, normalized, parse_error, index, ad_text, show_original_ad_text=show_original_ad_text
        )
    if mode == "spell_only":
        return report_parsing.format_spell_thread_reply_grouped(
            ads, normalized, parse_error, index, ad_text, show_original_ad_text=show_original_ad_text
        )
    return report_parsing.format_policy_and_spell_thread_reply_grouped(
        ads, normalized, parse_error, index, ad_text, show_original_ad_text=show_original_ad_text
    )


def run_client_verification(
    *,
    client_id: str,
    ad_account_id_num: int,
    account_ids: list[str],
    fda_true: bool,
    spell_true: bool,
    slack_channel_id: str,
    pm_slack_id: str,
    ad_op_slack_id: str,
) -> dict[str, Any]:
    """
    Full cycle: load DB snapshot, fetch Meta, sync, assess text (not_verified), Slack on transitions.
    """
    run_id = uuid.uuid4()
    creative_utils.print_log(
        f"cycle_start client_id={client_id} ad_account_id_num={ad_account_id_num} "
        f"accounts={account_ids} fda_true={fda_true} spell_true={spell_true} run_id={run_id}"
    )

    snapshot_before = {
        k: {**v} for k, v in supabase_db_helper.fetch_meta_check_db_snapshot(client_id, ad_account_id_num).items()
    }

    token = _token()
    fetched = fetch_ads_for_client(client_id, account_ids, token)
    snapshot_after = sync_fetched_ads_to_db(
        snapshot_before, fetched, client_id, ad_account_id_num, run_id
    )

    fetch_map: dict[str, tuple[dict, dict]] = {
        norm["ad_id"]: (ad, cr) for norm, ad, cr in fetched if norm.get("ad_id")
    }
    text_result_lookup = _build_text_result_lookup(snapshot_after)

    n_text_queued = sum(
        1
        for rec in snapshot_after.values()
        if rec.get("client_id") == client_id
        and _should_queue_text_assessment(rec, snapshot_before)
    )
    text_groups = _client_text_groups_by_caption(client_id, snapshot_after)
    n_text_groups = sum(
        1
        for k, g in text_groups
        if _text_group_needs_work(g, snapshot_before, k, text_result_lookup)
    )
    creative_utils.print_log(
        f"assessment_queue client_id={client_id} text_queued_rows={n_text_queued} "
        f"text_groups_to_process={n_text_groups}"
    )

    assessed_text: list[tuple[str, str, dict, str, str]] = []
    to_persist: list[dict[str, Any]] = []

    concurrency = max(1, int(os.environ.get("ASSESSMENT_CONCURRENCY", "3")))
    lookup_lock = Lock()

    # Separate groups into Gemini-needed vs reuse
    gemini_groups: list[tuple[str, list, str, dict]] = []  # (text_key, recs, ad_id, cr)
    reuse_groups: list[tuple[str, list]] = []

    for text_key, recs in text_groups:
        if not _text_group_needs_work(recs, snapshot_before, text_key, text_result_lookup):
            continue
        queued = [r for r in recs if _should_queue_text_assessment(r, snapshot_before)]
        if bool(queued) and (text_key not in text_result_lookup):
            rep = _pick_representative_for_text_assessment(recs, fetch_map, queued)
            ad_id = rep["ad_id"]
            if ad_id in fetch_map:
                _, cr = fetch_map[ad_id]
            else:
                cr = {"body": rep.get("ad_text") or ""}
            gemini_groups.append((text_key, recs, ad_id, cr))
        else:
            reuse_groups.append((text_key, recs))

    creative_utils.print_log(
        f"assessment_split client_id={client_id} gemini_groups={len(gemini_groups)} "
        f"reuse_groups={len(reuse_groups)} concurrency={concurrency}"
    )

    def _assess_group(text_key: str, recs: list, ad_id: str, cr: dict) -> tuple[str, list, str, dict]:
        ad_name = ""
        if ad_id in fetch_map:
            ad_obj, _ = fetch_map[ad_id]
            ad_name = (ad_obj.get("name") or "")[:200]
        try:
            result = assessment_single_ad.assess_single_ad(
                client_id, ad_id, ad_name, cr, fda_true=fda_true, spell_true=spell_true,
            )
        except Exception as e:
            creative_utils.logger.exception("Text assessment failed for ad %s: %s", ad_id, e)
            result = {"passed": False, "assessment_result": {"error": str(e), "mode": "policy_and_spell"}}
        final_status = STATUS_VERIFIED if bool(result.get("passed")) else STATUS_REJECTED
        ar = result.get("assessment_result") or {}
        if text_key and isinstance(ar, dict):
            with lookup_lock:
                text_result_lookup[text_key] = (final_status, ar)
        creative_utils.print_log(
            f"text_group_assessed_one_call text_key_len={len(text_key)} ad_id={ad_id} "
            f"status={final_status} n_ads_in_group={len(recs)}"
        )
        return text_key, recs, final_status, ar

    # Phase 1: run Gemini groups concurrently
    gemini_results: dict[str, tuple[str, dict]] = {}
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(_assess_group, text_key, recs, ad_id, cr): text_key
            for text_key, recs, ad_id, cr in gemini_groups
        }
        for future in as_completed(futures):
            text_key, recs, final_status, ar = future.result()
            gemini_results[text_key] = (final_status, ar, recs)

    # Phase 2: fan-out Gemini results
    checked = now_iso_bkk()
    for text_key, (final_status, ar, recs) in gemini_results.items():
        for rec in recs:
            ad_id = rec["ad_id"]
            ad_name = ""
            if ad_id in fetch_map:
                ad_obj, _ = fetch_map[ad_id]
                ad_name = (ad_obj.get("name") or "")[:200]
            rec["checked_at"] = checked
            rec["text_check_status"] = final_status
            rec["text_assessment_result"] = ar
            snapshot_after[ad_id] = rec
            to_persist.append(rec)
            assessed_text.append((ad_id, final_status, ar, ad_name, text_key))
            creative_utils.print_log(
                f"text_assessed ad_id={ad_id} status={final_status} "
                f"parse_error={bool(ar.get('parse_error') or ar.get('error'))} fan_out_group=1"
            )

    # Phase 3: reuse groups (no Gemini needed)
    for text_key, recs in reuse_groups:
        reused = text_result_lookup.get(text_key)
        if not reused:
            creative_utils.logger.warning(
                "text_group_skip_no_reuse client_id=%s text_key_len=%s", client_id, len(text_key),
            )
            continue
        final_status, ar_from_lookup = reused
        ar = ar_from_lookup if isinstance(ar_from_lookup, dict) else {"error": "reused_text_result_not_dict"}
        creative_utils.print_log(
            f"text_reused_by_exact_match_caption n_ads_in_group={len(recs)} "
            f"matched_text_len={len(text_key)} status={final_status}"
        )
        checked = now_iso_bkk()
        for rec in recs:
            ad_id = rec["ad_id"]
            ad_name = ""
            if ad_id in fetch_map:
                ad_obj, _ = fetch_map[ad_id]
                ad_name = (ad_obj.get("name") or "")[:200]
            rec["checked_at"] = checked
            rec["text_check_status"] = final_status
            rec["text_assessment_result"] = ar
            snapshot_after[ad_id] = rec
            to_persist.append(rec)
            assessed_text.append((ad_id, final_status, ar, ad_name, text_key))
            creative_utils.print_log(
                f"text_assessed ad_id={ad_id} status={final_status} "
                f"parse_error={bool(ar.get('parse_error') or ar.get('error'))} fan_out_group=1"
            )

    if to_persist:
        supabase_db_helper.upsert_meta_check_db_rows(to_persist, str(run_id))
        try:
            supabase_db_helper.insert_historical_run_rows(
                to_persist, str(run_id), client_id, ad_account_id_num
            )
        except Exception as e:
            creative_utils.logger.exception(
                "insert_historical_run_rows failed client_id=%s run_id=%s: %s",
                client_id,
                run_id,
                e,
            )
            raise

    text_transitions: list[tuple[str, str, str, dict, str, str]] = []
    for ad_id, after_status, ar, ad_name, ad_text in assessed_text:
        prev = snapshot_before.get(ad_id)
        before_status = prev.get("text_check_status") if prev else STATUS_NOT_VERIFIED
        transition = f"{before_status}->{after_status}"
        action = _text_transition_action(transition)
        if action:
            text_transitions.append((ad_id, transition, action, ar, ad_name, ad_text))

    creative_utils.print_log(
        f"transition_summary client_id={client_id} text_transitions={len(text_transitions)}"
    )

    accounts_slack_line = ""
    if text_transitions:
        accounts_slack_line = _build_accounts_slack_line(account_ids, _token())

    text_sent, text_payload = _send_text_transition_slack(
        client_id,
        accounts_slack_line,
        text_transitions,
        slack_channel_id,
        pm_slack_id,
        ad_op_slack_id,
        fda_true=fda_true,
        spell_true=spell_true,
    )
    creative_utils.print_log(
        f"slack_send_result client_id={client_id} stream=text sent={text_sent} thread_count={len(text_payload.get('thread_replies') or [])}"
    )

    text_payload = text_payload or {"initial": "", "thread_replies": []}
    assessed_at = now_iso_bkk()
    slack_message_for_db = {
        "initial": str(text_payload.get("initial") or ""),
        "thread_replies": list(text_payload.get("thread_replies") or []),
    }
    try:
        supabase_db_helper.upsert_historical_slack_message(
            str(run_id),
            client_id,
            ad_account_id_num,
            assessed_at,
            slack_message_for_db,
        )
    except Exception as e:
        creative_utils.logger.exception(
            "upsert_historical_slack_message failed client_id=%s run_id=%s: %s",
            client_id,
            run_id,
            e,
        )
        raise

    history_payload = _build_history_payload(
        client_id,
        account_ids,
        text_payload,
    )
    creative_utils.print_log(
        f"historical_payload_ready client_id={client_id} chars={len(json.dumps(history_payload, ensure_ascii=False))}"
    )
    return {
        "client_id": client_id,
        "synced_ads": len(fetched),
        "text_assessed": len(assessed_text),
        "text_reports": len(text_transitions) if text_sent else 0,
        "history_payload": history_payload,
    }


def _dedupe_account_ids_preserve_order(account_ids: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in account_ids:
        act = main_module.normalize_ad_account_id(raw)
        if not act:
            continue
        if act not in seen:
            seen.add(act)
            out.append(act)
    return out


def _build_accounts_slack_line(account_ids: list[str], access_token: str) -> str:
    parts: list[str] = []
    for act in _dedupe_account_ids_preserve_order(account_ids):
        try:
            data = meta_api.get_ad_account_name(access_token, act)
            name = (data.get("name") or "").strip()
            id_out = (data.get("id") or "").strip() or act
        except Exception as e:
            creative_utils.logger.warning(
                "Meta Graph get_ad_account_name failed for %s: %s", act, e
            )
            parts.append(f"(id: {act})")
            continue
        if name:
            parts.append(f"{name} (id: {id_out})")
        else:
            parts.append(f"(id: {id_out})")
    if parts:
        return ", ".join(parts)
    return ", ".join(
        f"`{main_module.normalize_ad_account_id(a) or (a or '').strip()}`"
        for a in account_ids
        if (a or "").strip()
    )


def _resolve_channel(slack_channel_id: str) -> str:
    if _is_debug_mode():
        return SLACK_DEBUG_CHANNEL
    override = os.environ.get("SLACK_OVERRIDE_CHANNEL_ID", "").strip()
    if override:
        return override
    return (slack_channel_id or os.environ.get("SLACK_CHANNEL") or "").strip()


def _send_text_transition_slack(
    client_id: str,
    accounts_slack_line: str,
    transitions: list[tuple[str, str, str, dict, str, str]],
    slack_channel_id: str,
    pm_slack_id: str,
    ad_op_slack_id: str,
    *,
    fda_true: bool,
    spell_true: bool,
) -> tuple[bool, dict[str, Any]]:
    if not transitions:
        return False, {"initial": "", "thread_replies": []}
    if os.environ.get("DISABLE_LEGACY_TEXT_SLACK", "").strip() == "1":
        creative_utils.logger.info("Legacy text transition Slack disabled; skip text transition Slack")
        return False, {"initial": "", "thread_replies": []}
    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    channel = _resolve_channel(slack_channel_id)
    if not token or not channel:
        creative_utils.logger.warning("No Slack token/channel; skip text transition Slack")
        return False, {"initial": "", "thread_replies": []}
    debug_mode = _is_debug_mode()
    mention = "" if debug_mode else format_slack_user_mention_line(pm_slack_id, ad_op_slack_id)
    n_action, n_fixed = _transition_action_counts(transitions)
    header = _format_text_check_stream_header(fda_true, spell_true, transitions, n_action, n_fixed)
    initial_body = f"{mention}{header}\nClient: {client_id}\nAccount: `{accounts_slack_line}`"
    initial = f"[===TESTING===]\n{initial_body}" if debug_mode else initial_body
    thread_replies: list[str] = []
    grouped = _group_text_transitions(transitions)
    idx = 0
    for grp in grouped:
        ar = grp[0][3]
        if not report_parsing.should_include_text_thread_reply_card(ar):
            continue
        idx += 1
        thread_replies.extend(
            _build_text_thread_reply_grouped(grp, idx, show_original_ad_text=True)
        )
    payload = {"initial": initial, "thread_replies": thread_replies}
    return send_slack_report(token, channel, payload, logger=creative_utils.logger), payload


def _build_history_payload(
    client_id: str,
    account_ids: list[str],
    text_payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "client_name": client_id,
        "account_ids": account_ids,
        "text_check_initial": str(text_payload.get("initial") or ""),
    }
