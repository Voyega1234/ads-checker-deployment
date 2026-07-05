#!/usr/bin/env python3
"""Policy v2 caption checker.

Adapted from policy_newversion/main.py for the Meta ads worker. It fetches
policy rules from Supabase, runs Gemini with structured JSON output, then
verifies/repairs revised captions before returning a normalized result that
the existing worker/report pipeline can store.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError as exc:
    raise SystemExit("Missing dependency: requests. Install with: pip install requests python-dotenv") from exc

import google_adc


# ============================================================
# CONFIG
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
PROMPT_TXT_PATH = BASE_DIR / "docs" / "policy_rule_checker_prompt.txt"
OUTPUT_JSON_PATH = BASE_DIR / "temp" / "policy_rule_checker_output.json"

MODEL_ID = os.getenv("GEMINI_MODEL_ID", "gemini-3-flash-preview")
MAX_GEMINI_ATTEMPTS = int(os.getenv("MAX_GEMINI_ATTEMPTS", "5"))
MAX_REPAIR_ROUNDS = int(os.getenv("MAX_REPAIR_ROUNDS", "3"))
GEMINI_TEMPERATURE = float(os.getenv("GEMINI_TEMPERATURE", "1.0"))
GEMINI_SEED = int(os.getenv("GEMINI_SEED", "42"))
MAX_OUTPUT_TOKENS = int(os.getenv("GEMINI_MAX_OUTPUT_TOKENS", "10000"))
RULES_BLOCK_MAX_RULES = int(os.getenv("RULES_BLOCK_MAX_RULES", "1000"))
POLICY_RULE_RETRIEVAL = os.getenv("POLICY_RULE_RETRIEVAL", "embedding").strip().lower()
POLICY_RULE_EMBEDDING_MATCH_COUNT = int(os.getenv("POLICY_RULE_EMBEDDING_MATCH_COUNT", "100"))
POLICY_RULE_EMBEDDING_VECTOR_CANDIDATES = int(os.getenv("POLICY_RULE_EMBEDDING_VECTOR_CANDIDATES", "150"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "120"))

GEMINI_RETRY_DELAYS_SECONDS = [0.8, 1.5, 2.5, 4.0, 6.0]
RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}

logger = logging.getLogger("caption_checker")


# ============================================================
# ENV
# ============================================================

def load_env_from_dotenv_file(path: Path = BASE_DIR / ".env") -> None:
    """Load .env. Uses python-dotenv if installed; otherwise uses a small fallback parser."""
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(path)
        return
    except ImportError:
        pass

    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def get_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def get_supabase_key() -> str:
    value = (
        os.getenv("SUPABASE_SERVICE_KEY", "").strip()
        or os.getenv("VITE_SUPABASE_SERVICE_KEY", "").strip()
        or os.getenv("SUPABASE_KEY", "").strip()
    )
    if not value:
        raise RuntimeError("Missing required env var: SUPABASE_SERVICE_KEY or SUPABASE_KEY")
    return value


# ============================================================
# CLEAN / JSON HELPERS
# ============================================================

def to_clean_string(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def parse_json_maybe(value: Any, fallback: Any) -> Any:
    if value is None or value == "":
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except Exception:
        return fallback


def parse_json_lenient(text: str) -> Dict[str, Any]:
    s = to_clean_string(text)
    if not s:
        raise ValueError("Empty model text")

    s = s.lstrip("\ufeff").strip()
    s = re.sub(r"^```json\s*", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"^```\s*", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"\s*```$", "", s, flags=re.IGNORECASE).strip()

    try:
        result = json.loads(s)
        if not isinstance(result, dict):
            raise ValueError("Parsed JSON is not an object")
        return result
    except Exception:
        first_brace = s.find("{")
        last_brace = s.rfind("}")
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            result = json.loads(s[first_brace:last_brace + 1])
            if not isinstance(result, dict):
                raise ValueError("Parsed sliced JSON is not an object")
            return result
        raise


# ============================================================
# PROMPT BUILDING
# ============================================================

def read_prompt_template() -> str:
    if not PROMPT_TXT_PATH.exists():
        raise FileNotFoundError(
            f"Prompt file not found: {PROMPT_TXT_PATH}\n"
            "Create prompt.txt in the same folder as this script."
        )
    prompt = PROMPT_TXT_PATH.read_text(encoding="utf-8").strip()
    if not prompt:
        raise ValueError("prompt.txt is empty")
    return prompt


def prompt_contains_message_placeholder(prompt: str) -> bool:
    return re.search(r"{{\s*message\s*}}", str(prompt), flags=re.IGNORECASE) is not None


def build_prompt_text(prompt: str, *, rules_block: str, quick_reference_block: str, message: str) -> str:
    out = str(prompt or "")
    out = re.sub(r"{{\s*rules_block\s*}}", rules_block or "", out, flags=re.IGNORECASE)
    out = re.sub(r"{{\s*quick_reference_block\s*}}", quick_reference_block or "{}", out, flags=re.IGNORECASE)
    out = re.sub(r"{{\s*message\s*}}", message or "", out, flags=re.IGNORECASE)
    out = re.sub(r"{{\s*Message\s*}}", message or "", out)
    out = re.sub(r"{{\s*ExistingPost\s*}}", "", out)
    out = re.sub(r"{{\s*ImageCount\s*}}", "", out)
    return out.strip()


def build_task_instruction_caption_only() -> str:
    return "\n".join([
        "IMPORTANT TASK MODE: CAPTION_ONLY",
        "- Analyze ONLY the caption.",
        "- No usable image was attached.",
        "- For this standalone Python integration, return a JSON object with ONLY the key `caption_analysis`.",
        "- `caption_analysis` must use pass/fail only.",
        "- Return ONLY `caption_analysis`.",
        "- Do NOT fabricate or infer any image analysis.",
    ])


# ============================================================
# SUPABASE POLICY RULES
# ============================================================

def fetch_policy_rules(
    policy_type: Optional[str] = None,
    *,
    supabase_url: str,
    supabase_key: str,
) -> List[Dict[str, Any]]:
    url = f"{supabase_url.rstrip('/')}/rest/v1/policy_rules"
    params = {
        "select": "*",
        "order": "created_at.asc",
    }
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }

    logger.info("Fetching Supabase policy_rules%s", f": policy_type={policy_type}" if policy_type else "")
    res = requests.get(url, params=params, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
    if not (200 <= res.status_code < 300):
        raise RuntimeError(f"Supabase fetch failed ({res.status_code}): {res.text}")

    data = res.json()
    if not isinstance(data, list):
        raise RuntimeError(f"Supabase response is not a list: {data}")
    return data


def build_reference_locator(meta: Dict[str, Any], ref_display: str = "") -> str:
    if not isinstance(meta, dict):
        return ref_display or ""

    if meta.get("section") and meta.get("paragraph"):
        return f"มาตรา {meta.get('section')} วรรค{meta.get('paragraph')}"
    if meta.get("section") and meta.get("subsection"):
        return f"มาตรา {meta.get('section')} ({meta.get('subsection')})"
    if meta.get("section"):
        return f"มาตรา {meta.get('section')}"
    if meta.get("clause") and meta.get("sub_clause"):
        return f"ข้อ {meta.get('clause')} ({meta.get('sub_clause')})"
    if meta.get("clause"):
        return f"ข้อ {meta.get('clause')}"
    if meta.get("attachment") and meta.get("section"):
        return f"เอกสารแนบ {meta.get('attachment')} ข้อ {meta.get('section')}"
    if meta.get("account") and meta.get("item_no"):
        return f"บัญชี {meta.get('account')} หมายเลข {meta.get('item_no')}"
    if meta.get("page") and meta.get("section"):
        return f"หน้า {meta.get('page')} ข้อ {meta.get('section')}"

    return ref_display or ""


def normalize_rule_for_prompt(row: Dict[str, Any]) -> Dict[str, Any]:
    ref_meta = parse_json_maybe(row.get("ref_metadata_json"), {})
    tags = parse_json_maybe(row.get("tags_json"), [])
    if not isinstance(ref_meta, dict):
        ref_meta = {}
    if not isinstance(tags, list):
        tags = []

    title = row.get("short_title") or row.get("rule_title") or row.get("normalized_concept") or ""
    reference_display = row.get("ref_display") or row.get("src_display") or row.get("src_locator") or ""
    quote_text = (
        row.get("quote_text_th")
        or row.get("quote_text")
        or row.get("quote_text_en")
        or row.get("raw_rule_from_src")
        or ""
    )
    source_type = row.get("policy_type") or row.get("source_type") or ""

    prompt_rule = {
        "rule_id": row.get("id") or row.get("rule_id") or "",
        "policy_type": source_type,
        "source_type": source_type,
        "rule_status": row.get("rule_status") or "",
        "trigger_mode": row.get("trigger_mode") or "",
        "trigger_text": row.get("trigger_text") or "",
        "normalized_concept": row.get("normalized_concept") or "",
        "short_title": title,
        "rule_text": row.get("rule_text") or "",
        "fix_note": row.get("fix_note") or "",
        "reference": {
            "ref_scheme": row.get("ref_scheme") or "",
            "ref_display": reference_display,
            "law_name": ref_meta.get("law_name") or ref_meta.get("act_name") or "",
            "gazette_or_announcement": ref_meta.get("announcement_number") or "",
            "reference_locator": build_reference_locator(ref_meta, reference_display),
            "reference_section": reference_display,
        },
        "quote_text": quote_text,
        "tags": tags,
    }
    return strip_empty_prompt_rule_fields(prompt_rule)


def strip_empty_prompt_rule_fields(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key in {
                "retrieval",
                "match_source",
                "similarity",
                "combined_rank_score",
                "rank",
                "embedding_model",
            }:
                continue
            cleaned = strip_empty_prompt_rule_fields(item)
            if cleaned in ("", None, [], {}):
                continue
            out[key] = cleaned
        return out
    if isinstance(value, list):
        return [
            cleaned
            for item in value
            if (cleaned := strip_empty_prompt_rule_fields(item)) not in ("", None, [], {})
        ]
    return value


def build_rules_block(rows: List[Dict[str, Any]], *, max_rules: int = 500, required_tags: Optional[List[str]] = None) -> str:
    required_tags = required_tags or []
    out: List[Dict[str, Any]] = []

    for row in rows:
        tags = parse_json_maybe(row.get("tags_json"), [])
        if not isinstance(tags, list):
            tags = []
        if required_tags and not any(tag in required_tags for tag in tags):
            continue
        out.append(normalize_rule_for_prompt(row))
        if len(out) >= max_rules:
            break

    return json.dumps(out, ensure_ascii=False, indent=2)


def get_policy_rules_for_caption(
    caption: str,
    *,
    supabase_url: str,
    supabase_key: str,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    retrieval_mode = (os.getenv("POLICY_RULE_RETRIEVAL") or POLICY_RULE_RETRIEVAL or "all").strip().lower()
    if retrieval_mode in {"embedding", "hybrid", "vector"}:
        try:
            import embed_policy_rules_gemini

            rows = embed_policy_rules_gemini.search_policy_rules_for_prompt(
                caption,
                final_match_count=POLICY_RULE_EMBEDDING_MATCH_COUNT,
                vector_candidate_count=POLICY_RULE_EMBEDDING_VECTOR_CANDIDATES,
            )
            return rows, {
                "retrieval": "embedding",
                "retrieved_rules": len(rows),
                "final_match_count": POLICY_RULE_EMBEDDING_MATCH_COUNT,
                "vector_candidate_count": POLICY_RULE_EMBEDDING_VECTOR_CANDIDATES,
                "top_similarity": rows[0].get("similarity") if rows else None,
                "top_match_source": rows[0].get("match_source") if rows else "",
            }
        except Exception as exc:
            logger.exception("Embedding policy retrieval failed; falling back to all rules: %s", exc)
            rows = fetch_policy_rules(supabase_url=supabase_url, supabase_key=supabase_key)
            return rows, {
                "retrieval": "all_fallback_after_embedding_error",
                "retrieval_error": str(exc),
                "retrieved_rules": len(rows),
            }

    rows = fetch_policy_rules(supabase_url=supabase_url, supabase_key=supabase_key)
    return rows, {
        "retrieval": "all",
        "retrieved_rules": len(rows),
    }


# ============================================================
# QUICK REFERENCE BLOCK
# ============================================================

def build_quick_reference_block() -> str:
    # Same idea as Apps Script: secondary guidance only. RULES_BLOCK remains primary.
    block = {
        "priority_note": [
            "Use this block as secondary guidance only. RULES_BLOCK remains the primary authority for explicit fail findings, fail decision support, rule_id, and formal citations.",
            "If RULES_BLOCK is incomplete, use this block to infer business context, likely approvals, required disclosures, platform special checks, and safer wording.",
            "Do not invent section, clause, article, announcement number, or Royal Gazette detail from this block alone."
        ],
        "industry_guides": [
            {
                "business_group": "คลินิกความงาม / สถานพยาบาล",
                "prohibited_items": ["ห้าม Before/After", "ห้ามอ้างผลการรักษา", "ห้ามแพทย์โฆษณาเอง", "ห้ามใช้คำว่า 'ชะลอวัย' หรือ 'เป๊ะ ปัง'"],
                "approval_or_notice_required": ["ขออนุญาต สสจ. ทุกสาขา", "แสดงเลขอนุมัติในโฆษณา", "แพทยสภาอนุมัติก่อน"],
                "allowed_or_best_practice": ["ใช้คำว่า 'แลดูเด็กลง'", "อ้างแบรนด์ผลิตภัณฑ์", "ใส่ข้อมูลใบอนุญาตสถานพยาบาล"],
                "platform_special": ["Health & Wellness", "จำกัด Event Tracking"],
                "max_penalty": ["ปรับ/จำคุก (พ.ร.บ.สถานพยาบาล)"],
                "major_laws_or_policies": ["พ.ร.บ.สถานพยาบาล 2541", "ประกาศแพทยสภา 2567"],
                "remarks": ["ห้ามใช้ Purchase/AddToCart Pixel", "KOL ต้องใช้ Branded Content Tool", "ห้ามโฆษณาชิ้นเดิมนานเกิน 6 เดือนโดยไม่ review"]
            },
            {
                "business_group": "ยา / อาหารเสริม / Supplement",
                "prohibited_items": ["ห้ามอ้างรักษาโรค", "ห้ามโฆษณายาโดยไม่ได้รับอนุญาต", "ห้ามโฆษณาในโรคต้องห้าม"],
                "approval_or_notice_required": ["ขออนุญาต อย. ก่อนโฆษณา", "แสดงเลขทะเบียน อย.", "ผ่านการอนุมัติโฆษณาก่อน"],
                "allowed_or_best_practice": ["ใช้คำว่า 'ช่วยบำรุง' ไม่ใช่ 'รักษา'", "แสดงคำเตือน อย.", "ระบุส่วนประกอบครบถ้วน"],
                "platform_special": ["Health & Wellness", "จำกัด Pixel"],
                "max_penalty": ["ปรับสูงสุด 100,000 บาท (พ.ร.บ.ยา 2510)"],
                "major_laws_or_policies": ["พ.ร.บ.ยา 2510", "พ.ร.บ.อาหาร 2522", "ประกาศ อย. 2564"],
                "remarks": ["ต้องมีเลข อย. ในโฆษณาทุกชิ้น", "อาหารเสริมลดน้ำหนักห้ามการันตีผล", "Functional Food ต้องผ่าน อย. แยกต่างหาก"]
            },
            {
                "business_group": "เครื่องสำอาง / Beauty (non-medical)",
                "prohibited_items": ["ห้ามอ้างสรรพคุณทางยา", "ห้ามใช้คำว่า 'รักษา'", "ห้าม Body Shaming"],
                "approval_or_notice_required": ["จดแจ้ง อย. ก่อน", "โฆษณาต้องตรงกับฉลากจดแจ้ง", "KOL ต้อง tag Branded Content"],
                "allowed_or_best_practice": ["ใช้คำว่า 'บำรุง' แทน 'รักษา'", "อ้างผลการทดสอบได้ถ้ามีหลักฐาน", "แสดงส่วนประกอบหลัก"],
                "platform_special": ["ปกติไม่ใช่ Special Category", "แต่ระวัง Health & Wellness"],
                "max_penalty": ["ปรับ/ระงับการจำหน่าย (พ.ร.บ.เครื่องสำอาง 2558)"],
                "major_laws_or_policies": ["พ.ร.บ.เครื่องสำอาง 2558", "หลักเกณฑ์ อย. 2567"],
                "remarks": ["ตรวจสอบรายการคำที่ สบส. อนุญาต", "ห้ามใช้ภาพดาราหรือบุคคลสาธารณะโดยไม่ได้รับอนุญาต", "Meta ระวังภาพ Skin Retouching เกินจริง"]
            },
            {
                "business_group": "การเงิน / สินเชื่อ / ประกันภัย / ลงทุน",
                "prohibited_items": ["ห้ามการันตีผลตอบแทน", "ห้ามโฆษณาว่า 'ไม่มีความเสี่ยง'", "ห้าม Get Rich Quick"],
                "approval_or_notice_required": ["ขออนุมัติ คปภ. สำหรับประกัน", "ต้องมีใบอนุญาตผู้แนะนำลงทุนเมื่อเกี่ยวข้อง", "เลือก Special Ad Category"],
                "allowed_or_best_practice": ["แสดง EIR ชัดเจน", "มีคำเตือนความเสี่ยง", "ระบุเงื่อนไขครบถ้วน"],
                "platform_special": ["Special Ad Category: Financial Products"],
                "max_penalty": ["ปรับ/เพิกถอนใบอนุญาต"],
                "major_laws_or_policies": ["พ.ร.บ.คุ้มครองผู้บริโภค", "ประกาศ ก.ล.ต.", "ประกาศ คปภ."],
                "remarks": ["Crypto ต้องขอ written permission จาก Meta", "PDPA ต้องขอ Consent ก่อน retarget ลูกค้า", "Pay Day Loan บางประเภทถูกแบนบน Meta"]
            },
            {
                "business_group": "แอลกอฮอล์ / ยาสูบ / บุหรี่ไฟฟ้า",
                "prohibited_items": ["ห้ามโฆษณาทุกรูปแบบในไทยรวม Social Media", "บุหรี่ไฟฟ้าผิดกฎหมายโดยสิ้นเชิง"],
                "approval_or_notice_required": ["N/A สำหรับการขายตรงในไทย", "แอลกอฮอล์อาจสื่อสารแบรนด์ได้โดยไม่ขายสินค้าโดยตรงในบางกรณี"],
                "allowed_or_best_practice": ["โฆษณาเชิง CSR / แบรนด์โดยไม่กล่าวถึงผลิตภัณฑ์", "กิจกรรม Sponsorship แบบ offline"],
                "platform_special": ["Restricted Content", "Permission + Age Gate 20+"],
                "max_penalty": ["ปรับสูงสุด 500,000 บาท", "จำคุกไม่เกิน 1 ปี"],
                "major_laws_or_policies": ["พ.ร.บ.ควบคุมแอลกอฮอล์ 2551", "พ.ร.บ.ยาสูบ 2560"],
                "remarks": ["Meta อนุญาตบางประเทศแต่ไทยห้าม", "ภาพแก้วเบียร์ในโฆษณาอื่นก็อาจถูก reject", "ตรวจสอบ Country Specific Restrictions"]
            },
            {
                "business_group": "การพนัน / Lottery",
                "prohibited_items": ["การพนันออนไลน์ผิดกฎหมายไทย", "ห้ามโฆษณาเด็ดขาดในไทย"],
                "approval_or_notice_required": ["Meta ต้องขอ Written Permission", "ต้องมีใบอนุญาตรัฐบาลท้องถิ่น", "Target 18+ เท่านั้น"],
                "allowed_or_best_practice": ["สลากกินแบ่งรัฐบาลทำได้", "แต่ต้องไม่เกินราคาหน้าสลาก"],
                "platform_special": ["Gambling Policy", "Written Permission Required"],
                "max_penalty": ["ปรับ/จำคุก (พ.ร.บ.การพนัน 2478)"],
                "major_laws_or_policies": ["พ.ร.บ.การพนัน 2478", "Meta Gambling Policy"],
                "remarks": ["ไทยไม่มีใบอนุญาต Casino ออนไลน์ จึงมักไม่ผ่าน Meta approval", "สลากดิจิทัลหรือแอปให้พนักงานตรวจสอบก่อน"]
            },
            {
                "business_group": "กัญชา / กัญชง / Medical Cannabis",
                "prohibited_items": ["ห้ามอ้างรักษาโรคโดยไม่ได้รับอนุญาต", "ห้ามโฆษณาในเชิงนันทนาการ", "ห้ามชักชวนเด็กหรือเยาวชน"],
                "approval_or_notice_required": ["ขออนุญาต อย. ก่อนโฆษณาสรรพคุณ", "Meta Restricted ต้องขอ permission"],
                "allowed_or_best_practice": ["โฆษณาสถานประกอบการที่ได้รับอนุญาต", "ระบุว่าใช้ 'เพื่อการแพทย์' เท่านั้น"],
                "platform_special": ["Restricted Goods", "ต้องขอ Permission"],
                "max_penalty": ["ปรับ/จำคุก (กฎหมายยาเสพติด)"],
                "major_laws_or_policies": ["พ.ร.บ.ยาเสพติด 2564", "Meta Restricted Goods"],
                "remarks": ["กฎหมายกัญชาเปลี่ยนบ่อย ตรวจสอบล่าสุดเสมอ", "Meta พิจารณาใบอนุญาตของประเทศนั้นๆ", "ห้ามโฆษณาให้คนอายุต่ำกว่า 20 ปี"]
            },
            {
                "business_group": "Crypto / Token / สินทรัพย์ดิจิทัล",
                "prohibited_items": ["ห้ามการันตีกำไร", "ห้ามโฆษณาชวนเชื่อเกินจริง", "ต้องไม่มีลักษณะแชร์ลูกโซ่"],
                "approval_or_notice_required": ["ขอ Written Permission จาก Meta", "ต้องมีใบอนุญาต ก.ล.ต.", "KOL ต้องเปิดเผย #ad"],
                "allowed_or_best_practice": ["มีคำเตือนความเสี่ยงชัดเจน", "ระบุชื่อ Exchange ที่ได้รับใบอนุญาต", "อ้างอิงกฎ ก.ล.ต. อย่างถูกต้อง"],
                "platform_special": ["Cryptocurrency Policy", "Written Permission + License"],
                "max_penalty": ["ปรับ/เพิกถอนใบอนุญาต (พ.ร.ก.สินทรัพย์ดิจิทัล 2561)"],
                "major_laws_or_policies": ["พ.ร.ก.สินทรัพย์ดิจิทัล 2561", "ประกาศ ก.ล.ต. 19/2565"],
                "remarks": ["Meta เปลี่ยน Crypto Policy บ่อย ตรวจสอบล่าสุดทุกครั้ง", "DeFi / NFT บางประเภทยังเป็น Gray Area", "ต้องส่ง business documents ให้ Meta อนุมัติก่อน"]
            },
            {
                "business_group": "อาหาร / เครื่องดื่ม / ร้านอาหาร",
                "prohibited_items": ["ห้ามอ้างสรรพคุณรักษาโรค", "ห้ามโฆษณาแอลกอฮอล์", "ห้ามใช้ภาพอาหารหลอกลวง"],
                "approval_or_notice_required": ["อาหารเสริมต้องขออนุญาต อย.", "เครื่องดื่มชูกำลังต้องมีคำเตือน"],
                "allowed_or_best_practice": ["แสดงส่วนผสมหลัก", "ใช้ภาพสินค้าจริง", "ระบุปริมาณและราคาที่ชัดเจน"],
                "platform_special": ["โดยทั่วไปไม่ใช่ Special Category", "แต่ระวังภาพอาหารเกินจริง"],
                "max_penalty": ["ปรับ/ระงับจำหน่าย"],
                "major_laws_or_policies": ["พ.ร.บ.อาหาร 2522", "ประกาศ อย. 2564"],
                "remarks": ["Energy Drink ต้องมีคำเตือนบนโฆษณา", "ราคา/โปรโมชันต้องตรงกับหน้าร้านจริง", "UGC หรือรีวิวห้ามอ้างรักษาโรค"]
            },
            {
                "business_group": "ฟิตเนส / Weight Loss / Wellness",
                "prohibited_items": ["ห้าม Before/After images", "ห้าม guaranteed results", "ห้ามอ้างรักษาโรคอ้วน"],
                "approval_or_notice_required": ["Supplement ต้องมีเลข อย.", "อยู่ใน Meta Health & Wellness category", "KOL ต้องใช้ Branded Content Tool"],
                "allowed_or_best_practice": ["แสดงผลที่ 'อาจ' เกิดขึ้นพร้อม Disclaimer", "อ้างอิงผลวิจัยที่ผ่านการรับรอง", "เน้น Lifestyle มากกว่า Weight Loss"],
                "platform_special": ["Health & Wellness", "จำกัด Event Tracking และ Purchase Event"],
                "max_penalty": ["ปรับตามกฎหมายอาหาร", "Meta reject ad"],
                "major_laws_or_policies": ["ประกาศ อย. 2564", "Meta Weight Loss Policy"],
                "remarks": ["Meta block Purchase event สำหรับ Health product", "ใช้ Lead Gen แทน Conversion campaign ได้", "ระวังภาพ BMI หรือภาพตาชั่งน้ำหนัก"]
            },
            {
                "business_group": "KOL / Influencer / Branded Content",
                "prohibited_items": ["ห้ามซ่อนว่าเป็น paid promotion", "ห้ามอ้างเป็นรีวิวจริงหากได้รับค่าตอบแทน"],
                "approval_or_notice_required": ["ใช้ Branded Content Tool ทุกโพสต์", "แท็ก #ad หรือ #โฆษณา ให้ชัดเจน", "แจ้งแบรนด์ทุกครั้งก่อนโพสต์"],
                "allowed_or_best_practice": ["เปิดเผย Partnership อย่างชัดเจน", "ใช้ 'Paid Partnership with [Brand]'", "KOL ควรเก็บสำเนา contract"],
                "platform_special": ["Branded Content Tool", "ใช้ได้กับทุก Industry"],
                "max_penalty": ["ปรับ/บัญชีถูกระงับ"],
                "major_laws_or_policies": ["Meta Branded Content Policy", "FTC Guides 2023", "ประกาศ สคบ."],
                "remarks": ["Meta ตรวจจับ undisclosed partnership อัตโนมัติ", "Micro-KOL ก็ต้องปฏิบัติตาม", "รีวิวหรือ testimonial ที่ได้ของฟรีก็ต้อง disclose"]
            },
            {
                "business_group": "PDPA / Data Privacy / ทุก Industry",
                "prohibited_items": ["ห้ามเก็บข้อมูลโดยไม่ขอ Consent", "ห้าม Retarget โดยไม่มีฐานทางกฎหมาย", "ห้าม share ข้อมูลโดยไม่ได้รับอนุญาต"],
                "approval_or_notice_required": ["มี Privacy Notice บนเว็บไซต์", "มี Cookie Consent Banner", "ทำ DPIA สำหรับ High-Risk Processing"],
                "allowed_or_best_practice": ["บันทึก Consent timestamp", "ให้ผู้ใช้ถอน Consent ได้", "แต่งตั้ง DPO หากเข้าเกณฑ์"],
                "platform_special": ["ใช้กับทุก Industry ที่มี Pixel / Lead Form / Retargeting"],
                "max_penalty": ["ปรับสูงสุด 5 ล้านบาท", "จำคุกสูงสุด 1 ปี"],
                "major_laws_or_policies": ["พ.ร.บ. PDPA 2562", "Meta CAPI / Pixel Policy"],
                "remarks": ["ตรวจสอบว่า Pixel ส่งเฉพาะข้อมูลที่ได้ Consent แล้ว", "ใช้ CAPI แทน Pixel สำหรับ Health/Finance domain ได้", "ระวังการใช้ custom audience และ retargeting จากข้อมูลลูกค้า"]
            }
        ]
    }
    return json.dumps(block, ensure_ascii=False, indent=2)


# ============================================================
# GEMINI RESPONSE SCHEMA
# ============================================================

# Gemini REST structured output commonly expects uppercase schema type names.
# This is the same schema shape as the Apps Script, adapted to REST-friendly casing.
def schema_type(name: str) -> str:
    return name.upper()


def build_pass_fail_summary_schema() -> Dict[str, Any]:
    return {
        "type": schema_type("object"),
        "properties": {
            "overall_verdict": {"type": schema_type("string"), "enum": ["pass", "fail"]},
            "display_title": {"type": schema_type("string")},
            "display_subtitle": {"type": schema_type("string")},
            "issue_count": {"type": schema_type("integer")},
            "fail_count": {"type": schema_type("integer")},
            "executive_summary": {"type": schema_type("string")},
        },
        "required": [
            "overall_verdict",
            "display_title",
            "display_subtitle",
            "issue_count",
            "fail_count",
            "executive_summary",
        ],
    }


def build_quick_reference_schema() -> Dict[str, Any]:
    string_array = {"type": schema_type("array"), "items": {"type": schema_type("string")}}
    return {
        "type": schema_type("object"),
        "properties": {
            "business_context": {"type": schema_type("string")},
            "primary_policy_family": {"type": schema_type("string")},
            "source_priority_used": string_array,
            "approval_or_notice_checklist": string_array,
            "required_disclosures_or_warnings": string_array,
            "platform_special_checks": string_array,
            "quick_do_not_do": string_array,
            "quick_best_practice": string_array,
            "reviewer_notes": string_array,
            "fallback_major_laws_or_policies": string_array,
        },
        "required": [
            "business_context",
            "primary_policy_family",
            "source_priority_used",
            "approval_or_notice_checklist",
            "required_disclosures_or_warnings",
            "platform_special_checks",
            "quick_do_not_do",
            "quick_best_practice",
            "reviewer_notes",
            "fallback_major_laws_or_policies",
        ],
    }


def build_fail_issue_schema() -> Dict[str, Any]:
    additional_ref_schema = {
        "type": schema_type("object"),
        "properties": {
            "law_name": {"type": schema_type("string")},
            "gazette_or_announcement": {"type": schema_type("string")},
            "reference_locator": {"type": schema_type("string")},
            "display_reference": {"type": schema_type("string")},
        },
        "required": ["law_name", "gazette_or_announcement", "reference_locator", "display_reference"],
    }

    return {
        "type": schema_type("object"),
        "properties": {
            "order_index": {"type": schema_type("integer")},
            "flagged_text": {"type": schema_type("string")},
            "verdict": {"type": schema_type("string"), "enum": ["fail"]},
            "basis_type": {"type": schema_type("string"), "enum": ["explicit_rule", "strong_rule_support"]},
            "confidence": {"type": schema_type("string"), "enum": ["high", "medium"]},
            "source_type": {"type": schema_type("string")},
            "rule_id": {"type": schema_type("string")},
            "policy_family": {"type": schema_type("string")},
            "law_name": {"type": schema_type("string")},
            "gazette_or_announcement": {"type": schema_type("string")},
            "reference_locator": {"type": schema_type("string")},
            "reference_section": {"type": schema_type("string")},
            "display_reference": {"type": schema_type("string")},
            "category": {"type": schema_type("string")},
            "subcategory": {"type": schema_type("string")},
            "issue_title": {"type": schema_type("string")},
            "issue_detail": {"type": schema_type("string")},
            "fix_note": {"type": schema_type("string")},
            "additional_references": {"type": schema_type("array"), "items": additional_ref_schema},
        },
        "required": [
            "order_index",
            "flagged_text",
            "verdict",
            "basis_type",
            "confidence",
            "source_type",
            "rule_id",
            "policy_family",
            "law_name",
            "gazette_or_announcement",
            "reference_locator",
            "reference_section",
            "display_reference",
            "category",
            "subcategory",
            "issue_title",
            "issue_detail",
            "fix_note",
            "additional_references",
        ],
    }


def build_pass_fail_analysis_schema() -> Dict[str, Any]:
    return {
        "type": schema_type("object"),
        "properties": {
            "original_message": {"type": schema_type("string")},
            "revised_message": {"type": schema_type("string")},
            "revised_caption": {"type": schema_type("string")},
            "overall_result": {"type": schema_type("string"), "enum": ["pass", "fail"]},
            "summary": build_pass_fail_summary_schema(),
            "quick_reference": build_quick_reference_schema(),
            "issues": {"type": schema_type("array"), "items": build_fail_issue_schema()},
        },
        "required": [
            "original_message",
            "revised_message",
            "overall_result",
            "summary",
            "quick_reference",
            "issues",
        ],
    }


def build_fda_response_schema_caption_only() -> Dict[str, Any]:
    return {
        "type": schema_type("object"),
        "properties": {
            "caption_analysis": build_pass_fail_analysis_schema(),
        },
        "required": ["caption_analysis"],
    }


# ============================================================
# ANALYSIS / ISSUES HELPERS
# ============================================================

def extract_analysis_object(result: Dict[str, Any], key: str = "caption_analysis") -> Dict[str, Any]:
    if isinstance(result.get(key), dict):
        return result[key]

    if any(k in result for k in ["original_message", "revised_message", "overall_result", "summary", "issues"]):
        return result

    return {}


def normalize_issue_verdict(value: Any) -> str:
    s = str(value or "").strip().lower()
    if s == "fail":
        return "fail"
    if s == "pass":
        return "pass"
    if s in {"severe", "warning", "high", "medium", "red", "yellow"}:
        return "fail"
    return "pass"


def normalize_single_issue(issue: Dict[str, Any]) -> Dict[str, Any]:
    x = issue or {}
    return {
        "order_index": int(x.get("order_index") or 9999),
        "flagged_text": to_clean_string(x.get("flagged_text") or x.get("text") or x.get("match")),
        "verdict": normalize_issue_verdict(x.get("verdict") or x.get("severity")),
        "basis_type": to_clean_string(x.get("basis_type")),
        "confidence": to_clean_string(x.get("confidence")),
        "source_type": to_clean_string(x.get("source_type")),
        "rule_id": to_clean_string(x.get("rule_id")),
        "policy_family": to_clean_string(x.get("policy_family")),
        "law_name": to_clean_string(x.get("law_name")),
        "gazette_or_announcement": to_clean_string(x.get("gazette_or_announcement")),
        "reference_locator": to_clean_string(x.get("reference_locator")),
        "reference_section": to_clean_string(x.get("reference_section")),
        "display_reference": to_clean_string(x.get("display_reference") or x.get("reference") or x.get("ref_display")),
        "category": to_clean_string(x.get("category")),
        "subcategory": to_clean_string(x.get("subcategory")),
        "issue_title": to_clean_string(x.get("issue_title") or x.get("title") or x.get("issue") or x.get("label") or x.get("short_title")),
        "issue_detail": to_clean_string(x.get("issue_detail") or x.get("detail") or x.get("description") or x.get("reason")),
        "fix_note": to_clean_string(x.get("fix_note") or x.get("recommendation") or x.get("suggestion") or x.get("fix")),
        "additional_references": x.get("additional_references") if isinstance(x.get("additional_references"), list) else [],
    }


def normalize_issues_from_analysis(analysis: Dict[str, Any]) -> List[Dict[str, Any]]:
    analysis = analysis or {}
    direct_issues = analysis.get("issues") if isinstance(analysis.get("issues"), list) else []
    if direct_issues:
        return [normalize_single_issue(i if isinstance(i, dict) else {}) for i in direct_issues]

    # Backward compatibility with old red/yellow schema.
    out: List[Dict[str, Any]] = []
    red_matches = analysis.get("red_matches") if isinstance(analysis.get("red_matches"), list) else []
    yellow_matches = analysis.get("yellow_matches") if isinstance(analysis.get("yellow_matches"), list) else []
    fix_notes = analysis.get("fix_notes") if isinstance(analysis.get("fix_notes"), list) else []
    reason = to_clean_string(analysis.get("reason"))

    for i, match in enumerate(red_matches):
        out.append(normalize_single_issue({
            "order_index": len(out) + 1,
            "flagged_text": match,
            "verdict": "fail",
            "basis_type": "explicit_rule",
            "confidence": "high",
            "issue_title": to_clean_string(match) or "พบประเด็นที่ไม่ผ่าน",
            "issue_detail": reason or "-",
            "fix_note": fix_notes[i] if i < len(fix_notes) else (fix_notes[0] if fix_notes else "-"),
            "display_reference": "-",
        }))

    for j, match in enumerate(yellow_matches):
        out.append(normalize_single_issue({
            "order_index": len(out) + 1,
            "flagged_text": match,
            "verdict": "fail",
            "basis_type": "strong_rule_support",
            "confidence": "medium",
            "issue_title": to_clean_string(match) or "พบประเด็นที่ไม่ผ่าน",
            "issue_detail": reason or "-",
            "fix_note": fix_notes[j] if j < len(fix_notes) else (fix_notes[0] if fix_notes else "-"),
            "display_reference": "-",
        }))

    return out


def sort_fail_issues(issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(
        [i for i in issues if normalize_issue_verdict(i.get("verdict") or i.get("severity")) == "fail"],
        key=lambda x: int(x.get("order_index") or 9999),
    )


def get_overall_verdict_from_analysis(analysis: Dict[str, Any]) -> str:
    if isinstance(analysis.get("summary"), dict) and analysis["summary"].get("overall_verdict"):
        return to_clean_string(analysis["summary"].get("overall_verdict"))
    return to_clean_string(analysis.get("overall_result") or analysis.get("verdict"))


def compute_overall_pass_fail_from_issues(issues: List[Dict[str, Any]], fallback: str = "") -> str:
    if issues:
        return "fail"
    if normalize_issue_verdict(fallback) == "fail":
        return "fail"
    return "pass"


def is_pass_or_zero_fail_analysis(analysis: Dict[str, Any]) -> bool:
    issues = normalize_issues_from_analysis(analysis)
    fail_issues = sort_fail_issues(issues)
    overall = compute_overall_pass_fail_from_issues(fail_issues, get_overall_verdict_from_analysis(analysis))
    return overall == "pass" or len(fail_issues) == 0


def get_revised_caption_from_analysis(analysis: Dict[str, Any]) -> str:
    return to_clean_string(analysis.get("revised_caption") or analysis.get("revised_message"))


# ============================================================
# GEMINI API
# ============================================================

def build_gemini_payload(
    parts: List[Dict[str, Any]],
    *,
    system_instruction: str | None = None,
) -> Dict[str, Any]:
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": GEMINI_TEMPERATURE,
            "seed": GEMINI_SEED,
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "responseMimeType": "application/json",
            "responseSchema": build_fda_response_schema_caption_only(),
        },
    }
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    return payload


def call_gemini_with_retry(payload: Dict[str, Any], *, label: str = "") -> Dict[str, Any]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_ID}:generateContent"
    params = {}
    headers = {"Content-Type": "application/json", **google_adc.get_gemini_http_headers()}

    attempts = max(1, int(MAX_GEMINI_ATTEMPTS))
    last_title = "UNKNOWN ERROR"
    last_detail = ""

    for attempt in range(1, attempts + 1):
        logger.info("Gemini request%s attempt %s/%s", f" ({label})" if label else "", attempt, attempts)
        try:
            res = requests.post(
                url,
                params=params,
                headers=headers,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            raw = res.text
            logger.info("Gemini response code=%s attempt=%s/%s", res.status_code, attempt, attempts)

            try:
                data = res.json()
            except Exception:
                last_title = "RAW RESPONSE JSON PARSE ERROR"
                last_detail = raw
                if attempt < attempts:
                    sleep_before_retry(attempt, last_title)
                    continue
                return {"ok": False, "title": last_title, "detail": last_detail, "attempt_used": attempt}

            if res.status_code != 200 or not data.get("candidates") or not data["candidates"][0]:
                last_title = f"API ERROR ({res.status_code})"
                last_detail = raw
                retryable = res.status_code in RETRYABLE_STATUS_CODES or res.status_code == 200
                if retryable and attempt < attempts:
                    sleep_before_retry(attempt, last_title)
                    continue
                return {"ok": False, "title": last_title, "detail": last_detail, "attempt_used": attempt, "raw": raw}

            parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
            full_text = "\n".join(to_clean_string(part.get("text")) for part in parts if isinstance(part, dict)).strip()
            if not full_text:
                last_title = "EMPTY MODEL OUTPUT"
                last_detail = raw
                if attempt < attempts:
                    sleep_before_retry(attempt, last_title)
                    continue
                return {"ok": False, "title": last_title, "detail": last_detail, "attempt_used": attempt, "raw": raw}

            try:
                result = parse_json_lenient(full_text)
            except Exception as parse_err:
                last_title = "JSON PARSE ERROR"
                last_detail = full_text
                logger.warning("%s: %s", last_title, parse_err)
                if attempt < attempts:
                    sleep_before_retry(attempt, last_title)
                    continue
                return {"ok": False, "title": last_title, "detail": last_detail, "attempt_used": attempt, "raw": raw}

            return {
                "ok": True,
                "result": result,
                "raw": raw,
                "response_code": res.status_code,
                "attempt_used": attempt,
            }

        except Exception as err:
            last_title = "REQUEST ERROR"
            last_detail = str(err)
            logger.warning("%s attempt=%s/%s: %s", last_title, attempt, attempts, last_detail)
            if attempt < attempts:
                sleep_before_retry(attempt, last_title)
                continue
            return {"ok": False, "title": last_title, "detail": last_detail, "attempt_used": attempt}

    return {"ok": False, "title": last_title, "detail": last_detail, "attempt_used": attempts}


def sleep_before_retry(attempt: int, reason: str) -> None:
    idx = min(max(attempt - 1, 0), len(GEMINI_RETRY_DELAYS_SECONDS) - 1)
    delay = GEMINI_RETRY_DELAYS_SECONDS[idx]
    logger.info("Retrying because %s | sleep %.1fs", reason, delay)
    time.sleep(delay)


# ============================================================
# CHECK / VERIFY / REPAIR
# ============================================================

def run_caption_only_check(
    *,
    raw_prompt: str,
    rules_block: str,
    quick_reference_block: str,
    caption: str,
    label: str = "caption-check",
) -> Dict[str, Any]:
    prompt_has_inline_message = prompt_contains_message_placeholder(raw_prompt)
    prompt_text = build_prompt_text(
        raw_prompt,
        rules_block=rules_block,
        quick_reference_block=quick_reference_block,
        message=caption if prompt_has_inline_message else "",
    )

    if prompt_has_inline_message:
        parts = [{"text": "\n".join([prompt_text, "", build_task_instruction_caption_only()])}]
        payload = build_gemini_payload(parts)
    else:
        system_instruction = "\n".join([prompt_text, "", build_task_instruction_caption_only()])
        parts = [{"text": f"=== INPUT_MESSAGE START ===\n{caption or ''}\n=== INPUT_MESSAGE END ==="}]
        payload = build_gemini_payload(parts, system_instruction=system_instruction)
    run = call_gemini_with_retry(payload, label=label)

    if not run.get("ok"):
        return {"ok": False, "title": run.get("title"), "detail": run.get("detail"), "raw": run.get("raw")}

    result = run.get("result") or {}
    analysis = extract_analysis_object(result, "caption_analysis")
    return {"ok": True, "analysis": analysis, "result": result, "raw": run.get("raw"), "attempt_used": run.get("attempt_used")}


def repair_failed_revised_caption(
    *,
    raw_prompt: str,
    rules_block: str,
    quick_reference_block: str,
    original_caption: str,
    failed_revised_candidates: List[Dict[str, Any]],
    verify_analysis: Dict[str, Any],
    label: str = "repair",
) -> Dict[str, Any]:
    verify_issues = normalize_issues_from_analysis(verify_analysis)
    fail_issues = sort_fail_issues(verify_issues)

    repair_instruction = "\n".join([
        "You are AdShield Unified Compliance Checker.",
        "You are repairing a revised ad caption that still failed compliance re-check.",
        "",
        "TASK:",
        "- Rewrite ONLY the failed candidate caption into a safer pass-ready caption.",
        "- Preserve the original commercial intent as much as possible.",
        "- Preserve product identity, price, size, links, CTA, and non-risky lines where possible.",
        "- Remove or neutralize every fail issue found in the failed candidate.",
        "- Do not introduce new benefit, medical, beauty, investment, guarantee, approval, or performance claims.",
        "- Do not replace one risky claim with another softer risky claim.",
        "- Use neutral product-description language if unsure.",
        "- Return JSON using caption_analysis only.",
        "",
        "OUTPUT RULE:",
        "- caption_analysis.overall_result should be pass only if the repaired caption itself would pass re-check.",
        "- caption_analysis.revised_message and caption_analysis.revised_caption must contain the repaired caption.",
        "",
        "ORIGINAL CAPTION:",
        original_caption or "",
        "",
        "FAILED REVISED CANDIDATES:",
        json.dumps(failed_revised_candidates or [], ensure_ascii=False, indent=2),
        "",
        "IMPORTANT:",
        "- The list above contains all revised caption candidates that already failed re-check.",
        "- The last item is the latest failed candidate.",
        "- Do not repeat wording from any failed revised candidate.",
        "- Do not reuse the same risky claim concept that caused previous candidates to fail.",
        "- If previous softer wording still failed, remove the claim entirely and use neutral product-description language.",
        "",
        "FAIL ISSUES FOUND ON RECHECK:",
        json.dumps(fail_issues, ensure_ascii=False, indent=2),
        "",
        "RULES_BLOCK:",
        rules_block or "",
        "",
        "QUICK_REFERENCE_BLOCK:",
        quick_reference_block or "{}",
        "",
        build_task_instruction_caption_only(),
    ])

    payload = build_gemini_payload([{"text": repair_instruction}])
    run = call_gemini_with_retry(payload, label=label)

    if not run.get("ok"):
        return {
            "ok": False,
            "title": run.get("title"),
            "detail": run.get("detail"),
            "repaired_caption": "",
            "raw": run.get("raw"),
        }

    analysis = extract_analysis_object(run.get("result") or {}, "caption_analysis")
    repaired_caption = get_revised_caption_from_analysis(analysis)
    return {
        "ok": True,
        "analysis": analysis,
        "repaired_caption": repaired_caption,
        "raw": run.get("raw"),
        "attempt_used": run.get("attempt_used"),
    }


def ensure_revised_caption_pass(
    *,
    raw_prompt: str,
    rules_block: str,
    quick_reference_block: str,
    original_caption: str,
    initial_revised_caption: str,
) -> Dict[str, Any]:
    candidate = to_clean_string(initial_revised_caption)
    failed_revised_candidates: List[Dict[str, Any]] = []
    last_verify_analysis: Dict[str, Any] = {}
    last_repair_analysis: Dict[str, Any] = {}

    if not candidate:
        # Do one repair attempt directly from the original failure context.
        logger.info("Initial revised caption is empty. Attempting direct repair.")
        direct_repair = repair_failed_revised_caption(
            raw_prompt=raw_prompt,
            rules_block=rules_block,
            quick_reference_block=quick_reference_block,
            original_caption=original_caption,
            failed_revised_candidates=[],
            verify_analysis={},
            label="direct-repair-empty-candidate",
        )
        if direct_repair.get("ok") and direct_repair.get("repaired_caption"):
            candidate = direct_repair["repaired_caption"]
            last_repair_analysis = direct_repair.get("analysis") or {}
        else:
            return {
                "pass": False,
                "final_caption": original_caption,
                "last_candidate": original_caption,
                "rounds_used": 0,
                "note": "No revised caption candidate was produced; returning original caption instead of manual review text.",
                "failed_revised_candidates": failed_revised_candidates,
                "last_verify_analysis": last_verify_analysis,
                "last_repair_analysis": last_repair_analysis,
            }

    for round_no in range(1, MAX_REPAIR_ROUNDS + 1):
        logger.info("Verifying revised caption round %s/%s", round_no, MAX_REPAIR_ROUNDS)
        verify_run = run_caption_only_check(
            raw_prompt=raw_prompt,
            rules_block=rules_block,
            quick_reference_block=quick_reference_block,
            caption=candidate,
            label=f"verify-round-{round_no}",
        )

        if not verify_run.get("ok"):
            logger.warning("Verification failed on round %s: %s", round_no, verify_run.get("title"))
            return {
                "pass": False,
                "final_caption": candidate,
                "last_candidate": candidate,
                "rounds_used": round_no,
                "note": f"Verification failed: {verify_run.get('title') or 'UNKNOWN ERROR'}; returning latest revised candidate instead of manual review text.",
                "failed_revised_candidates": failed_revised_candidates,
                "last_verify_analysis": last_verify_analysis,
                "last_repair_analysis": last_repair_analysis,
            }

        last_verify_analysis = verify_run.get("analysis") or {}
        if is_pass_or_zero_fail_analysis(last_verify_analysis):
            return {
                "pass": True,
                "final_caption": candidate,
                "last_candidate": candidate,
                "rounds_used": round_no,
                "note": "Revised caption passed re-check.",
                "failed_revised_candidates": failed_revised_candidates,
                "last_verify_analysis": last_verify_analysis,
                "last_repair_analysis": last_repair_analysis,
            }

        fail_issues = sort_fail_issues(normalize_issues_from_analysis(last_verify_analysis))
        failed_revised_candidates.append({
            "round": round_no,
            "caption": candidate,
            "fail_issues": [
                {
                    "flagged_text": issue.get("flagged_text", ""),
                    "issue_title": issue.get("issue_title", ""),
                    "issue_detail": issue.get("issue_detail", ""),
                    "fix_note": issue.get("fix_note", ""),
                    "rule_id": issue.get("rule_id", ""),
                    "basis_type": issue.get("basis_type", ""),
                }
                for issue in fail_issues
            ],
        })

        logger.info("Revised caption still failed on round %s. Repairing...", round_no)
        repair_run = repair_failed_revised_caption(
            raw_prompt=raw_prompt,
            rules_block=rules_block,
            quick_reference_block=quick_reference_block,
            original_caption=original_caption,
            failed_revised_candidates=failed_revised_candidates,
            verify_analysis=last_verify_analysis,
            label=f"repair-round-{round_no}",
        )

        if not repair_run.get("ok") or not repair_run.get("repaired_caption"):
            logger.warning("Repair failed on round %s: %s", round_no, repair_run.get("title"))
            return {
                "pass": False,
                "final_caption": candidate,
                "last_candidate": candidate,
                "rounds_used": round_no,
                "note": f"Repair failed: {repair_run.get('title') or 'UNKNOWN ERROR'}; returning latest revised candidate instead of manual review text.",
                "failed_revised_candidates": failed_revised_candidates,
                "last_verify_analysis": last_verify_analysis,
                "last_repair_analysis": last_repair_analysis,
            }

        candidate = repair_run["repaired_caption"]
        last_repair_analysis = repair_run.get("analysis") or {}

    # Important custom behavior requested by user:
    # after 3rd retry still fail, return the latest revised caption as result, not manual review.
    return {
        "pass": False,
        "final_caption": candidate,
        "last_candidate": candidate,
        "rounds_used": MAX_REPAIR_ROUNDS,
        "note": "Max repair rounds reached; returning latest revised candidate instead of manual review text.",
        "failed_revised_candidates": failed_revised_candidates,
        "last_verify_analysis": last_verify_analysis,
        "last_repair_analysis": last_repair_analysis,
    }


# ============================================================
# FINAL OUTPUT
# ============================================================

def build_final_output(
    *,
    original_caption: str,
    initial_result: Dict[str, Any],
    initial_analysis: Dict[str, Any],
    verification: Optional[Dict[str, Any]],
    retrieval_meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    output = deepcopy(initial_result) if isinstance(initial_result, dict) else {}
    if "caption_analysis" not in output or not isinstance(output.get("caption_analysis"), dict):
        output["caption_analysis"] = deepcopy(initial_analysis) if isinstance(initial_analysis, dict) else {}

    analysis = output["caption_analysis"]
    analysis.setdefault("original_message", original_caption)

    if verification:
        final_caption = to_clean_string(verification.get("final_caption"))
        if final_caption:
            analysis["revised_message"] = final_caption
            analysis["revised_caption"] = final_caption

        output["revised_caption_verification"] = {
            "pass": bool(verification.get("pass")),
            "rounds_used": verification.get("rounds_used", 0),
            "note": verification.get("note", ""),
            "last_candidate": verification.get("last_candidate", ""),
            "failed_revised_candidates": verification.get("failed_revised_candidates", []),
        }

        # Keep the model's final analysis for debugging, but do not let it replace the main original analysis.
        if verification.get("last_verify_analysis"):
            output["revised_caption_verification"]["last_verify_analysis"] = verification.get("last_verify_analysis")
        if verification.get("last_repair_analysis"):
            output["revised_caption_verification"]["last_repair_analysis"] = verification.get("last_repair_analysis")
    else:
        output["revised_caption_verification"] = {
            "pass": True,
            "rounds_used": 0,
            "note": "Original caption passed or no repair was needed.",
            "last_candidate": get_revised_caption_from_analysis(analysis),
            "failed_revised_candidates": [],
        }

    output["runtime_meta"] = {
        "model_id": MODEL_ID,
        "mode": "caption_only",
        "max_gemini_attempts": MAX_GEMINI_ATTEMPTS,
        "max_repair_rounds": MAX_REPAIR_ROUNDS,
        "rules_block_max_rules": RULES_BLOCK_MAX_RULES,
        "output_file": str(OUTPUT_JSON_PATH.name),
    }
    if retrieval_meta:
        output["runtime_meta"]["policy_rule_retrieval"] = retrieval_meta

    return output


def run_policy_caption_check(
    caption: str,
    *,
    write_output: bool = False,
) -> Dict[str, Any]:
    """Run policy v2 for one caption and return the full structured output."""
    load_env_from_dotenv_file()

    supabase_url = get_required_env("SUPABASE_URL")
    supabase_key = get_supabase_key()

    caption = to_clean_string(caption)
    if not caption or caption == "paste here":
        raise RuntimeError("Caption is required")

    raw_prompt = read_prompt_template()

    logger.info("=== Standalone JSON-only caption checker START ===")
    all_policy_rows, retrieval_meta = get_policy_rules_for_caption(
        caption,
        supabase_url=supabase_url,
        supabase_key=supabase_key,
    )
    rules_block = build_rules_block(all_policy_rows, max_rules=RULES_BLOCK_MAX_RULES)
    quick_reference_block = build_quick_reference_block()

    logger.info("policy_rule_retrieval=%s", retrieval_meta)
    logger.info("all rules=%s", len(all_policy_rows))
    logger.info("rules_block chars=%s", len(rules_block))
    logger.info("quick_reference_block chars=%s", len(quick_reference_block))

    initial_check = run_caption_only_check(
        raw_prompt=raw_prompt,
        rules_block=rules_block,
        quick_reference_block=quick_reference_block,
        caption=caption,
        label="initial-caption-check",
    )

    if not initial_check.get("ok"):
        error_output = {
            "ok": False,
            "error": {
                "title": initial_check.get("title") or "UNKNOWN ERROR",
                "detail": initial_check.get("detail") or "",
            },
            "runtime_meta": {
                "model_id": MODEL_ID,
                "mode": "caption_only",
                "output_file": str(OUTPUT_JSON_PATH.name),
            },
        }
        if write_output:
            OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
            OUTPUT_JSON_PATH.write_text(json.dumps(error_output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(error_output, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    initial_result = initial_check.get("result") or {}
    initial_analysis = initial_check.get("analysis") or {}

    if is_pass_or_zero_fail_analysis(initial_analysis):
        logger.info("Initial caption result: pass. No repair needed.")
        final_output = build_final_output(
            original_caption=caption,
            initial_result=initial_result,
            initial_analysis=initial_analysis,
            verification=None,
            retrieval_meta=retrieval_meta,
        )
    else:
        logger.info("Initial caption result: fail. Starting revised caption verification/repair.")
        initial_revised_caption = get_revised_caption_from_analysis(initial_analysis)
        verification = ensure_revised_caption_pass(
            raw_prompt=raw_prompt,
            rules_block=rules_block,
            quick_reference_block=quick_reference_block,
            original_caption=caption,
            initial_revised_caption=initial_revised_caption,
        )
        final_output = build_final_output(
            original_caption=caption,
            initial_result=initial_result,
            initial_analysis=initial_analysis,
            verification=verification,
            retrieval_meta=retrieval_meta,
        )

    if write_output:
        OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_JSON_PATH.write_text(json.dumps(final_output, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("Wrote %s", OUTPUT_JSON_PATH)
    logger.info("=== Standalone JSON-only caption checker END ===")

    return final_output


def main() -> None:
    caption = sys.stdin.read().strip()
    if not caption:
        raise RuntimeError("Pass caption text via stdin")
    final_output = run_policy_caption_check(caption, write_output=True)
    print(json.dumps(final_output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
