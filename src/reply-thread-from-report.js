import fs from "node:fs/promises";
import { loadConfig } from "./config.js";
import { postSlackMessage } from "./slack.js";

const ACTIONABLE_RISKS = new Set(["high", "medium"]);

async function main() {
  const [, , reportPath, channelId, threadTs] = process.argv;

  if (!reportPath || !channelId || !threadTs) {
    throw new Error(
      "Usage: node src/reply-thread-from-report.js <report-path> <channel-id> <thread-ts>"
    );
  }

  const config = loadConfig();
  const botToken = config.slackBotToken;
  if (!botToken) {
    throw new Error("SLACK_BOT_TOKEN is required.");
  }

  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const actionableResults = (report.results || []).filter((result) =>
    ACTIONABLE_RISKS.has(result?.analysis?.risk)
  );
  const groupedResults = groupActionableResults(actionableResults).sort(compareGroupedResults);

  for (const group of groupedResults) {
    await postSlackMessage({
      botToken,
      channelId,
      threadTs,
      text: buildThreadText(group),
      blocks: buildThreadBlocks(group)
    });
  }

  console.log(
    JSON.stringify(
      {
        sent: true,
        reportPath,
        channelId,
        threadTs,
        actionableCount: actionableResults.length,
        uniqueAssetCount: groupedResults.length
      },
      null,
      2
    )
  );
}

function compareResults(left, right) {
  const severityScore = { high: 0, medium: 1, low: 2, error: 3 };
  const leftScore = severityScore[left.analysis?.risk] ?? 99;
  const rightScore = severityScore[right.analysis?.risk] ?? 99;
  if (leftScore !== rightScore) return leftScore - rightScore;
  return `${left.ad?.name || ""} ${left.format || ""}`.localeCompare(
    `${right.ad?.name || ""} ${right.format || ""}`
  );
}

function compareGroupedResults(left, right) {
  return compareResults(left.representative, right.representative);
}

function buildThreadText(group) {
  const { representative, placements, affectedAds } = group;
  const issueText = buildFindingsText(group);
  const adIdValues = unique(group.results.map((result) => result.ad?.id).filter(Boolean));
  const adSetValues = unique(group.results.map((result) => result.ad?.adsetName).filter(Boolean));
  const campaignValues = unique(
    group.results.map((result) => result.ad?.campaignName).filter(Boolean)
  );
  const adIds = summarizeList(adIdValues);
  const adSets = summarizeList(adSetValues);
  const campaigns = summarizeList(campaignValues);
  const placementLabel = placements.length > 1 ? "Placement types" : "Placement";
  const adIdLabel = adIdValues.length > 1 ? "Ad IDs" : "Ad ID";
  const adSetLabel = adSetValues.length > 1 ? "Ad sets" : "Ad set";
  const campaignLabel = campaignValues.length > 1 ? "Campaigns" : "Campaign";

  return [
    `*Creative:* \`${representative.ad?.name || "-"}\``,
    `*${placementLabel}:* \`${placements.join(", ")}\``,
    "",
    `*Finding:* ${issueText}`,
    `Used in: ${affectedAds.length} ads`,
    adIds ? `${adIdLabel}: ${adIds}` : "",
    adSets ? `${adSetLabel}: ${adSets}` : "",
    campaigns ? `${campaignLabel}: ${campaigns}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildThreadBlocks(group) {
  const result = group.representative;
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: buildThreadText(group)
      }
    }
  ];

  if (result.screenshotUrl) {
    blocks.push({
      type: "image",
      image_url: result.screenshotUrl,
      alt_text: `${result.ad?.name || "ad"} ${result.format || "preview"}`
    });
  }

  return blocks;
}

function buildFindingsText(group) {
  const messages = unique(
    group.results.flatMap((result) =>
      (result.analysis?.issues || []).map((issue) => issue.message).filter(Boolean)
    )
  );
  return messages.length ? messages.join(" | ") : "No additional details";
}

function groupActionableResults(results) {
  const groups = new Map();

  for (const result of results) {
    const key = result.dedupe?.key || `${result.ad?.id || "-"}:${result.format || "-"}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        key,
        representative: result,
        results: [result],
        placements: unique([result.format].filter(Boolean)),
        affectedAds: unique([result.ad?.id].filter(Boolean))
      });
      continue;
    }

    existing.results.push(result);
    existing.placements = unique([...existing.placements, result.format].filter(Boolean));
    existing.affectedAds = unique([...existing.affectedAds, result.ad?.id].filter(Boolean));

    if (compareResults(result, existing.representative) < 0) {
      existing.representative = result;
    }
  }

  return Array.from(groups.values());
}

function unique(values) {
  return Array.from(new Set(values));
}

function summarizeList(values, limit = 3) {
  if (!values.length) return "";
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")} +${values.length - limit} more`;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
