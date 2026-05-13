"""
Shared helpers: extract text from creative, get image URL, download image.
Project-wide logging: logger and configure_logging; print_log uses logger.info.
Time: get_today_bkk / get_today_bkk_str for Last Assessment At (Bangkok UTC+7).
"""
import hashlib
import logging
import os
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

BKK = ZoneInfo("Asia/Bangkok")

logger = logging.getLogger("meta_ads_checker")
_logging_configured = False


def configure_logging(
    level: str | None = None,
    log_file: str | None = None,
) -> None:
    """Configure project logger: level from env LOG_LEVEL (default INFO), optional file from env LOG_FILE or log_file."""
    global _logging_configured
    if _logging_configured:
        return
    log_level = (level or os.environ.get("LOG_LEVEL") or "INFO").upper()
    level_map = {"DEBUG": logging.DEBUG, "INFO": logging.INFO, "WARNING": logging.WARNING, "ERROR": logging.ERROR}
    logger.setLevel(level_map.get(log_level, logging.INFO))
    if not logger.handlers:
        fmt = logging.Formatter("[%(asctime)s] %(levelname)s – %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        logger.addHandler(sh)
        file_path = log_file or os.environ.get("LOG_FILE")
        if file_path:
            try:
                Path(file_path).parent.mkdir(parents=True, exist_ok=True)
                fh = logging.FileHandler(file_path, encoding="utf-8")
                fh.setFormatter(fmt)
                logger.addHandler(fh)
            except Exception:
                logger.warning("Could not add log file handler for %s", file_path)
    _logging_configured = True


def get_today_bkk() -> date:
    """Today's date in Bangkok (UTC+7). Use for Last Assessment At and for 'today' checks."""
    return datetime.now(BKK).date()


def get_today_bkk_str() -> str:
    """Today in Bangkok as YYYY-MM-DD for sheet 'Last Assessment At'."""
    return get_today_bkk().strftime("%Y-%m-%d")


def get_now_bkk() -> datetime:
    """Current datetime in Bangkok (UTC+7). Use for time-of-day checks (e.g. noon send)."""
    return datetime.now(BKK)


def print_log(log_message: str) -> None:
    """Log message at INFO (uses shared logger; fallback to timestamped print if no handler)."""
    if logger.handlers:
        logger.info(log_message)
    else:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {log_message}")

def extract_text(creative: dict) -> str:
    """Primary copy from AdCreative.body (Graph nested field creative.body)."""
    text = creative.get("body")
    if text is not None and str(text).strip():
        return str(text).strip()
    return "(no caption)"


def get_image_url(creative: dict) -> str | None:
    """
    Return image URL for the creative: image_url or video thumbnail.
    """
    url = creative.get("image_url")
    if url and str(url).strip():
        return str(url).strip()
    url = creative.get("_video_thumbnail_uri")
    if url and str(url).strip():
        return str(url).strip()
    return None


def download_image(url: str, dest_dir: Path, prefix: str = "img") -> Path | None:
    """
    Download image from URL to dest_dir. Return path or None on failure.
    Filename: prefix + hash of URL + .jpg (or keep extension from URL if safe).
    """
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        logger.warning("Download failed for URL %s: %s", url[:80] + "..." if len(url) > 80 else url, e)
        return None

    # Safe suffix: prefer .jpg for simplicity; URL might not have extension
    suffix = ".jpg"
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    name_hash = hashlib.sha256(url.encode()).hexdigest()[:16]
    path = dest_dir / f"{prefix}_{name_hash}{suffix}"
    try:
        path.write_bytes(resp.content)
        logger.debug("Downloaded image to %s", path)
        return path
    except Exception as e:
        logger.warning("Download failed writing to %s: %s", path, e)
        return None
