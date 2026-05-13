const TABLE_NAME = process.env.AD_COMPLIANCE_STATE_TABLE || "ad_compliance_issue_states";

module.exports = async function handler(request, response) {
  setCors(response, request);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  try {
    if (request.method === "GET") {
      await handleGet(request, response);
      return;
    }
    if (request.method === "POST") {
      await handlePost(request, response);
      return;
    }
    response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    response.status(500).json({ error: error.message || "Unexpected error" });
  }
};

async function handleGet(request, response) {
  const reportId = `${request.query.reportId || ""}`.trim();
  if (!reportId) {
    response.status(400).json({ error: "reportId is required" });
    return;
  }

  const result = await supabaseFetch(
    `/${TABLE_NAME}?report_id=eq.${encodeURIComponent(reportId)}&select=issue_key,resolved,resolved_at,resolved_by,updated_at`,
    { method: "GET" }
  );
  response.status(200).json({ states: result });
}

async function handlePost(request, response) {
  const body = parseBody(request.body);
  const reportId = `${body.reportId || ""}`.trim();
  const issueKey = `${body.issueKey || ""}`.trim();
  if (!reportId || !issueKey) {
    response.status(400).json({ error: "reportId and issueKey are required" });
    return;
  }

  const resolved = Boolean(body.resolved);
  const now = new Date().toISOString();
  const payload = {
    report_id: reportId,
    issue_key: issueKey,
    resolved,
    resolved_at: resolved ? now : null,
    resolved_by: body.resolvedBy ? `${body.resolvedBy}`.slice(0, 120) : null,
    updated_at: now
  };

  const result = await supabaseFetch(
    `/${TABLE_NAME}?on_conflict=report_id,issue_key`,
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload)
    }
  );
  response.status(200).json({ state: result?.[0] || payload });
}

async function supabaseFetch(path, options) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.VITE_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase env is not configured");
  }

  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(json?.message || json?.error || `Supabase request failed: ${response.status}`);
  }
  return json;
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") return JSON.parse(body);
  return body;
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://report-viewer-theta.vercel.app")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function setCors(response, request) {
  const origin = request.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  response.setHeader("Access-Control-Allow-Origin", allowed);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
