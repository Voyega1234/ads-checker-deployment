"""
Gemini assessment: call model with prompt + optional image; return raw response text.
No parsing of JSON output in this phase.
"""
from pathlib import Path

from google import genai

import creative_utils


def run_assessment(
    prompt_content: str,
    creative_text: str,
    image_path: Path | None,
    api_key: str,
) -> str | dict:
    """
    Call Gemini with prompt ({{Message}} already replaced by caller).
    If image_path is set, send text + image. Return raw response text.
    On API or exception return {"_error": "..."}.
    """
    message = (creative_text or "").strip() or "(no caption)"
    prompt = prompt_content.replace("{{Message}}", message)
    has_image = image_path is not None and Path(image_path).exists()
    creative_utils.logger.debug("Calling Gemini, has_image=%s", has_image)

    try:
        client = genai.Client(api_key=api_key)
        if not has_image:
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
            )
        else:
            path = Path(image_path)
            image_bytes = path.read_bytes()
            mime = "image/jpeg"
            if path.suffix.lower() in (".png",):
                mime = "image/png"
            contents = [
                {
                    "role": "user",
                    "parts": [
                        {
                            "inline_data": {
                                "data": image_bytes,
                                "mime_type": mime,
                            }
                        },
                        {"text": prompt},
                    ],
                }
            ]
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=contents,
            )
        raw = (response.text or "").strip()
        if raw:
            creative_utils.logger.debug("Gemini response length %d", len(raw))
            return raw
        creative_utils.logger.warning("Gemini returned empty response")
        return {"_error": "[Empty response]"}
    except Exception as e:
        creative_utils.logger.error("Gemini assessment error: %s", e)
        return {"_error": f"[Error assessing: {e}]"}
