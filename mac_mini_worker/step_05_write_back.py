"""
Step 5: write the job result back to Supabase (macmini_worker_jobs).
"""
from __future__ import annotations

from typing import Any

import pipeline as core


def complete(run_id: str, output: dict[str, Any]) -> None:
    """Mark the job successful and store its output_json."""
    supabase = core.get_supabase()
    supabase.table(core.JOBS_TABLE).update(
        {"status": "success", "output_json": output, "finished_at": core._now_iso()}
    ).eq("run_id", run_id).execute()


def fail(run_id: str, error_text: str) -> None:
    """Mark the job failed and store the error text."""
    supabase = core.get_supabase()
    supabase.table(core.JOBS_TABLE).update(
        {"status": "error", "error_text": (error_text or "")[:5000], "finished_at": core._now_iso()}
    ).eq("run_id", run_id).execute()
