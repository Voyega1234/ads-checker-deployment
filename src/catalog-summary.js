import "./env.js";
import { buildGeminiAuthHeaders } from "./google-adc.js";

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
  if (!items.length) return result;

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
    const authHeaders = await buildGeminiAuthHeaders(apiKey);
    if (!authHeaders) return result;
    const payload = await postGeminiJson(url, authHeaders, requestBody, timeoutMs);
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

async function postGeminiJson(url, authHeaders, body, timeoutMs) {
  return await postJsonWithFetch(url, authHeaders, body, timeoutMs);
}

async function postJsonWithFetch(url, authHeaders, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
