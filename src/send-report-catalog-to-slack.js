import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import "./env.js";
import { postSlackMessage } from "./slack.js";
import { uploadScreenshotToSupabase } from "./storage.js";

const DEFAULT_PLACEHOLDER_IMAGE = "https://dummyimage.com/728x666/f6f7f8/1f2937.png&text=Ad+Compliance";
const CARD_BODY_TEXT_LIMIT = 200;
const CARD_FLAGGED_TEXTS_LIMIT = 85;
const REVISED_TEXT_PREVIEW_LIMIT = 2500;
const REVISED_TEXT_CHUNK_LIMIT = 2500;
const execFileAsync = promisify(execFile);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jsonPath = args.json || "output/unified-alert-preview-movefast-6placements.json";
  const channelId = args.channel || process.env.SLACK_OVERRIDE_CHANNEL_ID || "C08EA0XE2UU";
  const alert = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const maxCards = parsePositiveInt(args["max-cards"], 10);
  const issueIndexOffset = parseNonNegativeInt(args["issue-index-offset"], 0);
  const fitImages = args["no-fit-images"] === true
    ? false
    : args["fit-images"] === true || envFlag("CATALOG_FIT_IMAGES", true);
  const cacheImages = args["no-cache-images"] === true
    ? false
    : fitImages || args["cache-images"] === true || envFlag("CATALOG_CACHE_IMAGES", true);
  const blocks = await buildCatalogBlocks(alert, {
    maxCards,
    cacheImages,
    fitImages,
    issueIndexOffset
  });

  if (args["dry-run-blocks"]) {
    console.log(JSON.stringify({ blocks }, null, 2));
    return;
  }

  const reportUrl = args["upload-report"]
    ? await uploadReportJson(alert, Buffer.from(JSON.stringify(alert, null, 2)))
    : null;

  if (!Number(alert.meta?.threadCount || 0) && !args["send-empty"]) {
    console.log(JSON.stringify({ reportUrl, skippedSlack: true, reason: "no_open_issues" }, null, 2));
    return;
  }

  const response = await postSlackMessage({
    botToken: getSlackToken(),
    channelId,
    text: `Ad Compliance Catalog: ${alert.meta?.clientName || alert.meta?.accountName || "Report"}`,
    blocks
  });

  if (args["log-send"]) {
    await logSlackSend({
      alert,
      channelId,
      slackTs: response.ts,
      reportUrl,
      status: "sent"
    });
    await logSlackSendIssues({
      alert,
      channelId,
      slackTs: response.ts,
      reportUrl,
      maxCards,
      issueIndexOffset
    });
  }

  console.log(JSON.stringify({ reportUrl, slack: { channelId, ts: response.ts } }, null, 2));
}

async function buildCatalogBlocks(alert, { maxCards, cacheImages, fitImages, issueIndexOffset }) {
  const meta = alert.meta || {};
  const clientName = meta.clientName || meta.accountName || "Unknown client";
  const accountId = meta.accountId || "";
  const cards = [];
  const visibleThreads = getSortedVisibleThreads(alert);
  for (const [index, thread] of visibleThreads.slice(0, maxCards).entries()) {
    cards.push(
      await buildAdCard(thread, index + issueIndexOffset, meta, {
        cacheImages,
        fitImages
      })
    );
  }

  const summary = [
    `*${escapeMrkdwn(clientName)}* · \`${escapeMrkdwn(accountId)}\` · ${formatDate(meta.generatedAt)}`,
    `${Number(meta.adCount || 0)} ads · ${Number(meta.creativeCount || 0)} creatives`,
    `Policy ${Number(meta.policyCreativeCount || 0)} · Spelling ${Number(meta.spellingCreativeCount || 0)} · Placement ${Number(meta.placementAdCount || 0)}`
  ].join("\n");

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Ad Compliance Catalog*\n${summary}`
      }
    }
  ];

  if (!cards.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "No open ad compliance issues." }
    });
    return blocks;
  }

  blocks.push({
    type: "carousel",
    elements: cards
  });

  if (visibleThreads.length > cards.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Showing ${cards.length} of ${visibleThreads.length} issue cards.`
        }
      ]
    });
  }

  return blocks;
}

async function buildAdCard(thread, index, meta, { cacheImages, fitImages }) {
  const details = thread.details || {};
  const adIds = unique([
    ...(details.newAdIds || []),
    ...extractAdIds(thread.text || "")
  ]);
  const title = getThreadTitle(thread, index);
  const policyLabel = details.policy?.hasAction ? details.policy.risk || "Policy issue" : "Policy OK";
  const subtitle = `${adIds.length || 1} affected ad${adIds.length === 1 ? "" : "s"} · ${details.isNew ? "New · " : ""}${policyLabel}`;
  const body = buildCardBody(details, adIds);
  const sourceImageUrls = unique([
    details.media?.creativeImageUrl,
    details.media?.imageUrl,
    details.media?.thumbnailUrl,
    details.media?.screenshotUrl,
    findFirstImageUrl(thread),
    DEFAULT_PLACEHOLDER_IMAGE
  ]);
  const imageUrl = cacheImages
    ? await cacheFirstCatalogImage(sourceImageUrls, meta, thread, index, { fitImages })
    : sourceImageUrls[0];
  const ignorableRules = getIgnorablePolicyRules(details.policy);
  const value = JSON.stringify({
    accountId: meta.accountId || "",
    issueIndex: index,
    issueFingerprint: details.issueFingerprint || "",
    adIds: adIds.slice(0, 10)
  });
  const ignoreRuleValue = JSON.stringify({
    accountId: meta.accountId || "",
    clientId: meta.clientName || meta.accountName || "",
    issueIndex: index,
    issueFingerprint: details.issueFingerprint || "",
    adIds: adIds.slice(0, 10),
    ruleIds: ignorableRules.map((rule) => rule.ruleId).slice(0, 20)
  });
  const actions = [
    {
      type: "button",
      text: {
        type: "plain_text",
        text: "Details",
        emoji: false
      },
      action_id: "open_ad_compliance_modal",
      value
    }
  ];

  if (ignorableRules.length) {
    actions.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Ignore rule",
        emoji: false
      },
      action_id: "open_policy_rule_ignore_modal",
      value: ignoreRuleValue
    });
  }

  return {
    type: "card",
    block_id: `ad_catalog_${index + 1}`,
    hero_image: {
      type: "image",
      image_url: imageUrl,
      alt_text: title.slice(0, 120)
    },
    title: {
      type: "mrkdwn",
      text: truncateMrkdwn(escapeMrkdwn(title), 80),
      verbatim: false
    },
    subtitle: {
      type: "mrkdwn",
      text: truncateMrkdwn(escapeMrkdwn(subtitle), 120),
      verbatim: false
    },
    body: {
      type: "mrkdwn",
      text: truncateMrkdwn(body, CARD_BODY_TEXT_LIMIT),
      verbatim: false
    },
    actions
  };
}

function buildCardBody(details, adIds = []) {
  const policyIssues = Array.isArray(details.policy?.issues) ? details.policy.issues : [];
  const policySignals = getPolicySignals(details.policy);
  const spellingFixes = Array.isArray(details.spelling?.fixes) ? details.spelling.fixes : [];
  const placementCount = details.placement?.hasAction ? Math.max(adIds.length, 1) : 0;
  const lines = [
    `*Policy* \`${policySignals.length}\`  ·  *Spelling* \`${spellingFixes.length}\`  ·  *Placement* \`${placementCount}\``
  ];

  if (!policySignals.length && details.spelling?.hasAction) {
    const corrections = getSpellingCorrections(details.spelling).slice(0, 2);
    lines.push("", "*Spelling*", "ตรวจพบคำที่ต้องแก้ไข");
    if (corrections.length) {
      lines.push(...corrections);
    } else {
      lines.push("Corrections required");
    }
    return lines.join("\n");
  }

  if (policyIssues.length) {
    const flaggedTexts = unique(
      policyIssues
        .map((issue) => issue.flagged_text || "")
        .filter(Boolean)
    );
    const issueTitles = unique(
      policyIssues
        .map((issue) => issue.issue_title || issue.short_title || issue.category || "")
        .filter(Boolean)
    );
    const baseLines = [...lines, "", "*Policy issue*"];
    if (flaggedTexts.length) {
      baseLines.push(`*คำที่พบ:* ${formatFlaggedTextSummary(flaggedTexts)}`);
    }
    if (issueTitles.length) {
      const reasonLines = [...baseLines, `*สาเหตุ:* ${issueTitles.map(escapeMrkdwn).join(", ")}`];
      const reasonBody = reasonLines.join("\n");
      if (reasonBody.length <= CARD_BODY_TEXT_LIMIT) return reasonBody;
    }
    return [...baseLines, "_ดูสาเหตุและรายละเอียดใน Details_"].join("\n");
  }

  const firstPolicy = policyIssues[0];
  const firstSignal = policySignals[0];
  const primaryIssue =
    firstPolicy?.issue_title ||
    firstPolicy?.flagged_text ||
    firstSignal?.text ||
    (details.spelling?.hasAction ? spellingFixes[0] : "") ||
    (details.placement?.hasAction ? details.placement.finding : "") ||
    "Issue detected";
  const flaggedText =
    firstPolicy?.flagged_text ||
    (details.spelling?.hasAction
      ? extractSpellingSource(spellingFixes[0])
      : "");

  lines.push("", "*Primary issue*", escapeMrkdwn(primaryIssue));
  if (
    flaggedText &&
    normalizeComparableText(flaggedText) !== normalizeComparableText(primaryIssue)
  ) {
    lines.push(`“${escapeMrkdwn(flaggedText)}”`);
  }

  const reference = firstPolicy ? formatIssueReference(firstPolicy, { includeRuleId: false }) : "";
  if (reference) {
    lines.push("", "*Reference*", escapeMrkdwn(reference));
  }
  return lines.join("\n");
}

function hasVisibleIssue(details) {
  return (
    getPolicySignals(details.policy).length > 0 ||
    Boolean(details.spelling?.hasAction) ||
    Boolean(details.placement?.hasAction)
  );
}

function getSortedVisibleThreads(alert) {
  const threads = Array.isArray(alert.threadMessages) ? alert.threadMessages : [];
  return threads
    .map((thread, originalIndex) => ({
      thread,
      originalIndex,
      affectedAdCount: getAffectedAdCount(thread)
    }))
    .filter((item) => hasVisibleIssue(item.thread.details || {}))
    .sort((a, b) => {
      if (b.affectedAdCount !== a.affectedAdCount) {
        return b.affectedAdCount - a.affectedAdCount;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((item) => item.thread);
}

function getAffectedAdCount(thread) {
  const details = thread?.details || {};
  const explicitCount = Number(details.affectedAdCount || details.adCount || 0);
  if (Number.isFinite(explicitCount) && explicitCount > 0) return explicitCount;
  const adIds = unique([
    ...(Array.isArray(details.newAdIds) ? details.newAdIds : []),
    ...extractAdIds(thread?.text || "")
  ]);
  return adIds.length || 1;
}

function getPolicySignals(policy = {}) {
  if (!policy?.hasAction) return [];
  const issues = Array.isArray(policy.issues) ? policy.issues : [];
  if (issues.length) {
    return issues.map((issue) => ({
      type: "issue",
      text:
        issue.issue_title ||
        issue.flagged_text ||
        issue.category ||
        issue.fix_note ||
        "Policy issue",
      issue
    }));
  }
  const flags = [
    ...(Array.isArray(policy.redFlags) ? policy.redFlags : []),
    ...(Array.isArray(policy.yellowFlags) ? policy.yellowFlags : [])
  ].filter(Boolean);
  if (flags.length) {
    return unique(flags).map((text) => ({ type: "flag", text }));
  }
  const fixNotes = Array.isArray(policy.fixNotes) ? policy.fixNotes.filter(Boolean) : [];
  return unique(fixNotes).map((text) => ({ type: "fix", text }));
}

function getIgnorablePolicyRules(policy = {}) {
  if (!policy?.hasAction) return [];
  const issues = Array.isArray(policy.issues) ? policy.issues : [];
  return uniqueBy(
    issues
      .map((issue) => {
        const ruleId = `${issue?.rule_id || ""}`.trim();
        if (!ruleId) return null;
        const title =
          issue.issue_title ||
          issue.short_title ||
          issue.category ||
          issue.flagged_text ||
          "Policy issue";
        return {
          ruleId,
          title: `${title}`.trim(),
          flaggedText: `${issue.flagged_text || ""}`.trim(),
          reference: formatIssueReference(issue, { includeRuleId: false })
        };
      })
      .filter(Boolean),
    (rule) => rule.ruleId
  );
}

function extractSpellingSource(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.split(/\s*(?:→|->)\s*/)[0].trim();
}

function getSpellingCorrections(spelling) {
  const fromErrors = unique(
    (Array.isArray(spelling?.errors) ? spelling.errors : [])
      .map((error) => {
        if (!error?.original || !error?.corrected) return "";
        return `${formatInlineCode(error.original)} → ${formatInlineCode(error.corrected)}`;
      })
      .filter(Boolean)
  );
  if (fromErrors.length) return fromErrors;

  return unique(
    (Array.isArray(spelling?.fixes) ? spelling.fixes : [])
      .map((fix) => {
        const [original, corrected] = String(fix || "").split(/\s*(?:→|->)\s*/);
        if (!original || !corrected) return escapeMrkdwn(fix);
        return `${formatInlineCode(original)} → ${formatInlineCode(corrected)}`;
      })
      .filter(Boolean)
  );
}

function normalizeComparableText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatIssueReference(issue, { includeRuleId = false } = {}) {
  if (!issue || typeof issue !== "object") return "";
  const primary =
    issue.display_reference ||
    [issue.law_name, issue.reference_section || issue.reference_locator]
      .filter(Boolean)
      .join(" | ") ||
    issue.reference_locator ||
    issue.law_name ||
    issue.category ||
    "";
  const ruleId = includeRuleId && issue.rule_id ? `Rule ID: ${issue.rule_id}` : "";
  return [primary, ruleId].filter(Boolean).join("\n  ");
}

function formatFlaggedTextSummary(flaggedTexts, {
  maxItems = 3,
  maxChars = CARD_FLAGGED_TEXTS_LIMIT
} = {}) {
  const texts = unique(
    (Array.isArray(flaggedTexts) ? flaggedTexts : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  if (!texts.length) return "";

  const visibleTexts = [];
  for (const text of texts.slice(0, maxItems)) {
    const candidateTexts = [...visibleTexts, text];
    const remaining = texts.length - candidateTexts.length;
    const candidate =
      candidateTexts.map(formatInlineCode).join(" · ") +
      (remaining > 0 ? ` +${remaining}` : "");
    if (candidate.length > maxChars) break;
    visibleTexts.push(text);
  }

  if (visibleTexts.length) {
    const remaining = texts.length - visibleTexts.length;
    return (
      visibleTexts.map(formatInlineCode).join(" · ") +
      (remaining > 0 ? ` +${remaining}` : "")
    );
  }

  const firstText = truncatePlainText(texts[0], Math.max(24, maxChars - 14));
  return `${formatInlineCode(firstText)} +${texts.length - 1}`;
}

function formatInlineCode(value) {
  const text = String(value || "").replace(/`/g, "'").trim();
  if (!text) return "";
  return `\`${escapeMrkdwn(text)}\``;
}

function getThreadTitle(thread, index) {
  const text = String(thread.text || "");
  const match = text.match(/^\*([^*]+)\*/);
  if (match?.[1]) return match[1];
  const firstSection = (thread.blocks || []).find((block) => block.type === "section" && block.text?.text);
  const sectionMatch = String(firstSection?.text?.text || "").match(/^\*([^*]+)\*/);
  if (sectionMatch?.[1]) return sectionMatch[1];
  return `Ad issue ${index + 1}`;
}

function findFirstImageUrl(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.image_url === "string" && value.image_url.startsWith("http")) return value.image_url;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstImageUrl(item);
      if (found) return found;
    }
    return "";
  }
  for (const item of Object.values(value)) {
    const found = findFirstImageUrl(item);
    if (found) return found;
  }
  return "";
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
  const fileName = `${client}-${account}-${date}-catalog.json`;
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

async function cacheFirstCatalogImage(imageUrls, meta, thread, index, { fitImages = false } = {}) {
  for (const imageUrl of imageUrls) {
    const cached = await cacheCatalogImage(imageUrl, meta, thread, index, { fitImages });
    if (cached) return cached;
  }
  return fitImages ? DEFAULT_PLACEHOLDER_IMAGE : imageUrls[0] || DEFAULT_PLACEHOLDER_IMAGE;
}

async function cacheCatalogImage(imageUrl, meta, thread, index, { fitImages = false } = {}) {
  if (!imageUrl || imageUrl === DEFAULT_PLACEHOLDER_IMAGE || (isSupabasePublicUrl(imageUrl) && !fitImages)) {
    return imageUrl || DEFAULT_PLACEHOLDER_IMAGE;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !serviceKey) return imageUrl;

  try {
    const response = await fetch(imageUrl, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const downloadedContentType = normalizeImageContentType(response.headers.get("content-type"));
    const downloadedBytes = Buffer.from(await response.arrayBuffer());
    if (!downloadedBytes.length) throw new Error("empty image body");
    const imageAsset = fitImages
      ? await fitImageOnWhiteCanvas(downloadedBytes, downloadedContentType)
      : {
          bytes: downloadedBytes,
          contentType: downloadedContentType,
          extension: imageExtension(downloadedContentType)
        };

    const account = `${meta.accountId || "account"}`.replace(/^act_/, "");
    const issueKey = thread.key || `${index + 1}`;
    const digest = crypto
      .createHash("sha1")
      .update(`${imageUrl}|${issueKey}|fit-v3-4x3:${fitImages}`)
      .digest("hex")
      .slice(0, 16);
    const fileName = `${slugify(meta.clientName || meta.accountName || "client")}-${account}-${index + 1}-${digest}.${imageAsset.extension}`;
    const uploaded = await uploadScreenshotToSupabase({
      supabaseUrl,
      serviceKey,
      bucket: process.env.SUPABASE_STORAGE_BUCKET || "ads-compliance",
      prefix: `${process.env.SUPABASE_STORAGE_PREFIX || "ad-preview-checker"}/catalog-images`,
      fileName,
      buffer: imageAsset.bytes,
      contentType: imageAsset.contentType
    });
    return uploaded?.publicUrl || imageUrl;
  } catch (error) {
    console.warn(`Catalog image cache skipped: ${error.message}`);
    return "";
  }
}

async function fitImageOnWhiteCanvas(bytes, contentType, targetWidth = 1024, targetHeight = 768) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-catalog-image-"));
  const inputPath = path.join(tmpDir, `input.${imageExtension(contentType)}`);
  const resizedPath = path.join(tmpDir, "resized.png");
  const outputPath = path.join(tmpDir, "output.png");

  try {
    await fs.writeFile(inputPath, bytes);
    const info = await readImageSize(inputPath);
    const scale = Math.min(targetWidth / info.width, targetHeight / info.height);
    const resizedWidth = Math.max(1, Math.round(info.width * scale));
    const resizedHeight = Math.max(1, Math.round(info.height * scale));

    await execFileAsync("sips", [
      "-s",
      "format",
      "png",
      "-z",
      String(resizedHeight),
      String(resizedWidth),
      inputPath,
      "--out",
      resizedPath
    ]);
    await execFileAsync("sips", [
      "-p",
      String(targetHeight),
      String(targetWidth),
      "--padColor",
      "FFFFFF",
      resizedPath,
      "--out",
      outputPath
    ]);

    return {
      bytes: await fs.readFile(outputPath),
      contentType: "image/png",
      extension: "png"
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function readImageSize(filePath) {
  const { stdout } = await execFileAsync("sips", [
    "-g",
    "pixelWidth",
    "-g",
    "pixelHeight",
    filePath
  ]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!width || !height) throw new Error("could not read image dimensions");
  return { width, height };
}

async function logSlackSend({ alert, channelId, slackTs, reportUrl, status, error }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !serviceKey) return;

  const meta = alert.meta || {};
  const row = {
    alert_type: "ad_compliance_catalog",
    account_id: meta.accountId || null,
    account_name: meta.accountName || null,
    client_name: meta.clientName || null,
    channel_id: channelId,
    slack_ts: slackTs || null,
    report_url: reportUrl || null,
    viewer_url: null,
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

async function logSlackSendIssues({ alert, channelId, slackTs, reportUrl, maxCards, issueIndexOffset }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !serviceKey || !slackTs) return;

  const rows = buildSlackSendIssueRows({
    alert,
    channelId,
    slackTs,
    reportUrl,
    maxCards,
    issueIndexOffset
  });
  if (!rows.length) return;

  const url = new URL(`${trimTrailingSlash(supabaseUrl)}/rest/v1/ad_compliance_slack_send_issues`);
  url.searchParams.set("on_conflict", "channel_id,slack_ts,issue_index");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(rows)
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.message || body.error || response.statusText;
      console.warn(`Slack send issue log skipped: ${response.status} ${message}`);
    }
  } catch (logError) {
    console.warn(`Slack send issue log skipped: ${logError.message}`);
  }
}

function buildSlackSendIssueRows({ alert, channelId, slackTs, reportUrl, maxCards, issueIndexOffset }) {
  const meta = alert.meta || {};
  const visibleThreads = getSortedVisibleThreads(alert);
  return visibleThreads.slice(0, maxCards).map((thread, index) => {
    const issueIndex = index + issueIndexOffset;
    const details = thread.details || {};
    const adIds = unique([
      ...(details.newAdIds || []),
      ...extractAdIds(thread.text || "")
    ]);
    const privateMetadata = {
      account_id: meta.accountId || "",
      client_id: meta.clientName || meta.accountName || "",
      issue_index: issueIndex,
      issue_fingerprint: details.issueFingerprint || null,
      policy_run_id: meta.policyRunId || null,
      ad_ids: adIds,
      channel_id: channelId,
      message_ts: slackTs
    };

    return {
      account_id: meta.accountId || "",
      account_name: meta.accountName || null,
      client_name: meta.clientName || null,
      channel_id: channelId,
      slack_ts: slackTs,
      issue_index: issueIndex,
      issue_fingerprint: details.issueFingerprint || null,
      ad_ids: adIds,
      modal_blocks: buildIssueModalBlocks(alert, thread, issueIndex, adIds),
      private_metadata: privateMetadata,
      report_url: reportUrl || null,
      report_generated_at: meta.generatedAt || null,
      meta: {
        cardTitle: getThreadTitle(thread, issueIndex),
        issueType: details.issueType || null,
        isNew: Boolean(details.isNew),
        policyRunId: meta.policyRunId || null,
        ignorableRules: getIgnorablePolicyRules(details.policy),
        ...buildRevisedTextMeta(details)
      }
    };
  });
}

function buildIssueModalBlocks(alert, thread, issueIndex, adIds) {
  const meta = alert.meta || {};
  const details = thread.details || {};
  const issueName = getThreadTitle(thread, issueIndex);
  const policyIssues = Array.isArray(details.policy?.issues) ? details.policy.issues : [];
  const spellingFixes = Array.isArray(details.spelling?.fixes) ? details.spelling.fixes : [];
  const issueTypes = [];
  if (details.policy?.hasAction) issueTypes.push("Policy");
  if (details.spelling?.hasAction) issueTypes.push("Spelling");
  if (details.placement?.hasAction) issueTypes.push("Placement");

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${escapeMrkdwn(meta.clientName || meta.accountName || "Ad Compliance")}*\n` +
          `\`${escapeMrkdwn(meta.accountId || "")}\``
      }
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Affected ads*\n${Number(meta.adCount || 0)} ads · ${Number(meta.creativeCount || 0)} creatives`
        },
        {
          type: "mrkdwn",
          text: `*Policy*\n${Number(meta.policyCreativeCount || 0)} creatives`
        },
        {
          type: "mrkdwn",
          text: `*Spelling*\n${Number(meta.spellingCreativeCount || 0)} creatives`
        },
        {
          type: "mrkdwn",
          text: `*Placement*\n${Number(meta.placementAdCount || 0)} ads`
        }
      ]
    },
    { type: "divider" },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncatePlainText(`Issue ${issueIndex + 1} · ${issueName}`, 145)
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `*${escapeMrkdwn(issueTypes.join(" + ") || "Issue")}* · ` +
            `*${adIds.length || 1} affected ad${adIds.length === 1 ? "" : "s"}*`
        }
      ]
    }
  ];

  if (adIds.length) {
    const visibleIds = adIds.slice(0, 3);
    const remaining = adIds.length - visibleIds.length;
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            visibleIds.map((id) => `\`${id}\``).join(" · ") +
            (remaining > 0 ? ` · +${remaining} more` : "")
        }
      ]
    });
  }

  if (details.policy?.hasAction) {
    const policySignals = getPolicySignals(details.policy);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Policy · ${escapeMrkdwn(details.policy.risk || "Issue")}*\n*Problems*`
      }
    });

    const visiblePolicyIssues = policyIssues.slice(0, 5);
    const visibleFallbackSignals = !visiblePolicyIssues.length
      ? policySignals.slice(0, 5)
      : [];
    visiblePolicyIssues.forEach((issue, index) => {
      const title =
        issue.issue_title ||
        issue.flagged_text ||
        issue.category ||
        "Policy issue";
      const flaggedText = issue.flagged_text &&
        normalizeComparableText(issue.flagged_text) !== normalizeComparableText(title)
        ? `\nคำที่พบ: ${formatInlineCode(issue.flagged_text)}`
        : "";
      const reference = formatIssueReference(issue);
      const referenceText = reference ? `\nอ้างอิง: ${escapeMrkdwn(reference)}` : "";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateMrkdwn(`*${escapeMrkdwn(title)}*${flaggedText}${referenceText}`, 2500)
        }
      });
      if (index < visiblePolicyIssues.length - 1) {
        blocks.push({ type: "divider" });
      }
    });
    visibleFallbackSignals.forEach((signal, index) => {
      const prefix = signal.type === "fix" ? "คำแนะนำ" : "คำที่พบ";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateMrkdwn(`*${prefix}*\n${formatInlineCode(signal.text)}`, 2500)
        }
      });
      if (index < visibleFallbackSignals.length - 1) {
        blocks.push({ type: "divider" });
      }
    });

    const fixNotes = unique(
      policyIssues.map((issue) => issue.fix_note || "").filter(Boolean)
    ).slice(0, 5);
    if (fixNotes.length) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateMrkdwn(
            `*Recommended fixes*\n${fixNotes.map((fix) => `• ${escapeMrkdwn(fix)}`).join("\n")}`,
            2500
          )
        }
      });
    }
  }

  if (details.spelling?.hasAction) {
    const spellingCorrections = getSpellingCorrections(details.spelling).slice(0, 5);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateMrkdwn(
          `*Spelling*\n${
            spellingCorrections.length
              ? spellingCorrections.map((fix) => `• ${fix}`).join("\n")
              : "Corrections required"
          }`,
          2500
        )
      }
    });
  }

  if (details.placement?.hasAction) {
    const formats = Array.isArray(details.placement.formats) ? details.placement.formats : [];
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateMrkdwn(
          `*Placement*\n${escapeMrkdwn(details.placement.finding || "Issue detected")}` +
            (formats.length
              ? `\n*Affected formats:* ${formats.map(formatPlacementName).join(" · ")}`
              : ""),
          2500
        )
      }
    });
  }

  const imageUrl = details.placement?.hasAction ? firstModalImageUrl(thread, details) : "";
  if (imageUrl) {
    blocks.push({
      type: "image",
      image_url: imageUrl,
      alt_text: truncatePlainText(issueName || "Ad preview", 200),
      title: {
        type: "plain_text",
        text: truncatePlainText(issueName || "Ad preview", 145)
      }
    });
  }

  if (details.revisedText && !isPlacementOnlyIssue(details)) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: formatRevisedTextBlock(details.revisedText, REVISED_TEXT_PREVIEW_LIMIT)
      }
    });

    if (isRevisedTextTruncated(details.revisedText, REVISED_TEXT_PREVIEW_LIMIT)) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "View full revised text",
              emoji: false
            },
            action_id: "open_full_revised_text_modal",
            value: JSON.stringify({
              accountId: meta.accountId || "",
              issueIndex,
              issueFingerprint: details.issueFingerprint || "",
              adIds: adIds.slice(0, 10)
            })
          }
        ]
      });
    }
  }

  return blocks.slice(0, 95);
}

function buildRevisedTextMeta(details = {}) {
  if (!details.revisedText || isPlacementOnlyIssue(details)) return {};
  const fullText = sanitizeRevisedTextForSlack(cleanRevisedText(details.revisedText));
  if (!fullText) return {};
  return {
    fullRevisedText: fullText,
    fullRevisedTextChunks: chunkText(fullText, REVISED_TEXT_CHUNK_LIMIT),
    fullRevisedTextWasTruncated: isRevisedTextTruncated(details.revisedText, REVISED_TEXT_PREVIEW_LIMIT)
  };
}

function isPlacementOnlyIssue(details = {}) {
  return (
    Boolean(details.placement?.hasAction) &&
    !getPolicySignals(details.policy).length &&
    !Boolean(details.spelling?.hasAction)
  );
}

function firstModalImageUrl(thread, details) {
  if (details.media?.imageUrl) return details.media.imageUrl;
  const imageBlock = (Array.isArray(thread.blocks) ? thread.blocks : []).find(
    (block) => block.type === "image" && block.image_url
  );
  return imageBlock?.image_url || "";
}

function formatPlacementName(value) {
  return String(value || "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function getSlackToken() {
  const token = process.env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_OAUTH;
  if (!token) throw new Error("SLACK_BOT_TOKEN or SLACK_BOT_OAUTH is required.");
  return token;
}

function isSupabasePublicUrl(value) {
  return String(value || "").includes("/storage/v1/object/public/");
}

function normalizeImageContentType(value) {
  const contentType = String(value || "").split(";")[0].trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType)) return contentType;
  return "image/jpeg";
}

function imageExtension(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "jpg";
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 10);
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function extractAdIds(text) {
  return String(text || "").match(/\b\d{12,32}\b/g) || [];
}

function unique(values) {
  return [...new Set((values || []).map((value) => `${value}`.trim()).filter(Boolean))];
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
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

function cleanRevisedText(text) {
  return `${text || ""}`
    .replace(/\u200b/g, "")
    .replace(/```+/g, "'''")
    .replace(/\s*\}\}\s*(?:'{3})?\s*\*\*Note:\*\*[\s\S]*$/i, "")
    .replace(/\}\}\s*$/g, "")
    .replace(/`/g, "'")
    .trim();
}

function escapeRevisedText(text) {
  const cleaned = sanitizeRevisedTextForSlack(cleanRevisedText(text));
  return escapeMrkdwn(cleaned);
}

function sanitizeRevisedTextForSlack(text) {
  return `${text || ""}`.replace(/(^|[\s([{])#(?=[\p{L}\p{N}_])/gu, "$1#\u200c");
}

function formatRevisedTextBlock(text, limit) {
  const header = "*Revised text*\n";
  const openFence = "```\n";
  const closeFence = "\n```";
  const maxContentLength = Math.max(0, limit - header.length - openFence.length - closeFence.length);
  const content = truncateCodeContent(escapeRevisedText(text), maxContentLength);
  return `${header}${openFence}${content}${closeFence}`;
}

function isRevisedTextTruncated(text, limit) {
  const header = "*Revised text*\n";
  const openFence = "```\n";
  const closeFence = "\n```";
  const maxContentLength = Math.max(0, limit - header.length - openFence.length - closeFence.length);
  return escapeRevisedText(text).length > maxContentLength;
}

function chunkText(value, limit) {
  const text = `${value || ""}`;
  if (!text) return [];
  const chunks = [];
  for (let start = 0; start < text.length; start += limit) {
    chunks.push(text.slice(start, start + limit));
  }
  return chunks;
}

function truncateCodeContent(value, limit) {
  const text = `${value || ""}`;
  if (text.length <= limit) return text;
  const suffix = "\n...[truncated]";
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function truncateMrkdwn(value, limit) {
  const text = `${value || ""}`;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function truncatePlainText(value, limit) {
  return truncateMrkdwn(`${value || ""}`.replace(/\s+/g, " ").trim(), limit);
}

function trimTrailingSlash(value) {
  return `${value || ""}`.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
