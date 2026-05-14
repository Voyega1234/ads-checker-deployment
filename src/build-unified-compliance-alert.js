import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import "./env.js";
import { postSlackMessage, sleep } from "./slack.js";

const ACTIONABLE_PLACEMENT_RISKS = new Set(["high", "medium"]);
const DEFAULT_REPORT_PATH = "/tmp/ad-preview-checker-act-1959218444986377-20260427-nofilters/report-latest.json";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args.report || DEFAULT_REPORT_PATH;
  const outPath = args.out || path.resolve("output/unified-alert-preview.json");
  const accountId = normalizeActId(args.account || inferAccountIdFromReportPath(reportPath));
  const source = `${args.source || ""}`.trim();
  const newAdIds = parseCsv(args["new-ad-ids"] || args.newAdIds || "");

  const placementReport = await readJson(reportPath);
  const placementResults = placementReport.results || [];
  const account = buildAccountSummary(placementResults, accountId);
  const [policyRows, accountInfo] = await Promise.all([
    fetchPolicyRows(account.numericId),
    fetchAccountInfo(account.numericId)
  ]);
  if (accountInfo?.accountName) account.name = accountInfo.accountName;
  const metaAdByAdId = await fetchMetaAdMetaByAdId(collectAdIds(policyRows, placementResults));
  const alert = await buildUnifiedAlert({
    account,
    generatedAt: placementReport.generatedAt || new Date().toISOString(),
    placementResults,
    policyRows,
    metaAdByAdId,
    source,
    newAdIds
  });

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(alert, null, 2)}\n`);

  let slack = null;
  if (args["slack-channel"]) {
    slack = await sendUnifiedAlertToSlack(alert, args["slack-channel"]);
  }

  console.log(
    JSON.stringify(
      {
        outPath,
        account: `${alert.meta.clientName} ${alert.meta.accountId}`,
        ads: alert.meta.adCount,
        creatives: alert.meta.creativeCount,
        policyCreatives: alert.meta.policyCreativeCount,
        spellingCreatives: alert.meta.spellingCreativeCount,
        placementAds: alert.meta.placementAdCount,
        threadCount: alert.threadMessages.length,
        slack
      },
      null,
      2
    )
  );
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

function parseCsv(value) {
  return unique(
    `${value || ""}`
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function inferAccountIdFromReportPath(reportPath) {
  const match = reportPath.match(/act_\d+/);
  return match ? match[0] : "";
}

function normalizeActId(accountId) {
  const raw = `${accountId || ""}`.trim();
  if (!raw) throw new Error("Missing account id. Pass --account act_<id>.");
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

function buildAccountSummary(results, fallbackAccountId) {
  const first = results.find((result) => result.account?.id) || {};
  const id = normalizeActId(first.account?.id || fallbackAccountId);
  const numericId = id.replace(/^act_/, "");
  const name = first.account?.name && first.account.name !== id ? first.account.name : id;
  return { id, numericId, name };
}

async function fetchPolicyRows(accountNumericId) {
  const { supabaseUrl, supabaseKey } = getSupabaseEnv();
  const query = new URL(`${supabaseUrl}/rest/v1/meta_ad_check_db`);
  query.searchParams.set("select", "*");
  query.searchParams.set("ad_account_id", `eq.${accountNumericId}`);
  return fetchSupabaseJson(query, supabaseKey, "policy rows");
}

async function fetchAccountInfo(accountNumericId) {
  const { supabaseUrl, supabaseKey } = getSupabaseEnv();
  const query = new URL(`${supabaseUrl}/rest/v1/meta_adaccounts`);
  query.searchParams.set("select", "\"Account ID\",\"Account name\",Client,Status");
  query.searchParams.set("Account ID", `eq.${accountNumericId}`);
  const rows = await fetchSupabaseJson(query, supabaseKey, "account info");
  const row = rows[0] || {};
  return {
    accountName: row["Account name"] || "",
    clientName: row.Client || "",
    status: row.Status || ""
  };
}

function getSupabaseEnv() {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY/SUPABASE_KEY are required.");
  }
  return { supabaseUrl, supabaseKey };
}

async function fetchSupabaseJson(query, supabaseKey, label) {
  const response = await fetch(query, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${label} fetch failed ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function sendUnifiedAlertToSlack(alert, channelId) {
  const botToken = process.env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_OAUTH;
  if (!botToken) throw new Error("SLACK_BOT_TOKEN or SLACK_BOT_OAUTH is required to send Slack.");
  const messageDelayMs = parsePositiveInt(process.env.SLACK_MESSAGE_DELAY_MS, 750);
  const maxRetries = parsePositiveInt(process.env.SLACK_MAX_RETRIES, 3);

  const main = await postSlackMessage({
    botToken,
    channelId,
    text: alert.mainMessage.text,
    blocks: alert.mainMessage.blocks,
    maxRetries
  });

  const sentReplies = [];
  const failedReplies = [];
  for (const [index, message] of alert.threadMessages.entries()) {
    if (index > 0 && messageDelayMs > 0) {
      await sleep(messageDelayMs);
    }

    await postSlackMessage({
      botToken,
      channelId,
      threadTs: main.ts,
      text: message.text,
      blocks: message.blocks,
      maxRetries
    })
      .then((response) => {
        sentReplies.push({ key: message.key, ts: response.ts });
      })
      .catch((error) => {
        failedReplies.push({ key: message.key, error: error.message });
      });
  }

  if (failedReplies.length) {
    throw new Error(
      `Slack send incomplete: ${sentReplies.length} sent, ${failedReplies.length} failed. First failure: ${failedReplies[0].error}`
    );
  }

  return {
    channelId,
    threadTs: main.ts,
    threadMessages: sentReplies.length,
    messageDelayMs,
    maxRetries
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(`${value || ""}`, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function buildUnifiedAlert({
  account,
  generatedAt,
  placementResults,
  policyRows,
  metaAdByAdId,
  source = "",
  newAdIds = []
}) {
  const placementByAdId = buildPlacementByAdId(placementResults);
  const adMetaByAdId = buildAdMetaByAdId(placementResults, metaAdByAdId);
  const policyByAdId = buildPolicyByAdId(policyRows);
  const allAdIds = unique([...policyByAdId.keys(), ...placementByAdId.keys()]);
  const newAdIdSet = new Set((newAdIds || []).map((id) => `${id}`.trim()).filter(Boolean));
  const groups = groupByCreative(allAdIds, policyByAdId, placementByAdId, adMetaByAdId, newAdIdSet);
  applyIssueFingerprints(groups, account.id);
  await applyResolvedIssueFingerprints(groups);
  const actionableGroups = groups.filter(
    (group) => group.policy.hasAction || group.spelling.hasAction || group.placement.hasAction
  );
  const openGroups = actionableGroups.filter((group) => !group.resolution.resolved);

  const clientName =
    firstNonEmpty(policyRows.map((row) => row.client_id)) || account.name || account.id;
  const dateLabel = formatDate(generatedAt);
  const adCount = unique(openGroups.flatMap((group) => group.adIds)).length;
  const issueGroupCount = openGroups.length;
  const creativeCount = countUniqueCreatives(openGroups);
  const policyCreativeCount = countUniqueCreatives(
    openGroups.filter((group) => group.policy.hasAction)
  );
  const spellingCreativeCount = countUniqueCreatives(
    openGroups.filter((group) => group.spelling.hasAction)
  );
  const actionablePlacementResults = placementResults.filter((result) =>
    ACTIONABLE_PLACEMENT_RISKS.has(result.analysis?.risk)
  );
  const resolvedAdIds = new Set(openGroups.flatMap((group) => group.adIds));
  const placementAdCount = unique(
    actionablePlacementResults
      .map((result) => result.ad?.id)
      .filter((adId) => adId && resolvedAdIds.has(adId))
  ).length;
  const placementCreativeCount = unique(
    actionablePlacementResults
      .filter((result) => resolvedAdIds.has(result.ad?.id))
      .map((result) => result.ad?.creativeId)
      .filter(Boolean)
  ).length;

  return {
    meta: {
      clientName,
      accountId: account.id,
      accountName: account.name,
      generatedAt,
      adCount,
      creativeCount,
      issueGroupCount,
      policyCreativeCount,
      spellingCreativeCount,
      placementAdCount,
      placementCreativeCount,
      threadCount: openGroups.length,
      resolvedIssueGroupCount: actionableGroups.length - openGroups.length,
      source,
      newAdIds: [...newAdIdSet],
      newAdCount: unique(openGroups.flatMap((group) => group.newAdIds || [])).length
    },
    mainMessage: {
      text: `Ad Compliance Alert: ${clientName} ${account.id}`,
      blocks: buildMainBlocks({
        clientName,
        accountId: account.id,
        dateLabel,
        adCount,
        creativeCount,
        issueGroupCount,
        policyCreativeCount,
        spellingCreativeCount,
        placementAdCount,
        placementCreativeCount,
        threadCount: openGroups.length
      })
    },
    threadMessages: actionableGroups.map((group) => ({
      key: group.key,
      details: buildStructuredDetails(group),
      text: buildThreadText(group),
      blocks: buildThreadBlocks(group)
    }))
  };
}

function buildPlacementByAdId(results) {
  const map = new Map();
  for (const result of results) {
    if (!ACTIONABLE_PLACEMENT_RISKS.has(result.analysis?.risk)) continue;
    const adId = `${result.ad?.id || ""}`.trim();
    if (!adId) continue;
    const existing = map.get(adId) || [];
    existing.push(result);
    map.set(adId, existing);
  }
  return map;
}

function buildAdMetaByAdId(results, metaAdByAdId = new Map()) {
  const map = new Map(metaAdByAdId);
  for (const result of results || []) {
    const adId = `${result.ad?.id || ""}`.trim();
    if (!adId) continue;
    const existing = map.get(adId) || {};
    map.set(adId, {
      ...existing,
      adName: result.ad?.name || "",
      creativeId: result.ad?.creativeId || "",
      adSetName: result.ad?.adsetName || "",
      campaignName: result.ad?.campaignName || ""
    });
  }
  return map;
}

async function fetchMetaAdMetaByAdId(adIds) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token || !adIds.length) return new Map();

  const apiVersion = process.env.META_API_VERSION || "v22.0";
  const out = new Map();
  for (const chunk of chunks(adIds, 40)) {
    const query = new URL(`https://graph.facebook.com/${apiVersion}/`);
    query.searchParams.set("access_token", token);
    query.searchParams.set("ids", chunk.join(","));
    query.searchParams.set("fields", "id,name,creative{id,name},adset{id,name},campaign{id,name}");

    const response = await fetch(query);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const message = payload.error?.message || response.statusText;
      console.warn(`Meta ad metadata fetch skipped: ${message}`);
      continue;
    }

    for (const [adId, ad] of Object.entries(payload)) {
      out.set(adId, {
        adName: ad?.name || "",
        creativeId: ad?.creative?.id || "",
        creativeName: ad?.creative?.name || "",
        adSetName: ad?.adset?.name || "",
        campaignName: ad?.campaign?.name || ""
      });
    }
  }
  return out;
}

function collectAdIds(policyRows, placementResults) {
  return unique([
    ...(policyRows || []).map((row) => row.ad_id),
    ...(placementResults || []).map((result) => result.ad?.id)
  ].filter(Boolean));
}

function buildPolicyByAdId(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const adId = `${row.ad_id || ""}`.trim();
    if (!adId) continue;
    const normalized = extractNormalized(row.ad_text_assessment_result);
    const policyRisk = policyRiskLabel(normalized);
    const spellingErrors = extractSpellErrors(normalized);
    const policyFlags = extractPolicyFlags(normalized);
    map.set(adId, {
      row,
      normalized,
      policyRisk,
      policyHasAction: policyRisk === "High Risk" || policyRisk === "Some Risk",
      policyFlags,
      spellingErrors,
      spellingHasAction: spellingErrors.length > 0,
      revisedText: extractRevisedText(normalized) || row.ad_text || ""
    });
  }
  return map;
}

function extractNormalized(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return extractNormalized(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (typeof value !== "object") return {};
  const normalized = value.normalized;
  return normalized && typeof normalized === "object" ? normalized : {};
}

function policyRiskLabel(normalized) {
  const matches = normalized.matches && typeof normalized.matches === "object" ? normalized.matches : {};
  const red = Array.isArray(matches.red) ? matches.red.filter(Boolean) : [];
  const yellow = Array.isArray(matches.yellow) ? matches.yellow.filter(Boolean) : [];
  if (red.length) return "High Risk";
  if (yellow.length) return "Some Risk";
  const verdict = `${normalized.verdict || ""}`.trim().toLowerCase();
  if (!verdict || ["pass", "ok", "low risk", "no risk"].includes(verdict)) return "Low Risk";
  if (verdict.includes("high risk") || verdict.startsWith("high ")) return "High Risk";
  if (verdict.includes("some") || verdict.includes("yellow") || verdict.includes("medium")) {
    return "Some Risk";
  }
  return "Low Risk";
}

function extractSpellErrors(normalized) {
  const errors = normalized.spell_errors || normalized.errors || [];
  if (!Array.isArray(errors)) return [];
  return errors.filter((error) => {
    if (!error || typeof error !== "object") return true;
    return `${error.type || ""}`.trim().toLowerCase() === "misspell";
  });
}

function extractRevisedText(normalized) {
  return `${normalized.revised_caption || normalized.corrected_caption || ""}`.trim();
}

function extractPolicyFlags(normalized) {
  const matches = normalized.matches && typeof normalized.matches === "object" ? normalized.matches : {};
  return unique([...(matches.red || []), ...(matches.yellow || [])].filter(Boolean));
}

function groupByCreative(adIds, policyByAdId, placementByAdId, adMetaByAdId, newAdIdSet = new Set()) {
  const groups = new Map();
  for (const adId of adIds) {
    const policy = policyByAdId.get(adId);
    const placements = placementByAdId.get(adId) || [];
    const representativePlacement = placements[0];
    const adMeta = adMetaByAdId.get(adId) || {};
    const row = policy?.row;
    const creativeId = row?.creative_id || representativePlacement?.ad?.creativeId || "";
    const name =
      representativePlacement?.ad?.name ||
      adMeta.adName ||
      row?.ad_name ||
      `Ad ${adId}`;
    const key = buildIssueGroupKey({ policy, placements, adId, creativeId, name });
    const group =
      groups.get(key) ||
      newEmptyGroup({
        key,
        creativeName: name,
        creativeId,
        representativeAdId: adId
      });

    group.adIds = unique([...group.adIds, adId]);
    if (newAdIdSet.has(adId)) {
      group.newAdIds = unique([...group.newAdIds, adId]);
      group.isNew = true;
    }
    group.creativeNames = unique([...group.creativeNames, name].filter(Boolean));
    group.creativeIds = unique([...group.creativeIds, creativeId].filter(Boolean));
    if (policy) {
      group.policyRows.push(policy);
      group.policy.hasAction = group.policy.hasAction || policy.policyHasAction;
      group.policy.risks = unique([...group.policy.risks, policy.policyRisk]);
      group.spelling.hasAction = group.spelling.hasAction || policy.spellingHasAction;
      group.spelling.errors.push(...policy.spellingErrors);
      if (!group.revisedText && policy.revisedText) group.revisedText = policy.revisedText;
      if (!group.originalText && policy.row?.ad_text) group.originalText = policy.row.ad_text;
    }
    if (placements.length) {
      group.placement.hasAction = true;
      group.placement.results.push(...placements);
      group.placement.formats = unique([
        ...group.placement.formats,
        ...placements.map((placement) => placement.format).filter(Boolean)
      ]);
      if (!group.imageResult) {
        group.imageResult = placements.find((placement) => placement.screenshotUrl) || placements[0];
      }
    }

    group.adSets = unique([
      ...group.adSets,
      adMeta.adSetName,
      ...placements.map((placement) => placement.ad?.adsetName).filter(Boolean)
    ].filter(Boolean));
    group.campaigns = unique([
      ...group.campaigns,
      adMeta.campaignName,
      ...placements.map((placement) => placement.ad?.campaignName).filter(Boolean)
    ].filter(Boolean));
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.creativeName = summarizeCreativeNames(group.creativeNames);
    group.policyRisk = strongestRisk(group.policy.risks);
    group.finding = buildPlacementFinding(group);
  }
  return Array.from(groups.values()).sort(compareGroups);
}

function applyIssueFingerprints(groups, accountId) {
  for (const group of groups) {
    group.issueType = getGroupIssueType(group);
    group.issueFingerprint = buildIssueFingerprint(accountId, group);
  }
}

async function applyResolvedIssueFingerprints(groups) {
  const fingerprints = unique(groups.map((group) => group.issueFingerprint).filter(Boolean));
  if (!fingerprints.length) return;
  const resolutions = await fetchIssueResolutions(fingerprints);
  for (const group of groups) {
    const resolution = resolutions.get(group.issueFingerprint);
    if (!resolution) continue;
    group.resolution = {
      resolved: Boolean(resolution.resolved),
      resolvedAt: resolution.resolved_at || "",
      resolvedBy: resolution.resolved_by || ""
    };
  }
}

async function fetchIssueResolutions(fingerprints) {
  const { supabaseUrl, supabaseKey } = getSupabaseEnv();
  const map = new Map();
  for (const chunk of chunks(fingerprints, 80)) {
    const query = new URL(`${supabaseUrl}/rest/v1/ad_compliance_issue_resolutions`);
    query.searchParams.set("select", "issue_fingerprint,resolved,resolved_at,resolved_by,updated_at");
    query.searchParams.set("issue_fingerprint", `in.(${chunk.join(",")})`);
    query.searchParams.set("resolved", "eq.true");
    try {
      const rows = await fetchSupabaseJson(query, supabaseKey, "issue resolutions");
      for (const row of rows || []) {
        map.set(row.issue_fingerprint, row);
      }
    } catch (error) {
      console.warn(`Resolved issue lookup skipped: ${error.message}`);
      return map;
    }
  }
  return map;
}

function getGroupIssueType(group) {
  const types = [];
  if (group.policy.hasAction) types.push("policy");
  if (group.spelling.hasAction) types.push("spelling");
  if (group.placement.hasAction) types.push("placement");
  return types.length ? types.join("+") : "none";
}

function buildIssueFingerprint(accountId, group) {
  const payload = [
    normalizeForKey(accountId),
    group.issueType,
    ...unique(group.creativeIds || []).sort().map(normalizeForKey),
    group.key
  ].join("::");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function buildIssueGroupKey({ policy, placements, adId, creativeId, name }) {
  if (!policy) {
    return `placement-only:${creativeId || name || adId}:${buildPlacementSignature(placements)}`;
  }

  return [
    "text-issue",
    normalizeForKey(policy.row?.ad_text || ""),
    normalizeForKey(policy.revisedText || ""),
    policy.policyRisk,
    policy.policyFlags.map(normalizeForKey).sort().join("|"),
    policy.spellingErrors.map(formatSpellFix).map(normalizeForKey).sort().join("|"),
    buildPlacementSignature(placements)
  ].join("::");
}

function buildPlacementSignature(placements) {
  if (!placements?.length) return "placement:none";
  return placements
    .map((placement) => {
      const messages = (placement.analysis?.issues || [])
        .map((issue) => issue.message)
        .filter(Boolean)
        .map(normalizeForKey)
        .sort()
        .join("|");
      return `${placement.format || ""}:${messages}`;
    })
    .sort()
    .join(";");
}

function normalizeForKey(value) {
  return `${value || ""}`.trim().replace(/\s+/g, " ").toLowerCase();
}

function newEmptyGroup({ key, creativeName, creativeId, representativeAdId }) {
  return {
    key,
    creativeName,
    creativeId,
    creativeNames: [creativeName].filter(Boolean),
    creativeIds: [creativeId].filter(Boolean),
    representativeAdId,
    adIds: [],
    adSets: [],
    campaigns: [],
    policyRows: [],
    policy: { hasAction: false, risks: [] },
    spelling: { hasAction: false, errors: [] },
    placement: { hasAction: false, results: [], formats: [] },
    isNew: false,
    newAdIds: [],
    originalText: "",
    revisedText: "",
    imageResult: null,
    finding: "",
    policyRisk: "N/A",
    issueType: "none",
    issueFingerprint: "",
    resolution: { resolved: false, resolvedAt: "", resolvedBy: "" }
  };
}

function summarizeCreativeNames(names) {
  const list = unique(names).filter(Boolean);
  if (!list.length) return "N/A";
  if (list.length === 1) return list[0];
  return `${list[0]} +${list.length - 1} more`;
}

function strongestRisk(risks) {
  if (risks.includes("High Risk")) return "High Risk";
  if (risks.includes("Some Risk")) return "Some Risk";
  if (risks.includes("Low Risk")) return "Low Risk";
  return "N/A";
}

function compareGroups(left, right) {
  const leftScore = groupScore(left);
  const rightScore = groupScore(right);
  if (leftScore !== rightScore) return leftScore - rightScore;
  return left.creativeName.localeCompare(right.creativeName);
}

function groupScore(group) {
  if (group.policyRisk === "High Risk") return 0;
  if (group.placement.hasAction) return 1;
  if (group.spelling.hasAction) return 2;
  if (group.policyRisk === "Some Risk") return 3;
  return 9;
}

function buildPlacementFinding(group) {
  const messages = unique(
    group.placement.results.flatMap((result) =>
      (result.analysis?.issues || []).map((issue) => issue.message).filter(Boolean)
    )
  );
  return messages[0] || "Issue detected";
}

function buildResultFinding(result) {
  const messages = unique(
    (result.analysis?.issues || []).map((issue) => issue.message).filter(Boolean)
  );
  return messages[0] || "Issue detected";
}

function buildMainBlocks({
  clientName,
  accountId,
  dateLabel,
  adCount,
  creativeCount,
  policyCreativeCount,
  spellingCreativeCount,
  placementAdCount,
  placementCreativeCount,
  threadCount
}) {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "🚨 Ad Compliance Alert" }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeMrkdwn(clientName)}* · \`${accountId}\` · ${dateLabel}` }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Ads*\n${adCount} ads · ${creativeCount} creatives` },
        { type: "mrkdwn", text: `*Policy*\n${policyCreativeCount} creatives` },
        { type: "mrkdwn", text: `*Spelling*\n${spellingCreativeCount} creatives` },
        { type: "mrkdwn", text: `*Placement*\n${placementAdCount} ads` }
      ]
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${threadCount} threads below — revised text included when available`
        }
      ]
    }
  ];
}

function buildThreadText(group) {
  const newLabel = group.isNew ? " · New" : "";
  const revisedText = group.revisedText || group.originalText || "N/A";
  const lines = [
    `*${escapeMrkdwn(group.creativeName)}* · ${group.adIds.length} ad${group.adIds.length === 1 ? "" : "s"}${newLabel}`,
    formatAdIds(group.adIds),
    "",
    buildStatusText(group),
    "",
    ...buildPlacementIssuesTextSection(group),
    "*Revised text*",
    `\`\`\`${truncateCodeBlock(revisedText)}\`\`\``
  ];
  const context = buildContextLine(group);
  if (context) lines.push("", context);
  return lines.join("\n");
}

function buildThreadBlocks(group) {
  const newLabel = group.isNew ? " · *New*" : "";
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMrkdwn(group.creativeName)}* · ${group.adIds.length} ad${group.adIds.length === 1 ? "" : "s"}${newLabel}\n${formatAdIds(group.adIds)}`
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: buildStatusText(group)
      }
    },
    ...buildPlacementIssueBlocks(group),
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Revised text*\n\`\`\`${truncateCodeBlock(group.revisedText || group.originalText || "N/A")}\`\`\``
      }
    }
  ];

  blocks.push(...buildScreenshotBlocks(group));

  const context = buildContextLine(group);
  if (context) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: context.slice(0, 2900) }]
    });
  }

  return blocks;
}

function buildPlacementIssuesTextSection(group) {
  const lines = buildPlacementIssueLines(group);
  if (!lines.length) return [];
  return ["*Placement issues*", ...lines, ""];
}

function buildPlacementIssueBlocks(group) {
  const lines = buildPlacementIssueLines(group);
  if (!lines.length) return [];
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Placement issues*\n${lines.join("\n")}`
      }
    }
  ];
}

function buildPlacementIssueLines(group) {
  const items = getPlacementIssueItems(group);
  if (!items.length) return [];
  const limit = 8;
  const lines = items.slice(0, limit).map((item) => {
    return `- Ad ID: \`${item.adId}\` · \`${item.format}\` · ${escapeMrkdwn(item.finding)}`;
  });
  if (items.length > limit) {
    lines.push(`- +${items.length - limit} more placement issues`);
  }
  return lines;
}

function getPlacementIssueItems(group) {
  const seen = new Set();
  const items = [];
  for (const result of group.placement.results) {
    const adId = `${result.ad?.id || ""}`.trim();
    const format = `${result.format || ""}`.trim();
    const finding = buildResultFinding(result);
    const key = `${adId}:${format}:${finding}`;
    if (!adId || !format || seen.has(key)) continue;
    seen.add(key);
    items.push({ adId, format, finding });
  }
  return items;
}

function buildScreenshotBlocks(group) {
  const items = getPlacementScreenshotItems(group);
  const limit = parsePositiveInt(process.env.MAX_SCREENSHOTS_PER_REPLY, 4);
  const blocks = items.slice(0, limit).map((item) => ({
    type: "image",
    title: {
      type: "plain_text",
      text: `📐 ${item.format} · Ad ${item.adId} · ${item.finding}`.slice(0, 200)
    },
    image_url: item.screenshotUrl,
    alt_text: "Ad placement preview"
  }));

  if (items.length > limit) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `+${items.length - limit} more screenshots omitted`
        }
      ]
    });
  }

  return blocks;
}

function getPlacementScreenshotItems(group) {
  const seen = new Set();
  const items = [];
  for (const result of group.placement.results) {
    const adId = `${result.ad?.id || ""}`.trim();
    const format = `${result.format || ""}`.trim();
    const screenshotUrl = `${result.screenshotUrl || ""}`.trim();
    const finding = buildResultFinding(result);
    const key = `${adId}:${format}:${screenshotUrl}`;
    if (!adId || !format || !screenshotUrl || seen.has(key)) continue;
    seen.add(key);
    items.push({ adId, format, screenshotUrl, finding });
  }
  return items;
}

function getPlacementIssueAdCount(group) {
  return unique(group.placement.results.map((result) => result.ad?.id).filter(Boolean)).length;
}

function buildStatusLine(group) {
  return buildStatusText(group);
}

function buildStatusText(group) {
  const placementIssueAdCount = getPlacementIssueAdCount(group);
  const values = buildStatusValues(group, placementIssueAdCount);
  return `*Policy:* ${values.policy} · *Spelling:* ${values.spelling}\n*Placement:* ${values.placement} · *Image:* ${values.image}`;
}

function buildStatusFields(group) {
  const placementIssueAdCount = getPlacementIssueAdCount(group);
  const values = buildStatusValues(group, placementIssueAdCount);
  return [
    { type: "mrkdwn", text: `*Policy*\n${values.policy}` },
    { type: "mrkdwn", text: `*Spelling*\n${values.spelling}` },
    { type: "mrkdwn", text: `*Placement*\n${values.placement}` },
    { type: "mrkdwn", text: `*Image*\n${values.image}` }
  ];
}

function buildStatusValues(group, placementIssueAdCount) {
  const spellFixes = getUniqueSpellFixes(group);
  const policy = group.policy.hasAction ? `✕ ${group.policyRisk}` : "N/A";
  const spelling = group.spelling.hasAction
    ? `✕ ${spellFixes.length} error${spellFixes.length === 1 ? "" : "s"}`
    : "N/A";
  const placement = group.placement.hasAction
    ? `✕ Issue (${placementIssueAdCount} ad${placementIssueAdCount === 1 ? "" : "s"})`
    : "N/A";
  const image = group.imageResult?.screenshotUrl ? ":warning: Attached" : "N/A";
  return { policy, spelling, placement, image };
}

function buildStructuredDetails(group) {
  const matches = group.policyRows.reduce(
    (acc, policy) => {
      const rowMatches = policy.normalized.matches || {};
      acc.red.push(...(Array.isArray(rowMatches.red) ? rowMatches.red.filter(Boolean) : []));
      acc.yellow.push(...(Array.isArray(rowMatches.yellow) ? rowMatches.yellow.filter(Boolean) : []));
      return acc;
    },
    { red: [], yellow: [] }
  );
  const fixNotes = unique(
    group.policyRows.flatMap((policy) => {
      const normalized = policy.normalized || {};
      const notes =
        normalized.fix_notes ||
        normalized.fixNotes ||
        normalized.recommendations ||
        normalized.revision_notes ||
        [];
      return Array.isArray(notes) ? notes.filter(Boolean) : [];
    })
  );
  const policyV2Issues = uniqueBy(
    group.policyRows.flatMap((policy) => {
      const analysis = policy.normalized?.policy_v2 || {};
      const issues = Array.isArray(analysis.issues) ? analysis.issues : [];
      return issues.filter((issue) => issue && typeof issue === "object");
    }),
    (issue) => [
      issue.rule_id || "",
      issue.flagged_text || "",
      issue.issue_title || "",
      issue.issue_detail || "",
      issue.fix_note || ""
    ].join("|")
  );
  const policyV2QuickReference = group.policyRows
    .map((policy) => policy.normalized?.policy_v2?.quick_reference)
    .find((quickReference) => quickReference && typeof quickReference === "object") || null;
  const policyV2Verification = group.policyRows
    .map((policy) => policy.normalized?.policy_v2_verification)
    .find((verification) => verification && typeof verification === "object") || null;

  return {
    issueFingerprint: group.issueFingerprint,
    issueType: group.issueType,
    resolution: group.resolution,
    isNew: Boolean(group.isNew),
    newAdIds: group.newAdIds || [],
    originalText: group.originalText || "",
    revisedText: group.revisedText || "",
    policy: {
      hasAction: group.policy.hasAction,
      risk: group.policyRisk,
      redFlags: unique(matches.red),
      yellowFlags: unique(matches.yellow),
      fixNotes,
      issues: policyV2Issues,
      quickReference: policyV2QuickReference,
      verification: policyV2Verification
    },
    spelling: {
      hasAction: group.spelling.hasAction,
      errors: group.spelling.errors,
      fixes: getUniqueSpellFixes(group)
    },
    placement: {
      hasAction: group.placement.hasAction,
      finding: group.finding,
      formats: group.placement.formats
    }
  };
}

function formatSpellFix(error) {
  if (!error || typeof error !== "object") return `${error || ""}`;
  const original = error.original || error.original_text || "";
  const corrected = error.corrected || error.corrected_text || "";
  if (!original && !corrected) return "";
  return `${original} → ${corrected}`;
}

function getUniqueSpellFixes(group) {
  return unique(group.spelling.errors.map(formatSpellFix).filter(Boolean));
}

function buildContextLine(group) {
  const parts = [];
  const policyFlags = unique(
    group.policyRows.flatMap((policy) => {
      const matches = policy.normalized.matches || {};
      return [...(matches.red || []), ...(matches.yellow || [])].filter(Boolean);
    })
  );
  if (policyFlags.length) parts.push(`⚑ Policy: ${summarizeList(policyFlags, 8)}`);

  const spellFixes = getUniqueSpellFixes(group);
  if (spellFixes.length) parts.push(`Spelling: ${summarizeList(spellFixes, 5)}`);
  if (group.placement.hasAction) parts.push(`Placement: ${group.finding}`);
  return parts.join(" | ");
}

function formatAdIdLine(adIds) {
  const label = adIds.length === 1 ? "Ad ID" : "Ad IDs";
  return `${label}: ${adIds.map((adId) => `\`${adId}\``).join(" · ")}`;
}

function formatAdIds(adIds) {
  return adIds.map((adId) => `\`${adId}\``).join(" · ");
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok"
  }).format(date);
}

function stableTextKey(text) {
  return `${text || ""}`.trim().replace(/\s+/g, " ").slice(0, 160);
}

function escapeMrkdwn(text) {
  return `${text || ""}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateCodeBlock(text, limit = 2800) {
  const value = `${text || ""}`.replace(/```/g, "`\u200b``");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 20)}\n...[truncated]`;
}

function summarizeList(values, limit) {
  const list = unique(values).map((value) => `${value}`.trim()).filter(Boolean);
  if (list.length <= limit) return list.join(" · ");
  return `${list.slice(0, limit).join(" · ")} · +${list.length - limit} more`;
}

function firstNonEmpty(values) {
  return values.map((value) => `${value || ""}`.trim()).find(Boolean) || "";
}

function countUniqueCreatives(groups) {
  const ids = unique(groups.flatMap((group) => group.creativeIds || []).filter(Boolean));
  return ids.length || groups.length;
}

function unique(values) {
  return Array.from(new Set(values));
}

function uniqueBy(values, keyFn) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
