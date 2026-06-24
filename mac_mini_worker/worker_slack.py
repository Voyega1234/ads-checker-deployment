"""
Slack policy worker.

Polls macmini_worker_jobs for job_source=slack_alert and runs the shared
mac_mini_worker pipeline in caption-only mode for Slack Catalog.
"""
from __future__ import annotations

import argparse
from typing import Any

import pipeline


def extract_queue_input(job: dict[str, Any]) -> dict[str, Any]:
    input_json = job.get("input_json") or {}
    metadata_json = job.get("metadata_json") or {}

    caption = str(input_json.get("caption") or "").strip()
    if not caption:
        raise ValueError("input_json.caption is required")

    client_id = str(metadata_json.get("client_id") or "").strip() or None

    return {
        "caption": caption,
        # Slack currently sends caption-only jobs. Keep image disabled until the
        # Slack flow explicitly supports image policy checks.
        "image_url": None,
        "recheck_until_pass": bool(input_json.get("recheck_until_pass", False)),
        "max_recheck_attempts": int(input_json.get("max_recheck_attempts", 3)),
        "process_image": False,
        "client_id": client_id,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Slack policy queue worker.")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=None,
        help=(
            "Number of caption jobs to process at once. Defaults to "
            "MACMINI_WORKER_CONCURRENCY/WORKER_CONCURRENCY or 1."
        ),
    )
    args = parser.parse_args()
    pipeline.run_loop("slack_alert", extract_queue_input, concurrency=args.concurrency)


if __name__ == "__main__":
    main()
