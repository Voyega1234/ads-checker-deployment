"""Shared environment loading for the ad checker worker.

The project-level .env is the source of truth for secrets. Keep worker-local
defaults out of the secret load path so stale tokens cannot shadow root values.
"""

from __future__ import annotations

from pathlib import Path
import os

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
PROJECT_ENV_PATH = PROJECT_ROOT / ".env"


def load_project_env() -> None:
    load_dotenv(PROJECT_ENV_PATH, override=True)
    _alias_env("SUPABASE_URL", "VITE_SUPABASE_URL")
    _alias_env("SUPABASE_SERVICE_KEY", "VITE_SUPABASE_SERVICE_KEY")
    _alias_env("SLACK_BOT_TOKEN", "SLACK_BOT_OAUTH")


def _alias_env(target: str, source: str) -> None:
    if os.environ.get(target):
        return
    value = os.environ.get(source)
    if value:
        os.environ[target] = value
