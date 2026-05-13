import fs from "node:fs/promises";

function buildPrompt(format, creativeObjectType) {
  return `CONTEXT:
Placement: ${format}
Creative type: ${creativeObjectType}

ROLE:
Act as a Performance Marketing QA system.
Your job is to detect only critical visual failures that prevent users from understanding the ad.

Do NOT flag minor issues.

---

EVALUATION RULE:

Only return FAIL if at least ONE strict failure condition is clearly met.
If none are met -> return PASS.

If uncertain -> return PASS.

---

STRICT FAILURE DEFINITIONS:

1. FAIL: BROKEN_READABILITY
Trigger ONLY if:
- Text is physically cut off by the image boundary
- AND at least one word is incomplete

Example:
"Discount" -> "iscount"

---

2. FAIL: CRITICAL_OBSTRUCTION
Trigger ONLY if:
- Platform UI elements (CTA button, caption area, or interaction icons) overlap text
- AND the overlapped text includes:
  - price OR
  - discount OR
  - CTA (e.g., "Buy Now", "Shop Now")

Ignore logo or decorative text.
Return PASS if the UI is only adjacent to the text and all characters remain fully readable.
For phone numbers, return FAIL only if one or more digits are physically covered or unreadable.
Do not fail if the UI overlaps background or whitespace only.
Do not fail for UI that sits below the creative unless it physically covers characters inside the ad.

---

3. FAIL: LEGIBILITY_LOSS
Trigger ONLY if:
- Text contrast is extremely low
- AND the main message cannot be read

Do NOT trigger for slightly low contrast.

---

4. FAIL: CROPPED_SUBJECT
Trigger ONLY if:
- A person, product, or logo is physically cut off by the image boundary
- AND the cut removes a key part of the subject
- AND the ad becomes hard to understand because of that crop

Return PASS if the subject is merely close to the edge but still understandable.
Return PASS if only a non-essential background area is cut off.
For logos, return FAIL only if the logo itself is visibly cut off by the frame.

For VIDEO creatives in INSTAGRAM_STORY, INSTAGRAM_REELS, FACEBOOK_STORY_MOBILE, or FACEBOOK_REELS_MOBILE:
- be conservative
- do NOT fail just because a person or object is partially near/crossing the edge in a paused frame
- only fail if the crop is clearly severe and the frame is unusable on its own

---

IMPORTANT CONSTRAINTS:

- Do NOT evaluate layout preference
- Do NOT evaluate spacing
- Do NOT evaluate aesthetics
- Do NOT guess intent
- Do NOT infer obstruction from proximity alone
- Do not add extra commentary

---

OUTPUT FORMAT (STRICT):
Return exactly this format:

STATUS: PASS | FAIL
ADJUSTMENT_REQUIRED: No | Yes: <specific fix>
RATIONALE: <one-line finding>

---

RATIONALE RULE (UPDATED):

- If PASS:
  -> must be exactly:
    No failure conditions met.

- If FAIL:
  -> must be ONE short line, in "finding style":
     <affected element> + <issue>

  -> Writing rules:
    - one line only
    - simple, direct language
    - no FAIL_TYPE
    - no explanation
    - no repetition

  -> Examples:
     Price text ถูก CTA บังบางส่วน
     เบอร์โทรถูก CTA บังบางส่วน
     ข้อความถูกตัดขอบ ทำให้อ่านไม่ครบ
     ข้อความหลักอ่านไม่ออกจาก contrast ต่ำ

---

EXAMPLES:

PASS:
STATUS: PASS
ADJUSTMENT_REQUIRED: No
RATIONALE: No failure conditions met.

FAIL:
STATUS: FAIL
ADJUSTMENT_REQUIRED: Yes: Move the price text away from CTA area
RATIONALE: Price text ถูก CTA บังบางส่วน

FAIL:
STATUS: FAIL
ADJUSTMENT_REQUIRED: Yes: Reposition phone number higher
RATIONALE: เบอร์โทรถูก CTA บังบางส่วน

END OF INSTRUCTIONS`;
}

export async function validateScreenshotWithGemini({
  config,
  screenshotPath,
  imageBuffer,
  format = "UNKNOWN",
  creativeObjectType = "UNKNOWN"
}) {
  if (!config.geminiApiKey) return null;

  const imageBytes = imageBuffer || (await fs.readFile(screenshotPath));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.geminiTimeoutMs);
  let response;

  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.geminiApiKey
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inline_data: {
                    mime_type: "image/png",
                    data: imageBytes.toString("base64")
                  }
                },
                {
                  text: buildPrompt(format, creativeObjectType)
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            topP: 0.1,
            responseMimeType: "text/plain"
          }
        })
      }
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Gemini API request timed out after ${config.geminiTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload.error?.message || response.statusText;
    throw new Error(`Gemini API error ${response.status}: ${message}`);
  }

  const rawText = extractText(payload).trim();
  if (!rawText) {
    throw new Error("Gemini returned an empty response.");
  }

  const parsed = parseGeminiValidation(rawText);

  return {
    provider: "gemini",
    model: config.geminiModel,
    rawText,
    parsed,
    usage: payload.usageMetadata || null,
    analysis: geminiResultToAnalysis(parsed)
  };
}

function extractText(payload) {
  return (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function parseGeminiValidation(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const status = valueFor(lines, "STATUS");
  const adjustmentRequired = valueFor(lines, "ADJUSTMENT_REQUIRED");
  const rationale = valueFor(lines, "RATIONALE");

  if (!status || !adjustmentRequired || !rationale) {
    throw new Error(`Gemini response did not match expected format: ${text}`);
  }

  if (!["PASS", "FAIL"].includes(status)) {
    throw new Error(`Gemini returned unsupported status: ${status}`);
  }

  return { status, adjustmentRequired, rationale };
}

function valueFor(lines, key) {
  const line = lines.find((entry) => entry.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : "";
}

function geminiResultToAnalysis(parsed) {
  if (parsed.status === "PASS") {
    return {
      risk: "ok",
      issues: [],
      source: "gemini",
      verdict: parsed
    };
  }

  return {
    risk: "high",
    source: "gemini",
    verdict: parsed,
    issues: [
      {
        severity: "high",
        code: "gemini_visual_failure",
        message: parsed.rationale,
        details: {
          adjustmentRequired: parsed.adjustmentRequired
        }
      }
    ]
  };
}
