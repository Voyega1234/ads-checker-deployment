import "./env.js";
import { spawn } from "node:child_process";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Summarise each card's policy reasons into one short Thai line via Gemini.
// Input: [{ index, reasons: [string] }]. Returns Map<index, summary>.
// Any failure (no key, HTTP error, timeout, malformed JSON) yields an empty Map
// so callers fall back to listing the reasons verbatim — this must never block a
// Slack send or fabricate content on error.
export async function summarizeCardReasons(cards, { maxChars = 120, timeoutMs = 20000 } = {}) {
  const result = new Map();
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
  const items = (cards || []).filter((card) => Array.isArray(card.reasons) && card.reasons.length);
  if (!apiKey || !items.length) return result;

  const prompt =
    "คุณคือผู้ช่วยสรุปประเด็นการตรวจสอบโฆษณา (ad compliance) เป็นภาษาไทย\n" +
    `สำหรับแต่ละรายการ ให้สรุป "สาเหตุที่ผิด" ทั้งหมดให้เหลือประโยคเดียว สั้น กระชับ ไม่เกิน ${maxChars} ตัวอักษร\n` +
    "ข้อกำหนดสำคัญ: ต้องครอบคลุมทุกสาเหตุที่ให้มา ห้ามเพิ่มประเด็นใหม่ ห้ามตัดประเด็นที่ผิดทิ้ง " +
    "ใช้ถ้อยคำกลาง ๆ ไม่ต้องใส่เครื่องหมายคำพูด ไม่ต้องใส่ markdown\n" +
    "ตอบเป็น JSON array ตาม schema ที่กำหนดเท่านั้น\n\n" +
    JSON.stringify(items.map((card) => ({ index: card.index, reasons: card.reasons })));

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            index: { type: "INTEGER" },
            summary: { type: "STRING" }
          },
          required: ["index", "summary"]
        }
      }
    }
  };
  const url = `${GEMINI_ENDPOINT}/${model}:generateContent`;

  try {
    const payload = await postGeminiJson(url, apiKey, requestBody, timeoutMs);
    const text = (payload.candidates || [])
      .flatMap((candidate) => candidate.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();
    if (!text) return result;

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return result;
    for (const row of parsed) {
      const idx = Number(row?.index);
      const summary = String(row?.summary || "").replace(/\s+/g, " ").trim();
      if (Number.isInteger(idx) && summary) result.set(idx, summary);
    }
  } catch (error) {
    console.error(`Catalog AI summary skipped: ${error.message}`);
    return result;
  }
  return result;
}

async function postGeminiJson(url, apiKey, body, timeoutMs) {
  try {
    return await postJsonWithCurl(url, apiKey, body, timeoutMs);
  } catch (curlError) {
    try {
      return await postJsonWithFetch(url, apiKey, body, timeoutMs);
    } catch (fetchError) {
      throw new Error(`curl=${curlError.message}; fetch=${fetchError.message}`);
    }
  }
}

async function postJsonWithFetch(url, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postJsonWithCurl(url, apiKey, body, timeoutMs) {
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const child = spawn("curl", [
    "-sS",
    "--max-time",
    String(timeoutSec),
    "-X",
    "POST",
    "-H",
    "content-type: application/json",
    "-H",
    `x-goog-api-key: ${apiKey}`,
    "--data-binary",
    "@-",
    url
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(body));

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`curl exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`);
  }
  const payload = JSON.parse(stdout || "{}");
  if (payload.error) {
    throw new Error(`Gemini HTTP ${payload.error.code || "error"}: ${payload.error.message || "unknown error"}`);
  }
  return payload;
}
