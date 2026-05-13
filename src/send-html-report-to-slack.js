import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { postSlackMessage } from "./slack.js";
import { uploadScreenshotToSupabase } from "./storage.js";

dotenv.config();
dotenv.config({ path: path.resolve("v2.0_run-all-ad-acc/.env"), override: true });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const htmlPath = args.html || "output/unified-alert-preview-movefast-6placements.html";
  const jsonPath = args.json || "output/unified-alert-preview-movefast-6placements.json";
  const channelId = args.channel || process.env.SLACK_OVERRIDE_CHANNEL_ID || "C08EA0XE2UU";

  const alert = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const html = await fs.readFile(htmlPath);
  const reportUrl = await uploadReportHtml(alert, html);
  const response = await postSlackMessage({
    botToken: getSlackToken(),
    channelId,
    text: `Ad Compliance Alert: ${alert.meta?.clientName || alert.meta?.accountName || "Report"}`,
    blocks: buildSlackBlocks(alert.meta || {}, reportUrl)
  });

  console.log(JSON.stringify({ reportUrl, slack: { channelId, ts: response.ts } }, null, 2));
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

async function uploadReportHtml(alert, html) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "ads-placement";
  const prefix = `${process.env.SUPABASE_STORAGE_PREFIX || "ad-preview-checker"}/reports`;
  const client = slugify(alert.meta?.clientName || alert.meta?.accountName || "report");
  const account = `${alert.meta?.accountId || "account"}`.replace(/^act_/, "");
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${client}-${account}-${date}.html`;
  const uploaded = await uploadScreenshotToSupabase({
    supabaseUrl,
    serviceKey,
    bucket,
    prefix,
    fileName,
    buffer: html,
    contentType: "text/html; charset=utf-8"
  });
  return uploaded.publicUrl;
}

function buildSlackBlocks(meta, reportUrl) {
  const dateLabel = formatDate(meta.generatedAt);
  const clientName = meta.clientName || meta.accountName || "Unknown client";
  const accountId = meta.accountId || "";
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
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View full report" },
          url: reportUrl
        }
      ]
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
