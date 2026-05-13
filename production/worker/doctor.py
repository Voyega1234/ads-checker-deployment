#!/usr/bin/env python3
"""
Preflight checks for deploying/running the production worker wrapper.

This script intentionally never prints secret values.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
POLICY_DIR = PROJECT_ROOT / "v2.0_run-all-ad-acc"
SERVICE_ACCOUNT_PATH = POLICY_DIR / "ai-sheet-manager-service-account.json"


REQUIRED_FILES = [
    "package.json",
    "src/index.js",
    "src/build-unified-compliance-alert.js",
    "src/send-report-viewer-to-slack.js",
    "src/env.js",
    "v2.0_run-all-ad-acc/worker.py",
    "v2.0_run-all-ad-acc/env_loader.py",
    "v2.0_run-all-ad-acc/requirements.txt",
    "report-viewer/public/report-viewer.html",
    "production/worker/main.py",
    "production/worker/Dockerfile",
    "production/shared/unified-report.schema.json",
]


ENV_GROUPS = [
    ("META_ACCESS_TOKEN", ["META_ACCESS_TOKEN"]),
    ("GEMINI_API_KEY", ["GEMINI_API_KEY"]),
    ("SUPABASE_URL", ["SUPABASE_URL", "VITE_SUPABASE_URL"]),
    ("SUPABASE_SERVICE_KEY", ["SUPABASE_SERVICE_KEY", "VITE_SUPABASE_SERVICE_KEY", "SUPABASE_KEY"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Check production worker readiness.")
    parser.add_argument("--require-env", action="store_true")
    parser.add_argument("--require-slack", action="store_true")
    parser.add_argument("--require-policy", action="store_true")
    parser.add_argument("--check-node-syntax", action="store_true")
    args = parser.parse_args()

    load_root_env()

    errors: list[str] = []
    warnings: list[str] = []

    check_files(errors)
    check_binaries(errors)
    if args.require_env or args.require_slack:
        check_env(errors, args.require_slack)
    check_policy_secret_mount(errors if args.require_policy else warnings)

    if args.check_node_syntax:
        check_node_syntax(errors)

    print_section("Production worker doctor")
    print(f"project_root: {PROJECT_ROOT}")
    print(f"required_files: {len(REQUIRED_FILES)} checked")
    print(f"node: {'ok' if shutil.which('node') else 'missing'}")
    print(f"python: {sys.executable}")

    if warnings:
        print_section("Warnings")
        for warning in warnings:
            print(f"- {warning}")

    if errors:
        print_section("Errors")
        for error in errors:
            print(f"- {error}")
        return 1

    print_section("Result")
    print("ok")
    return 0


def load_root_env() -> None:
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ[key] = value


def check_files(errors: list[str]) -> None:
    for relative_path in REQUIRED_FILES:
        if not (PROJECT_ROOT / relative_path).exists():
            errors.append(f"Missing required file: {relative_path}")


def check_binaries(errors: list[str]) -> None:
    if not shutil.which("node"):
        errors.append("Missing node binary")
    if not shutil.which("npm"):
        errors.append("Missing npm binary")


def check_env(errors: list[str], require_slack: bool) -> None:
    for label, names in ENV_GROUPS:
        if not any(os.environ.get(name) for name in names):
            errors.append(f"Missing env: {label} ({' or '.join(names)})")
    if require_slack and not (os.environ.get("SLACK_BOT_TOKEN") or os.environ.get("SLACK_BOT_OAUTH")):
        errors.append("Missing env: SLACK_BOT_TOKEN or SLACK_BOT_OAUTH")
    if require_slack and not os.environ.get("REPORT_VIEWER_URL"):
        print(
            "warning: REPORT_VIEWER_URL is not set; worker defaults to "
            "https://report-viewer-theta.vercel.app/report-viewer"
        )


def check_policy_secret_mount(messages: list[str]) -> None:
    if not SERVICE_ACCOUNT_PATH.exists():
        messages.append(
            "Google service account JSON not found at "
            "v2.0_run-all-ad-acc/ai-sheet-manager-service-account.json. "
            "For Cloud Run, mount it as a secret at that exact path."
        )


def check_node_syntax(errors: list[str]) -> None:
    command = [
        "node",
        "--input-type=module",
        "-e",
        (
            "import fs from 'node:fs';"
            "const html=fs.readFileSync('report-viewer/public/report-viewer.html','utf8');"
            "const script=html.match(/<script>([\\s\\S]*)<\\/script>/)?.[1];"
            "new Function(script);"
        ),
    ]
    result = subprocess.run(command, cwd=PROJECT_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        errors.append(f"Report viewer script syntax failed: {result.stderr.strip()}")


def print_section(title: str) -> None:
    print(f"\n== {title} ==")


if __name__ == "__main__":
    raise SystemExit(main())
