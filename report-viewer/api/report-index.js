const TABLE_NAME = process.env.AD_COMPLIANCE_SLACK_SENDS_TABLE || "ad_compliance_slack_sends";

module.exports = async function handler(request, response) {
  setCors(response, request);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const clientName = `${request.query.clientName || ""}`.trim();
    if (!clientName) {
      response.status(400).json({ error: "clientName is required" });
      return;
    }

    const rows = await supabaseFetch(
      `/${TABLE_NAME}?select=client_name,account_id,account_name,report_url,viewer_url,report_generated_at,channel_id,slack_ts,meta&client_name=eq.${encodeURIComponent(clientName)}&status=in.(sent,indexed)&report_url=not.is.null&order=report_generated_at.desc.nullslast&limit=200`,
      { method: "GET" }
    );

    const latestByAccount = new Map();
    for (const row of rows || []) {
      const accountId = normalizeAccountId(row.account_id);
      if (!accountId || latestByAccount.has(accountId)) continue;
      latestByAccount.set(accountId, {
        clientName: row.client_name || clientName,
        accountId,
        accountName: row.account_name || row.meta?.accountName || accountId,
        reportUrl: row.report_url,
        viewerUrl: row.viewer_url,
        reportGeneratedAt: row.report_generated_at || row.meta?.generatedAt || null,
        channelId: row.channel_id || null,
        slackTs: row.slack_ts || null,
        counts: {
          ads: Number(row.meta?.adCount || 0),
          creatives: Number(row.meta?.creativeCount || 0),
          policy: Number(row.meta?.policyCreativeCount || 0),
          spelling: Number(row.meta?.spellingCreativeCount || 0),
          placement: Number(row.meta?.placementAdCount || 0),
          threads: Number(row.meta?.threadCount || 0)
        }
      });
    }

    response.status(200).json({ clientName, reports: Array.from(latestByAccount.values()) });
  } catch (error) {
    response.status(500).json({ error: error.message || "Unexpected error" });
  }
};

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
  const result = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await result.text();
  const json = text ? JSON.parse(text) : null;
  if (!result.ok) {
    throw new Error(json?.message || json?.error || `Supabase request failed: ${result.status}`);
  }
  return json;
}

function normalizeAccountId(value) {
  const raw = `${value || ""}`.trim();
  if (!raw) return "";
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://report-viewer-theta.vercel.app")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function setCors(response, request) {
  const origin = request.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  response.setHeader("Access-Control-Allow-Origin", allowed);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
