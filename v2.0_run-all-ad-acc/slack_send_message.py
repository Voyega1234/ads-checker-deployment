"""
Send report (initial + thread_replies) to Slack via chat.postMessage API.
- initial: sent as the first message.
- thread_replies: sent one by one as replies in that message's thread.
Set SLACK_BOT_TOKEN in .env. Channel can be passed or use SLACK_CHANNEL for CLI.
"""
import json
import os
import sys
from pathlib import Path

import requests
from env_loader import load_project_env

load_project_env()

MAX_SLACK_TEXT = 40000  # Slack limit per message
SLACK_API_URL = "https://slack.com/api/chat.postMessage"

# When debug mode is on, send to this channel instead of client's channel
SLACK_DEBUG_CHANNEL = "C08EA0XE2UU"


def format_slack_user_mention_line(*user_ids: str | None) -> str:
    """
    Build a single line of Slack user mentions + trailing newline, or "" if none.
    Accepts raw member IDs (e.g. U01...) or existing <@U...> tokens; skips empty and literal 'null'.
    """
    parts: list[str] = []
    for raw in user_ids:
        s = (raw or "").strip()
        if not s or s.lower() == "null":
            continue
        if s.startswith("<@") and ">" in s:
            end = s.index(">")
            token = s[: end + 1]
            if token not in parts:
                parts.append(token)
            continue
        parts.append(f"<@{s}>")
    return (" ".join(parts) + "\n") if parts else ""


def send_slack_message(
    token: str, channel: str, text: str, *, thread_ts: str | None = None
) -> str | None:
    """POST one message to Slack. Returns message ts on success, None on failure."""
    if not token or not channel:
        return None
    try:
        payload: dict = {"channel": channel, "text": text}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        r = requests.post(
            SLACK_API_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            return None
        return data.get("ts")
    except requests.RequestException:
        return None


def send_slack_report(
    token: str, channel: str, report: dict, *, logger=None
) -> bool:
    """
    Send report (dict with 'initial' and 'thread_replies') to Slack.
    Returns True if all messages sent, False otherwise.
    """
    if not report:
        return False
    initial = (report.get("initial") or "").strip()
    thread_replies = report.get("thread_replies") or []
    if not initial and not thread_replies:
        return False
    ts = None
    if initial:
        ts = send_slack_message(token, channel, initial)
        if ts is None:
            if logger:
                logger.warning("Slack: failed to send initial message")
            return False
    for text in thread_replies:
        if not (text or "").strip():
            continue
        if ts is None:
            ts = send_slack_message(token, channel, text)
            if ts is None:
                if logger:
                    logger.warning("Slack: failed to send first reply")
                return False
            continue
        if len(text) <= MAX_SLACK_TEXT:
            if send_slack_message(token, channel, text, thread_ts=ts) is None:
                if logger:
                    logger.warning("Slack: failed to send thread reply")
                return False
        else:
            offset = 0
            while offset < len(text):
                chunk = text[offset : offset + MAX_SLACK_TEXT]
                if offset + MAX_SLACK_TEXT < len(text):
                    last_nl = chunk.rfind("\n")
                    if last_nl > MAX_SLACK_TEXT // 2:
                        chunk = text[offset : offset + last_nl + 1]
                        offset += last_nl + 1
                    else:
                        offset += MAX_SLACK_TEXT
                else:
                    offset = len(text)
                if send_slack_message(token, channel, chunk, thread_ts=ts) is None:
                    if logger:
                        logger.warning("Slack: failed to send chunked reply")
                    return False
    return True


def main() -> None:
    """CLI: send slack_report.json to Slack. Uses SLACK_BOT_TOKEN and SLACK_CHANNEL from env."""
    script_dir = Path(__file__).resolve().parent
    report_path = script_dir / "reports" / "slack_report.json"
    if len(sys.argv) >= 2:
        report_path = Path(sys.argv[1])
    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    channel = os.environ.get("SLACK_CHANNEL", "").strip()
    if len(sys.argv) >= 4:
        token, channel = sys.argv[2].strip(), sys.argv[3].strip()
    elif len(sys.argv) >= 3:
        channel = sys.argv[2].strip()
    if not token or not channel:
        print("Set SLACK_BOT_TOKEN and SLACK_CHANNEL in .env or pass: report_path [token] channel", file=sys.stderr)
        sys.exit(1)
    if not report_path.exists():
        print(f"Report not found: {report_path}", file=sys.stderr)
        sys.exit(1)
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)
    if not send_slack_report(token, channel, data):
        print("Slack send failed.", file=sys.stderr)
        sys.exit(1)
    print("Report sent to Slack.")


if __name__ == "__main__":
    main()
