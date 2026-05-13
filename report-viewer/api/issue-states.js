const TABLE_NAME = process.env.AD_COMPLIANCE_STATE_TABLE || "ad_compliance_issue_states";
const RESOLUTION_TABLE_NAME =
  process.env.AD_COMPLIANCE_RESOLUTION_TABLE || "ad_compliance_issue_resolutions";

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
  const fingerprints = parseCsv(request.query.fingerprints).slice(0, 200);
  if (!reportId && !fingerprints.length) {
    response.status(400).json({ error: "reportId or fingerprints is required" });
    return;
  }

  const [states, resolutions] = await Promise.all([
    reportId
      ? fetchReportStates(reportId)
      : [],
    fingerprints.length
      ? supabaseFetch(
          `/${RESOLUTION_TABLE_NAME}?issue_fingerprint=in.(${fingerprints.map(encodeURIComponent).join(",")})&resolved=eq.true&select=issue_fingerprint,account_id,issue_type,issue_key,resolved,resolved_at,resolved_by,updated_at`,
          { method: "GET" }
        ).catch(() => [])
      : []
  ]);
  response.status(200).json({ states, resolutions });
}

async function fetchReportStates(reportId) {
  try {
    return await supabaseFetch(
      `/${TABLE_NAME}?report_id=eq.${encodeURIComponent(reportId)}&select=issue_key,issue_fingerprint,account_id,issue_type,resolved,resolved_at,resolved_by,updated_at`,
      { method: "GET" }
    );
  } catch {
    return supabaseFetch(
      `/${TABLE_NAME}?report_id=eq.${encodeURIComponent(reportId)}&select=issue_key,resolved,resolved_at,resolved_by,updated_at`,
      { method: "GET" }
    );
  }
}

async function handlePost(request, response) {
  const body = parseBody(request.body);
  const reportId = `${body.reportId || ""}`.trim();
  const issueKey = `${body.issueKey || ""}`.trim();
  const issueFingerprint = `${body.issueFingerprint || ""}`.trim();
  const accountId = `${body.accountId || ""}`.trim();
  const issueType = `${body.issueType || "mixed"}`.trim().slice(0, 80);
  if (!reportId || !issueKey) {
    response.status(400).json({ error: "reportId and issueKey are required" });
    return;
  }

  const resolved = Boolean(body.resolved);
  const now = new Date().toISOString();
  const payload = {
    report_id: reportId,
    issue_key: issueKey,
    issue_fingerprint: issueFingerprint || null,
    account_id: accountId || null,
    issue_type: issueType || null,
    resolved,
    resolved_at: resolved ? now : null,
    resolved_by: body.resolvedBy ? `${body.resolvedBy}`.slice(0, 120) : null,
    updated_at: now
  };

  let result;
  try {
    result = await supabaseFetch(
      `/${TABLE_NAME}?on_conflict=report_id,issue_key`,
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(payload)
      }
    );
  } catch (error) {
    result = await supabaseFetch(
      `/${TABLE_NAME}?on_conflict=report_id,issue_key`,
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({
          report_id: reportId,
          issue_key: issueKey,
          resolved,
          resolved_at: resolved ? now : null,
          resolved_by: body.resolvedBy ? `${body.resolvedBy}`.slice(0, 120) : null,
          updated_at: now
        })
      }
    );
  }

  if (issueFingerprint) {
    await supabaseFetch(
      `/${RESOLUTION_TABLE_NAME}?on_conflict=issue_fingerprint`,
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          issue_fingerprint: issueFingerprint,
          account_id: accountId || null,
          issue_type: issueType || null,
          issue_key: issueKey,
          resolved,
          resolved_at: resolved ? now : null,
          resolved_by: body.resolvedBy ? `${body.resolvedBy}`.slice(0, 120) : null,
          updated_at: now
        })
      }
    ).catch(() => null);
  }
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

function parseCsv(value) {
  return `${value || ""}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
