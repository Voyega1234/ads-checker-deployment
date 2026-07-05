"""
Central Gemini auth utility — mirrors src/google-adc.js.

GEMINI_AUTH_MODE (default: "adc"):
  adc       — google.auth.default() / Application Default Credentials
  api_key   — GEMINI_API_KEY env var
"""
from __future__ import annotations

import os
from typing import Any, Dict


def get_gemini_auth_mode() -> str:
    mode = os.getenv("GEMINI_AUTH_MODE", "adc").strip().lower()
    if mode in {"api-key", "api_key", "apikey"}:
        return "api_key"
    if mode in {"adc", "oauth", "application-default", "application_default_credentials"}:
        return "adc"
    raise ValueError(f"Unsupported GEMINI_AUTH_MODE: {mode!r}")


def create_gemini_client():
    from google import genai

    mode = get_gemini_auth_mode()
    if mode == "api_key":
        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is required when GEMINI_AUTH_MODE=api_key")
        return genai.Client(api_key=api_key)

    import google.auth

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    # Ensure the SDK uses generativelanguage.googleapis.com, not Vertex AI.
    os.environ.pop("GOOGLE_GENAI_USE_ENTERPRISE", None)
    os.environ.pop("GOOGLE_GENAI_USE_VERTEXAI", None)
    return genai.Client(credentials=credentials)


def get_gemini_http_headers() -> Dict[str, Any]:
    mode = get_gemini_auth_mode()
    if mode == "api_key":
        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is required when GEMINI_AUTH_MODE=api_key")
        return {"x-goog-api-key": api_key}
    return {"Authorization": f"Bearer {_get_bearer_token()}"}


def _get_bearer_token() -> str:
    import google.auth
    import google.auth.transport.requests

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(google.auth.transport.requests.Request())
    return credentials.token
