import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import "./env.js";
import { postSlackMessage } from "./slack.js";
import { uploadScreenshotToSupabase } from "./storage.js";
import { summarizeCardReasons } from "./catalog-summary.js";

const DEFAULT_PLACEHOLDER_IMAGE = "https://dummyimage.com/728x666/f6f7f8/1f2937.png&text=Ad+Compliance";
const CARD_BODY_TEXT_LIMIT = 200;
const CARD_FLAGGED_TEXTS_LIMIT = 92;
const CARD_SUMMARY_TEXT_LIMIT = 86;
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
  const style = resolveCatalogStyle(args.style);
  const aiSummary = args["no-ai-summary"] === true
    ? false
    : args["ai-summary"] === true || envFlag("CATALOG_AI_SUMMARY", true);
  const displaySuppressedPolicyRuleIds = await resolveCatalogDisplaySuppressedPolicyRuleIds(alert, args);
  const visibleAlert = await applyCatalogRuleIdValidation(
    applyCatalogDisplayOverrides(alert, displaySuppressedPolicyRuleIds)
  );

  const reportUrl = args["upload-report"] && !args["dry-run-blocks"]
    ? await uploadReportJson(visibleAlert, Buffer.from(JSON.stringify(visibleAlert, null, 2)))
    : null;

  const blocks = style === "v2"
    ? await buildCatalogBlocksV2(visibleAlert, {
        maxCards,
        cacheImages,
        fitImages,
        issueIndexOffset,
        aiSummary,
        channelId
      })
    : await buildCatalogBlocks(visibleAlert, {
        maxCards,
        cacheImages,
        fitImages,
        issueIndexOffset,
        channelId
      });

  if (args["dry-run-blocks"]) {
    console.log(JSON.stringify({ blocks }, null, 2));
    return;
  }

  if (!Number(visibleAlert.meta?.threadCount || 0) && !args["send-empty"]) {
    console.log(JSON.stringify({ reportUrl, skippedSlack: true, reason: "no_open_issues" }, null, 2));
    return;
  }

  const response = await postSlackMessage({
    botToken: getSlackToken(),
    channelId,
    text: `Ad Compliance Catalog: ${visibleAlert.meta?.clientName || visibleAlert.meta?.accountName || "Report"}`,
    blocks
  });

  if (args["log-send"]) {
    await logSlackSend({
      alert: visibleAlert,
      channelId,
      slackTs: response.ts,
      reportUrl,
      status: "sent"
    });
    await logSlackSendIssues({
      alert: visibleAlert,
      channelId,
      slackTs: response.ts,
      reportUrl,
      maxCards,
      issueIndexOffset
    });
  }

  console.log(JSON.stringify({ reportUrl, slack: { channelId, ts: response.ts } }, null, 2));
}

async function resolveCatalogDisplaySuppressedPolicyRuleIds(alert, args) {
  const explicitRuleIds = parseCsv([
    args["ignore-rule-ids"],
    args["display-ignore-rule-ids"],
    process.env.CATALOG_DISPLAY_IGNORE_RULE_IDS,
    process.env.AD_COMPLIANCE_DISPLAY_IGNORE_RULE_IDS
  ].filter(Boolean).join(","));
  const priorityRuleIds = args["no-priority-ignores"] === true
    ? []
    : await fetchDisplayIgnoredPolicyRuleIdsByPriority(
        parseCsv(process.env.CATALOG_DISPLAY_IGNORE_RULE_PRIORITIES || process.env.AD_COMPLIANCE_DISPLAY_IGNORE_RULE_PRIORITIES || "")
      );
  const clientRuleIds = args["no-client-ignores"] === true
    ? []
    : await fetchClientDisplayIgnoredPolicyRuleIds(getCatalogClientIds(alert));
  return new Set([...explicitRuleIds, ...priorityRuleIds, ...clientRuleIds]);
}

async function fetchDisplayIgnoredPolicyRuleIdsByPriority(priorities) {
  const uniquePriorities = unique(priorities).filter((priority) => /^\d+$/.test(priority));
  if (!uniquePriorities.length) return [];
  const { supabaseUrl, supabaseKey } = getOptionalSupabaseEnv();
  if (!supabaseUrl || !supabaseKey) return [];

  const ruleIds = new Set();
  for (const priority of uniquePriorities) {
    const query = new URL(`${supabaseUrl}/rest/v1/policy_rules`);
    query.searchParams.set("select", "id");
    query.searchParams.set("priority", `eq.${priority}`);
    query.searchParams.set("is_active", "eq.true");
    try {
      const rows = await fetchSupabaseJson(query, supabaseKey, `priority ${priority} policy rules`);
      for (const row of rows || []) {
        const ruleId = `${row.id || ""}`.trim();
        if (ruleId) ruleIds.add(ruleId);
      }
    } catch (error) {
      console.warn(`Catalog priority ignores skipped for priority ${priority}: ${error.message}`);
    }
  }
  return [...ruleIds];
}

async function fetchClientDisplayIgnoredPolicyRuleIds(clientIds) {
  const normalizedClientIds = unique(clientIds);
  if (!normalizedClientIds.length) return [];
  const { supabaseUrl, supabaseKey } = getOptionalSupabaseEnv();
  if (!supabaseUrl || !supabaseKey) return [];

  const ruleIds = new Set();
  for (const clientId of normalizedClientIds) {
    const query = new URL(`${supabaseUrl}/rest/v1/client_policy_rule_ignores`);
    query.searchParams.set("select", "rule_id");
    query.searchParams.set("client_id", `eq.${clientId}`);
    query.searchParams.set("is_ignored", "eq.true");
    try {
      const rows = await fetchSupabaseJson(query, supabaseKey, "client policy rule ignores");
      for (const row of rows || []) {
        const ruleId = `${row.rule_id || ""}`.trim();
        if (ruleId) ruleIds.add(ruleId);
      }
    } catch (error) {
      console.warn(`Catalog client ignores skipped for ${clientId}: ${error.message}`);
    }
  }
  return [...ruleIds];
}

function getCatalogClientIds(alert) {
  const meta = alert?.meta || {};
  return [
    meta.clientName,
    meta.accountName,
    meta.accountId,
    String(meta.accountId || "").replace(/^act_/, "")
  ];
}

function getOptionalSupabaseEnv() {
  return {
    supabaseUrl: trimTrailingSlash(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ""),
    supabaseKey: process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || ""
  };
}

async function fetchSupabaseJson(url, supabaseKey, label) {
  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || body.error || response.statusText;
    throw new Error(`${label}: ${response.status} ${message}`);
  }
  return Array.isArray(body) ? body : [];
}

function applyCatalogDisplayOverrides(alert, displaySuppressedPolicyRuleIds) {
  if (!displaySuppressedPolicyRuleIds?.size) return alert;
  const threads = Array.isArray(alert.threadMessages) ? alert.threadMessages : [];
  const threadMessages = threads.map((thread) => applyThreadDisplayOverrides(thread, displaySuppressedPolicyRuleIds));
  const visibleThreads = threadMessages.filter((thread) => hasVisibleIssue(thread.details || {}));
  const meta = {
    ...(alert.meta || {}),
    threadCount: visibleThreads.length,
    issueGroupCount: visibleThreads.length,
    displaySuppressedPolicyRuleCount: displaySuppressedPolicyRuleIds.size
  };
  return { ...alert, meta, threadMessages };
}

async function applyCatalogRuleIdValidation(alert) {
  const ruleIds = collectCatalogPolicyRuleIds(alert);
  if (!ruleIds.length) return alert;

  const existingRuleIds = await fetchExistingPolicyRuleIds(ruleIds);
  if (!existingRuleIds) return alert;

  return clearMissingCatalogPolicyRuleIds(alert, existingRuleIds);
}

function collectCatalogPolicyRuleIds(alert) {
  const ruleIds = new Set();
  for (const thread of Array.isArray(alert?.threadMessages) ? alert.threadMessages : []) {
    const issues = Array.isArray(thread?.details?.policy?.issues)
      ? thread.details.policy.issues
      : [];
    for (const issue of issues) {
      const ruleId = `${issue?.rule_id || ""}`.trim();
      if (isUuid(ruleId)) ruleIds.add(ruleId);
    }
  }
  return [...ruleIds];
}

async function fetchExistingPolicyRuleIds(ruleIds) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  const existing = new Set();
  for (const chunk of chunkArray(ruleIds, 100)) {
    const query = new URL(`${trimTrailingSlash(supabaseUrl)}/rest/v1/policy_rules`);
    query.searchParams.set("select", "id");
    query.searchParams.set("id", `in.(${chunk.join(",")})`);
    try {
      const rows = await fetchSupabaseJson(query, supabaseKey, "policy rule validation");
      for (const row of rows) {
        const ruleId = `${row.id || ""}`.trim();
        if (ruleId) existing.add(ruleId);
      }
    } catch (error) {
      console.warn(`Policy rule validation skipped: ${error.message}`);
      return null;
    }
  }
  return existing;
}

function clearMissingCatalogPolicyRuleIds(alert, existingRuleIds) {
  const threadMessages = (Array.isArray(alert?.threadMessages) ? alert.threadMessages : []).map((thread) => {
    const details = thread?.details || {};
    const policy = details.policy || {};
    const issues = Array.isArray(policy.issues) ? policy.issues : [];
    if (!issues.length) return thread;

    let changed = false;
    const nextIssues = issues.map((issue) => {
      const ruleId = `${issue?.rule_id || ""}`.trim();
      if (!isUuid(ruleId) || existingRuleIds.has(ruleId)) return issue;
      changed = true;
      return {
        ...issue,
        invalid_rule_id: ruleId,
        rule_id: ""
      };
    });
    if (!changed) return thread;

    return {
      ...thread,
      details: {
        ...details,
        policy: {
          ...policy,
          issues: nextIssues
        }
      }
    };
  });

  return { ...alert, threadMessages };
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function applyThreadDisplayOverrides(thread, displaySuppressedPolicyRuleIds) {
  const details = thread?.details || {};
  const policy = details.policy || {};
  const issues = Array.isArray(policy.issues) ? policy.issues : [];
  if (!issues.length) return thread;

  const visibleIssues = issues.filter((issue) => {
    const ruleId = `${issue?.rule_id || ""}`.trim();
    return !ruleId || !displaySuppressedPolicyRuleIds.has(ruleId);
  });
  if (visibleIssues.length === issues.length) return thread;

  const hasPolicyAction = visibleIssues.length > 0;
  const nextPolicy = {
    ...policy,
    hasAction: hasPolicyAction,
    risk: hasPolicyAction ? policy.risk : "Policy OK",
    issues: visibleIssues,
    redFlags: hasPolicyAction ? policy.redFlags : [],
    yellowFlags: hasPolicyAction ? policy.yellowFlags : [],
    fixNotes: hasPolicyAction
      ? unique(visibleIssues.map((issue) => issue.fix_note || "").filter(Boolean))
      : []
  };
  const nextDetails = {
    ...details,
    policy: nextPolicy
  };
  return {
    ...thread,
    details: nextDetails
  };
}

async function buildCatalogBlocks(alert, { maxCards, cacheImages, fitImages, issueIndexOffset, channelId }) {
  const meta = alert.meta || {};
  const clientName = meta.clientName || meta.accountName || "Unknown client";
  const accountId = meta.accountId || "";
  const cards = [];
  const visibleThreads = getSortedVisibleThreads(alert);
  for (const [index, thread] of visibleThreads.slice(0, maxCards).entries()) {
    cards.push(
      await buildAdCard(thread, index + issueIndexOffset, meta, {
        cacheImages,
        fitImages,
        channelId
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

async function buildAdCard(thread, index, meta, { cacheImages, fitImages, channelId }) {
  const details = thread.details || {};
  const adIds = unique([
    ...(details.newAdIds || []),
    ...extractAdIds(thread.text || "")
  ]);
  const title = getThreadTitle(thread, index);
  const policyLabel = details.policy?.hasAction ? details.policy.risk || "Policy issue" : "Policy OK";
  const subtitle = `${adIds.length || 1} affected ad${adIds.length === 1 ? "" : "s"} · ${details.isNew ? "New · " : ""}${policyLabel}`;
  const body = buildCardBody(details, adIds);
  const sourceImageUrls = getCatalogImageUrls(thread, details);
  const imageUrl = cacheImages
    ? await cacheFirstCatalogImage(sourceImageUrls, meta, thread, index, { fitImages })
    : sourceImageUrls[0];
  const ignorableRules = getIgnorablePolicyRules(details.policy);
  const value = JSON.stringify({
    accountId: meta.accountId || "",
    account_id: meta.accountId || "",
    channelId: channelId || "",
    channel_id: channelId || "",
    issueIndex: index,
    issue_index: index,
    issueFingerprint: details.issueFingerprint || "",
    issue_fingerprint: details.issueFingerprint || "",
    adIds: adIds.slice(0, 10),
    ad_ids: adIds.slice(0, 10)
  });
  const ignoreRuleValue = JSON.stringify({
    accountId: meta.accountId || "",
    account_id: meta.accountId || "",
    channelId: channelId || "",
    channel_id: channelId || "",
    clientId: meta.clientName || meta.accountName || "",
    client_id: meta.clientName || meta.accountName || "",
    issueIndex: index,
    issue_index: index,
    issueFingerprint: details.issueFingerprint || "",
    issue_fingerprint: details.issueFingerprint || "",
    adIds: adIds.slice(0, 10),
    ad_ids: adIds.slice(0, 10),
    ruleIds: ignorableRules.map((rule) => rule.ruleId).slice(0, 20),
    rule_ids: ignorableRules.map((rule) => rule.ruleId).slice(0, 20)
  });
  const actions = [];

  if (ignorableRules.length) {
    actions.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Ignore rules",
        emoji: false
      },
      action_id: "open_policy_rule_ignore_modal",
      value: ignoreRuleValue
    });
  }
  actions.push({
    type: "button",
    text: {
      type: "plain_text",
      text: "What to fix",
      emoji: false
    },
    action_id: "open_ad_compliance_modal",
    value
  });

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
    const issueEvidence = unique(
      policyIssues
        .map((issue) => formatPolicyCardIssueEvidence(issue, details))
        .filter(Boolean)
    );
    const issueTitles = unique(
      policyIssues
        .map((issue) => issue.issue_title || issue.short_title || issue.category || "")
        .filter(Boolean)
    );
    const baseLines = [...lines, "", "*Policy issue*"];
    if (issueEvidence.length) {
      baseLines.push(buildInlineListLine(issueEvidence, "*Issue:* ", 150, " · "));
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

// ---------------------------------------------------------------------------
// v2 catalog style (severity-led redesign). Default; classic remains available via --style classic.
// Classic builders above are intentionally left untouched.
// ---------------------------------------------------------------------------

async function buildCatalogBlocksV2(alert, { maxCards, cacheImages, fitImages, issueIndexOffset, aiSummary, channelId }) {
  const meta = alert.meta || {};
  const clientName = meta.clientName || meta.accountName || "Unknown client";
  const visibleThreads = getSortedVisibleThreads(alert);
  const visibleCards = visibleThreads.slice(0, maxCards);

  let summaries = new Map();
  if (aiSummary) {
    summaries = await summarizeCardReasons(
      visibleCards.map((thread, index) => ({ index, reasons: getPolicyReasons(thread.details) })),
      { maxChars: CARD_SUMMARY_TEXT_LIMIT }
    );
  }

  const cards = [];
  for (const [index, thread] of visibleCards.entries()) {
    cards.push(
      await buildAdCardV2(thread, index + issueIndexOffset, meta, {
        cacheImages,
        fitImages,
        channelId,
        summary: summaries.get(index)
      })
    );
  }

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncatePlainText(`Ad Compliance · ${clientName}`, 150),
        emoji: false
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `\`${escapeMrkdwn(meta.accountId || "")}\` · ${formatDate(meta.generatedAt)} · ` +
            `${Number(meta.adCount || 0)} ads · ${Number(meta.creativeCount || 0)} creatives`
        }
      ]
    }
  ];

  const catalogChips = [];
  if (Number(meta.policyCreativeCount || 0)) catalogChips.push(`Policy \`${Number(meta.policyCreativeCount)}\``);
  if (Number(meta.spellingCreativeCount || 0)) catalogChips.push(`Spelling \`${Number(meta.spellingCreativeCount)}\``);
  if (Number(meta.placementAdCount || 0)) catalogChips.push(`Placement \`${Number(meta.placementAdCount)}\``);
  if (catalogChips.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: catalogChips.join("  ·  ") }]
    });
  }

  if (!cards.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "No open ad compliance issues." }
    });
    return blocks;
  }

  blocks.push({ type: "carousel", elements: cards });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Showing ${cards.length} of ${visibleThreads.length} issues · sorted by impact`
      }
    ]
  });

  return blocks;
}

async function buildAdCardV2(thread, index, meta, { cacheImages, fitImages, channelId, summary }) {
  const details = thread.details || {};
  const adIds = unique([
    ...(details.newAdIds || []),
    ...extractAdIds(thread.text || "")
  ]);
  const title = getThreadTitle(thread, index);
  const adCount = adIds.length || 1;
  const issueCounts = getIssueCountChips(details, adCount);
  const subtitle =
    `${adCount} ad${adCount === 1 ? "" : "s"}` +
    (issueCounts.length ? ` · ${issueCounts.join(" · ")}` : "") +
    (details.isNew ? " · New" : "");
  const body = buildCardBodyV2(details, summary);

  const sourceImageUrls = getCatalogImageUrls(thread, details);
  const imageUrl = cacheImages
    ? await cacheFirstCatalogImage(sourceImageUrls, meta, thread, index, { fitImages })
    : sourceImageUrls[0];

  const ignorableRules = getIgnorablePolicyRules(details.policy);
  const value = JSON.stringify({
    accountId: meta.accountId || "",
    account_id: meta.accountId || "",
    channelId: channelId || "",
    channel_id: channelId || "",
    issueIndex: index,
    issue_index: index,
    issueFingerprint: details.issueFingerprint || "",
    issue_fingerprint: details.issueFingerprint || "",
    adIds: adIds.slice(0, 10),
    ad_ids: adIds.slice(0, 10)
  });
  const ignoreRuleValue = JSON.stringify({
    accountId: meta.accountId || "",
    account_id: meta.accountId || "",
    channelId: channelId || "",
    channel_id: channelId || "",
    clientId: meta.clientName || meta.accountName || "",
    client_id: meta.clientName || meta.accountName || "",
    issueIndex: index,
    issue_index: index,
    issueFingerprint: details.issueFingerprint || "",
    issue_fingerprint: details.issueFingerprint || "",
    adIds: adIds.slice(0, 10),
    ad_ids: adIds.slice(0, 10),
    ruleIds: ignorableRules.map((rule) => rule.ruleId).slice(0, 20),
    rule_ids: ignorableRules.map((rule) => rule.ruleId).slice(0, 20)
  });

  const actions = [];
  if (ignorableRules.length) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Ignore rules", emoji: false },
      action_id: "open_policy_rule_ignore_modal",
      value: ignoreRuleValue
    });
  }
  actions.push({
    type: "button",
    text: { type: "plain_text", text: "What to fix", emoji: false },
    action_id: "open_ad_compliance_modal",
    value
  });

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
      text: truncateMrkdwn(subtitle, 120),
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

function buildCardBodyV2(details, summary) {
  return getCardEvidence(details, CARD_BODY_TEXT_LIMIT, summary);
}

function getPolicyReasons(details = {}) {
  const issues = Array.isArray(details.policy?.issues) ? details.policy.issues : [];
  return unique(
    issues.map((issue) => issue.issue_title || issue.short_title || issue.category || "").filter(Boolean)
  );
}

function formatPolicyCardIssueEvidence(issue, details = {}) {
  const flaggedText = String(issue?.flagged_text || "").trim();
  if (!flaggedText) return "";
  const solution = getPolicyIssueSolution(issue, details);
  if (!solution) return formatInlineCode(flaggedText);
  return `${formatInlineCode(flaggedText)} >> ${formatInlineCode(solution)}`;
}

function getCardEvidence(details, budget, summary) {
  const policyIssues = Array.isArray(details.policy?.issues) ? details.policy.issues : [];
  if (policyIssues.length) {
    const issueEvidence = unique(
      policyIssues.map((issue) => formatPolicyCardIssueEvidence(issue, details)).filter(Boolean)
    );
    const issuePrefix = "*Issue:* ";
    const buildIssueLine = (lineBudget) => {
      if (!issueEvidence.length || lineBudget <= issuePrefix.length + 4) return "";
      return buildInlineListLine(issueEvidence, issuePrefix, Math.min(lineBudget, 150), " · ");
    };

    const summaryText = String(summary || "").trim();
    if (summaryText) {
      const summaryRaw = escapeMrkdwn(summaryText);
      const issueBudget = Math.max(0, Math.min(150, budget - summaryRaw.length - 1));
      const issueLine = buildIssueLine(issueBudget);
      const summaryBudget = budget - issueLine.length - (issueLine ? 1 : 0);

      const summaryLine = truncateWithoutEllipsis(summaryRaw, Math.max(0, summaryBudget));
      return [issueLine, summaryLine].filter(Boolean).join("\n");
    }

    // Fallback (no AI): flagged-words line + bulleted reasons.
    const reasons = getPolicyReasons(details).map(escapeMrkdwn);
    const fallbackSummary = buildCompactReasonSummary(reasons);
    if (fallbackSummary) {
      const issueBudget = Math.max(0, Math.min(150, budget - fallbackSummary.length - 1));
      const issueLine = buildIssueLine(issueBudget);
      const summaryBudget = budget - issueLine.length - (issueLine ? 1 : 0);
      const summaryLine = truncateWithoutEllipsis(fallbackSummary, Math.max(0, summaryBudget));
      return [issueLine, summaryLine].filter(Boolean).join("\n");
    }

    const lines = [];
    if (issueEvidence.length) {
      lines.push(buildIssueLine(Math.floor(budget * 0.75)));
    }
    const used = lines.length ? lines[0].length + 1 : 0;
    if (reasons.length) {
      const bulleted = reasons.map((reason) => `• ${reason}`);
      lines.push(joinWithinBudget(bulleted, "\n", Math.max(0, budget - used)));
    }
    return lines.join("\n");
  }

  if (details.spelling?.hasAction) {
    const corrections = getSpellingCorrections(details.spelling);
    if (!corrections.length) return "ตรวจพบคำที่ต้องแก้ไข";
    return formatSpellingContextEvidence(corrections, budget);
  }
  if (details.placement?.hasAction) {
    return truncateMrkdwn(
      `*Issue:* ${formatPlacementContextMrkdwn(details.placement)}`,
      budget
    );
  }

  const signals = getPolicySignals(details.policy).map((signal) =>
    formatInlineCode(signal.text)
  );
  if (signals.length) return joinWithinBudget(signals, ", ", budget);
  return "";
}

// Join items with a separator while staying inside the char budget. Extra items
// are omitted silently so card copy never shows unclear "+N" counters.
function joinWithinBudget(items, sep, budget) {
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const candidate = [...out, items[i]].join(sep);
    if (candidate.length > budget) {
      break;
    }
    out.push(items[i]);
  }
  return out.join(sep);
}

function buildInlineListLine(items, prefix, budget, sep = ", ") {
  if (!items.length || budget <= prefix.length + 2) return "";
  const visible = [];
  for (const item of items) {
    const nextVisible = [...visible, item];
    const candidate = `${prefix}${nextVisible.join(sep)}`;
    if (candidate.length <= budget) {
      visible.push(item);
    } else if (!visible.length) {
      const maxItemLength = budget - prefix.length;
      const shortened = truncateInlineCodeWithDots(item, maxItemLength);
      if (shortened) visible.push(shortened);
      break;
    }
  }
  if (!visible.length) return "";
  return `${prefix}${visible.join(sep)}`;
}

function buildCompactReasonSummary(reasons) {
  const cleaned = unique(
    (reasons || [])
      .map((reason) => String(reason || "").replace(/^[-•\s]+/g, "").trim())
      .filter(Boolean)
  );
  if (!cleaned.length) return "";
  if (cleaned.length === 1) return cleaned[0];
  const first = cleaned[0].replace(/^การ/g, "").trim();
  return first;
}

function formatSpellingContextEvidence(corrections, budget) {
  const firstCorrection = String(corrections?.[0] || "").trim();
  if (!firstCorrection) return "ตรวจพบคำที่ต้องแก้ไข";

  const [original, corrected] = firstCorrection.split(/\s*→\s*/);
  const text = original && corrected
    ? `*Issue:* ตรวจพบคำผิด ${original}\n→ ${corrected}`
    : `*Issue:* ตรวจพบคำผิด ${firstCorrection}`;
  return truncateMrkdwn(text, budget);
}

function truncateInlineCodeWithDots(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  if (limit <= 5) return "";
  if (!text.startsWith("`") || !text.endsWith("`")) {
    return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
  }
  const inner = text.slice(1, -1);
  const innerLimit = limit - 2;
  if (innerLimit <= 3) return "";
  return `\`${inner.slice(0, Math.max(0, innerLimit - 3)).trimEnd()}...\``;
}

function truncateWithoutEllipsis(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!limit || limit <= 0) return "";
  if (text.length <= limit) return text;
  const sliced = text.slice(0, limit).trimEnd();
  return sliced.replace(/[\s,.;:!?/|()[\]{}"'“”‘’、，。]+$/g, "");
}

function getIssueCountChips(details = {}, affectedAdCount = 1) {
  const policyCount = getPolicySignals(details.policy).length;
  const spellingCount = details.spelling?.hasAction
    ? Math.max(getSpellingCorrections(details.spelling).length, 1)
    : 0;
  const placementCount = details.placement?.hasAction ? Math.max(affectedAdCount, 1) : 0;
  return [
    policyCount > 0 ? `Policy: ${policyCount}` : "",
    spellingCount > 0 ? `Spell Check: ${spellingCount}` : "",
    placementCount > 0 ? `Placement: ${placementCount}` : ""
  ].filter(Boolean);
}

function resolveCatalogStyle(value) {
  const raw = String(value || process.env.CATALOG_STYLE || "v2").trim().toLowerCase();
  return raw === "v2" || raw === "new" ? "v2" : "classic";
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
      affectedAdCount: getAffectedAdCount(thread),
      issuePriority: getIssuePriority(thread.details || {})
    }))
    .filter((item) => hasVisibleIssue(item.thread.details || {}))
    .sort((a, b) => {
      if (a.issuePriority !== b.issuePriority) {
        return a.issuePriority - b.issuePriority;
      }
      if (b.affectedAdCount !== a.affectedAdCount) {
        return b.affectedAdCount - a.affectedAdCount;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((item) => item.thread);
}

function getIssuePriority(details = {}) {
  if (details.placement?.hasAction) return 0;
  if (getPolicySignals(details.policy).length > 0) return 1;
  if (details.spelling?.hasAction) return 2;
  return 3;
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
        if (!isUuid(ruleId)) return null;
        const title =
          issue.issue_title ||
          issue.short_title ||
          issue.category ||
          issue.flagged_text ||
          "Policy issue";
        const cleanTitle = normalizeInlineText(title);
        const flaggedText = normalizeInlineText(issue.flagged_text || "");
        const reference = formatIssueReference(issue, { includeRuleId: false });
        return {
          ruleId,
          title: cleanTitle,
          optionText: truncatePlainText(cleanTitle, 150),
          modalText: buildIgnoreRuleModalText({ title: cleanTitle, flaggedText, reference }),
          flaggedText,
          reference
        };
      })
      .filter(Boolean),
    (rule) => rule.ruleId
  );
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function buildIgnoreRuleModalText({ title, flaggedText, reference }) {
  return [
    `*${escapeMrkdwn(title)}*`,
    flaggedText ? `*Issue:* ${formatInlineCode(flaggedText)}` : "",
    reference ? `_Ref: ${escapeMrkdwn(reference)}_` : ""
  ].filter(Boolean).join("\n");
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
    const candidate = candidateTexts.map(formatInlineCode).join(" · ");
    if (candidate.length > maxChars) break;
    visibleTexts.push(text);
  }

  if (visibleTexts.length) {
    return visibleTexts.map(formatInlineCode).join(" · ");
  }

  const firstText = truncatePlainText(texts[0], Math.max(24, maxChars));
  return formatInlineCode(firstText);
}

function formatPolicyIssueForModal(issue, details = {}) {
  const title =
    issue.issue_title ||
    issue.flagged_text ||
    issue.category ||
    "Policy issue";
  const issueText = formatPolicyIssueEvidence(issue, details, title);
  const reference = formatIssueReference(issue);
  const referenceMeaning = formatPolicyReferenceMeaning(issue, title);
  const referenceText = reference
    ? ["*Reference:*", escapeMrkdwn(reference), referenceMeaning].filter(Boolean).join("\n")
    : "";
  const referenceReason = formatPolicyReferenceReason(issue);
  return [
    `• *${escapeMrkdwn(title)}*`,
    issueText,
    referenceText,
    referenceReason
  ].filter(Boolean).join("\n\n");
}

function formatFallbackPolicySignalForModal(signal) {
  const prefix = signal.type === "fix" ? "คำแนะนำ" : "Issue";
  const text = signal.type === "fix"
    ? escapeMrkdwn(normalizeInlineText(signal.text))
    : formatInlineCode(signal.text);
  return `${prefix}: ${text}`;
}

function formatPolicyIssueEvidence(issue, details, title) {
  if (
    !issue.flagged_text ||
    normalizeComparableText(issue.flagged_text) === normalizeComparableText(title)
  ) {
    return "";
  }
  const solution = getPolicyIssueSolution(issue, details);
  return [
    `*Issue:* ${formatInlineCode(issue.flagged_text)}`,
    solution ? ` >> ${formatInlineCode(solution)}` : ""
  ].join("");
}

function getPolicyIssueSolution(issue, details = {}) {
  const replacement = extractReplacementFromRevisedText(
    issue.flagged_text,
    details.originalText,
    details.revisedText
  );
  if (replacement !== null) return replacement || "ลบออก";
  return extractSolutionFromFixNote(issue.fix_note);
}

function extractReplacementFromRevisedText(flaggedText, originalText, revisedText) {
  const flagged = String(flaggedText || "").trim();
  const original = String(originalText || "");
  const revised = String(revisedText || "");
  if (!flagged || !original || !revised) return null;
  const originalIndex = original.indexOf(flagged);
  if (originalIndex < 0 || revised.includes(flagged)) return null;

  const before = original.slice(0, originalIndex);
  const after = original.slice(originalIndex + flagged.length);
  const beforeAnchor = findMatchingTrailingAnchor(before, revised);
  if (!beforeAnchor) return null;
  const start = revised.indexOf(beforeAnchor) + beforeAnchor.length;
  const afterAnchor = findMatchingLeadingAnchor(after, revised.slice(start));
  if (!afterAnchor) return null;
  const end = revised.indexOf(afterAnchor, start);
  if (end < start) return null;
  return normalizeInlineText(revised.slice(start, end));
}

function findMatchingTrailingAnchor(text, target) {
  const compact = text.replace(/\s+$/g, "");
  for (const length of [80, 60, 40, 24, 12]) {
    const anchor = compact.slice(-length);
    if (anchor && target.includes(anchor)) return anchor;
  }
  return "";
}

function findMatchingLeadingAnchor(text, target) {
  const compact = text.replace(/^\s+/g, "");
  for (const length of [80, 60, 40, 24, 12]) {
    const anchor = compact.slice(0, length);
    if (anchor && target.includes(anchor)) return anchor;
  }
  return "";
}

function extractSolutionFromFixNote(fixNote) {
  const text = normalizeInlineText(fixNote || "");
  if (!text) return "";
  const quotedSolution = text.match(/(?:แก้ไขเป็น|ปรับเป็น|เปลี่ยนเป็น|เป็น|เช่น)\s*["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
  if (quotedSolution?.[1]) return quotedSolution[1];
  if (/^ลบ/.test(text)) return "ลบออก";
  return truncatePlainText(text, 160);
}

function formatPolicyReferenceReason(issue) {
  const reason = normalizeInlineText(issue.issue_detail || "");
  if (!reason) return "";
  return `*Reason:*\n"${escapeMrkdwn(truncatePlainText(reason, 180))}"`;
}

function formatPolicyReferenceMeaning(issue, title) {
  const meaning = [issue.reference_section, title]
    .map(normalizeInlineText)
    .find((value) => value && !isReferenceLocatorLike(value));
  if (!meaning) return "";
  return `Policy meaning: ${escapeMrkdwn(truncatePlainText(meaning, 120))}`;
}

function isReferenceLocatorLike(value) {
  return /^(ข้อ|หน้า|section|rule)\s*[\d().\-–/]+/i.test(normalizeInlineText(value));
}

function formatPlacementIssueForModal(placement) {
  return [
    "*Placements*",
    `*Issue:* ${formatPlacementContextMrkdwn(placement)}`
  ].filter(Boolean).join("\n");
}

function formatPlacementContextMrkdwn(placement = {}) {
  const finding = normalizeInlineText(placement.finding || "");
  const formats = Array.isArray(placement.formats)
    ? placement.formats.map(formatPlacementName).filter(Boolean)
    : [];
  const channelText = formats.length
    ? ` ในช่องทาง ${formats.map(formatInlineCode).join(" , ")}`
    : "";
  if (!finding) return `ตรวจพบ ${formatInlineCode("ปัญหา placement")}${channelText}`;
  const findingText = finding.startsWith("ตรวจพบ")
    ? escapeMrkdwn(finding)
    : `ตรวจพบ ${escapeMrkdwn(finding)}`;
  return `${findingText}${channelText}`;
}

function formatInlineCode(value) {
  const text = normalizeInlineText(value).replace(/`/g, "'").trim();
  if (!text) return "";
  return `\`${escapeMrkdwn(text)}\``;
}

function normalizeInlineText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function getThreadTitle(thread, index) {
  const text = String(thread.text || "");
  const match = text.match(/^\*([^*]+)\*/);
  if (match?.[1]) return normalizeInlineText(match[1]);
  const firstSection = (thread.blocks || []).find((block) => block.type === "section" && block.text?.text);
  const sectionMatch = String(firstSection?.text?.text || "").match(/^\*([^*]+)\*/);
  if (sectionMatch?.[1]) return normalizeInlineText(sectionMatch[1]);
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

function getCatalogImageUrls(thread, details = {}) {
  const media = details.media || {};
  const urls = details.placement?.hasAction
    ? [
        media.screenshotUrl,
        findFirstImageUrl(thread),
        media.creativeImageUrl,
        media.imageUrl,
        media.thumbnailUrl,
        DEFAULT_PLACEHOLDER_IMAGE
      ]
    : [
        media.creativeImageUrl,
        media.imageUrl,
        media.thumbnailUrl,
        media.screenshotUrl,
        findFirstImageUrl(thread),
        DEFAULT_PLACEHOLDER_IMAGE
      ];
  return unique(urls.filter((url) => typeof url === "string" && url.trim()));
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
  const issueTypes = [];
  if (details.placement?.hasAction) issueTypes.push("Placement");
  if (details.policy?.hasAction) issueTypes.push("Policy");
  if (details.spelling?.hasAction) issueTypes.push("Spelling");
  const affectedAdCount = Math.max(adIds.length, getAffectedAdCount(thread) || 1);

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${escapeMrkdwn(issueTypes.join(" + ") || "Issue")} · ` +
          `${affectedAdCount} affected ad${affectedAdCount === 1 ? "" : "s"}*`
      }
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

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateMrkdwn(`*Ad Name:* ${formatInlineCode(issueName)}`, 2500)
    }
  });

  if (details.placement?.hasAction) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateMrkdwn(formatPlacementIssueForModal(details.placement), 2500)
      }
    });
    const imageUrl = firstModalImageUrl(thread, details);
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

    if (shouldShowRevisedText(details) || details.policy?.hasAction || details.spelling?.hasAction) {
      blocks.push({ type: "divider" });
    }
  }

  if (details.policy?.hasAction || details.spelling?.hasAction) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Policy / Spell check*"
      }
    });
  }

  if (shouldShowRevisedText(details)) {
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

  if (details.policy?.hasAction) {
    const policySignals = getPolicySignals(details.policy);
    const visiblePolicyIssues = policyIssues.slice(0, 5);
    const visibleFallbackSignals = !visiblePolicyIssues.length
      ? policySignals.slice(0, 5)
      : [];

    if (visiblePolicyIssues.length || visibleFallbackSignals.length) {
      const issueLines = [
        ...visiblePolicyIssues.map((issue) => formatPolicyIssueForModal(issue, details)),
        ...visibleFallbackSignals.map(formatFallbackPolicySignalForModal)
      ].filter(Boolean);
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateMrkdwn(
            issueLines.join("\n\n"),
            2500
          )
        }
      });
    }

    const fixNotes = unique(
      policyIssues.map((issue) => issue.fix_note || "").filter(Boolean)
    ).slice(0, 5);
    if (fixNotes.length) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateMrkdwn(
            `\n*What to fix*\n${fixNotes.map((fix) => `• ${escapeMrkdwn(fix)}`).join("\n")}`,
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

  return blocks.slice(0, 95);
}

function buildRevisedTextMeta(details = {}) {
  if (!shouldShowRevisedText(details)) return {};
  const fullText = sanitizeRevisedTextForSlack(cleanRevisedText(details.revisedText));
  if (!fullText) return {};
  return {
    fullRevisedText: fullText,
    fullRevisedTextChunks: chunkText(fullText, REVISED_TEXT_CHUNK_LIMIT),
    fullRevisedTextWasTruncated: isRevisedTextTruncated(details.revisedText, REVISED_TEXT_PREVIEW_LIMIT)
  };
}

function shouldShowRevisedText(details = {}) {
  return Boolean(details.revisedText && (details.policy?.hasAction || details.spelling?.hasAction));
}

function firstModalImageUrl(thread, details) {
  if (details.media?.screenshotUrl) return details.media.screenshotUrl;
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

function parseCsv(value) {
  return unique(
    `${value || ""}`
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
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
  const header = "\n:heavy_check_mark: *Revised text (Copy and paste this version)*\n";
  const openFence = "```\n";
  const closeFence = "\n```";
  const maxContentLength = Math.max(0, limit - header.length - openFence.length - closeFence.length);
  const content = truncateCodeContent(escapeRevisedText(text), maxContentLength);
  return `${header}${openFence}${content}${closeFence}`;
}

function isRevisedTextTruncated(text, limit) {
  const header = "\n:heavy_check_mark: *Revised text (Copy and paste this version)*\n";
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
  return truncateMrkdwn(normalizeInlineText(value), limit);
}

function trimTrailingSlash(value) {
  return `${value || ""}`.replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
