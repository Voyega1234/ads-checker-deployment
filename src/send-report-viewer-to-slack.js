import fs from "node:fs/promises";
import path from "node:path";
import "./env.js";
import { postSlackMessage } from "./slack.js";
import { uploadScreenshotToSupabase } from "./storage.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jsonPath = args.json || "output/unified-alert-preview-movefast-6placements.json";
  const channelId = args.channel || process.env.SLACK_OVERRIDE_CHANNEL_ID || "C08EA0XE2UU";
  const viewerUrl = args["viewer-url"] || process.env.REPORT_VIEWER_URL;
  if (!viewerUrl && !args["upload-only"]) {
    throw new Error("Missing --viewer-url or REPORT_VIEWER_URL.");
  }

  const alert = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const reportJson = Buffer.from(JSON.stringify(alert, null, 2));
  const reportUrl = await uploadReportJson(alert, reportJson);
  if (args["upload-only"]) {
    console.log(JSON.stringify({ reportUrl }, null, 2));
    return;
  }
  const fullReportUrl = buildViewerUrl(viewerUrl, reportUrl);
  if (args["index-only"]) {
    await logSlackSend({
      alert,
      channelId,
      slackTs: null,
      reportUrl,
      viewerUrl: fullReportUrl,
      status: "indexed"
    });
    console.log(JSON.stringify({ reportUrl, viewerUrl: fullReportUrl, indexed: true }, null, 2));
    return;
  }
  if (!Number(alert.meta?.threadCount || 0) && !args["send-empty"]) {
    console.log(JSON.stringify({ reportUrl, skippedSlack: true, reason: "no_open_issues" }, null, 2));
    return;
  }

  const response = await postSlackMessage({
    botToken: getSlackToken(),
    channelId,
    text: `Ad Compliance Alert: ${alert.meta?.clientName || alert.meta?.accountName || "Report"}`,
    blocks: buildSlackBlocks(alert.meta || {}, fullReportUrl, args["button-style"], args["button-text"])
  });

  await logSlackSend({
    alert,
    channelId,
    slackTs: response.ts,
    reportUrl,
    viewerUrl: fullReportUrl,
    status: "sent"
  });

  console.log(JSON.stringify({ reportUrl, viewerUrl: fullReportUrl, slack: { channelId, ts: response.ts } }, null, 2));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function uploadReportJson(alert, reportJson) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "ads-compliance";
  const prefix = `${process.env.SUPABASE_STORAGE_PREFIX || "ad-preview-checker"}/reports`;
  const client = slugify(alert.meta?.clientName || alert.meta?.accountName || "report");
  const account = `${alert.meta?.accountId || "account"}`.replace(/^act_/, "");
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${client}-${account}-${date}.json`;
  const uploaded = await uploadScreenshotToSupabase({
    supabaseUrl,
    serviceKey,
    bucket,
    prefix,
    fileName,
    buffer: reportJson,
    contentType: "application/json; charset=utf-8"
  });
  return uploaded.publicUrl;
}

function buildViewerUrl(viewerUrl, reportUrl) {
  const url = new URL(viewerUrl);
  url.searchParams.set("report", reportUrl);
  return url.toString();
}

async function logSlackSend({ alert, channelId, slackTs, reportUrl, viewerUrl, status, error }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !serviceKey) return;

  const meta = alert.meta || {};
  const row = {
    alert_type: "ad_compliance_alert",
    account_id: meta.accountId || null,
    account_name: meta.accountName || null,
    client_name: meta.clientName || null,
    channel_id: channelId,
    slack_ts: slackTs || null,
    report_url: reportUrl || null,
    viewer_url: viewerUrl || null,
    report_generated_at: meta.generatedAt || null,
    status,
    error: error || null,
    meta
  };

  const url = `${trimTrailingSlash(supabaseUrl)}/rest/v1/ad_compliance_slack_sends`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(row)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.message || body.error || response.statusText;
      console.warn(`Slack send log skipped: ${response.status} ${message}`);
    }
  } catch (logError) {
    console.warn(`Slack send log skipped: ${logError.message}`);
  }
}

function buildSlackBlocks(meta, reportUrl, buttonStyle, buttonText) {
  const dateLabel = formatDate(meta.generatedAt);
  const clientName = meta.clientName || meta.accountName || "Unknown client";
  const accountId = meta.accountId || "";
  const style = normalizeButtonStyle(buttonStyle);
  const button = {
    type: "button",
    text: { type: "plain_text", text: buttonText || "⎋ View report" },
    url: reportUrl
  };
  if (style) button.style = style;
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "🚨 Ad Compliance Alert" }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMrkdwn(clientName)}* · \`${accountId}\` · ${dateLabel}`
      }
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Affected ads*\n${meta.adCount || 0} ads · ${meta.creativeCount || 0} creatives`
        },
        { type: "mrkdwn", text: `*Policy*\n${meta.policyCreativeCount || 0} creatives` },
        { type: "mrkdwn", text: `*Spelling*\n${meta.spellingCreativeCount || 0} creatives` },
        { type: "mrkdwn", text: `*Placement*\n${meta.placementAdCount || 0} ads` }
      ]
    },
    {
      type: "actions",
      elements: [button]
    }
  ];
}

function getSlackToken() {
  const token = process.env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_OAUTH;
  if (!token) throw new Error("SLACK_BOT_TOKEN or SLACK_BOT_OAUTH is required.");
  return token;
}

function slugify(value) {
  return `${value || "report"}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok"
  }).format(date);
}

function escapeMrkdwn(text) {
  return `${text || ""}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeButtonStyle(value) {
  if (!value) return "";
  const style = String(value).trim().toLowerCase();
  if (!["primary", "danger"].includes(style)) {
    throw new Error(`Invalid --button-style: ${value}`);
  }
  return style;
}

function trimTrailingSlash(value) {
  return `${value || ""}`.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
