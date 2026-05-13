import fs from "node:fs/promises";
import { loadConfig } from "./config.js";
import { sendSlackAccountAlert } from "./alerts.js";

async function main() {
  const [, , accountId, channelId, clientNameArg] = process.argv;

  if (!accountId || !channelId) {
    throw new Error(
      "Usage: node src/send-account-alert-from-report.js <account-id> <channel-id> [client-name]"
    );
  }

  const config = loadConfig();
  if (!config.slackBotToken) {
    throw new Error("SLACK_BOT_TOKEN is required.");
  }

  const report = JSON.parse(await fs.readFile("output/report-latest.json", "utf8"));
  const results = (report.results || []).filter(
    (result) =>
      result?.account?.id === accountId && ["high", "medium"].includes(result?.analysis?.risk)
  );

  if (!results.length) {
    throw new Error(`No actionable results found for ${accountId}.`);
  }

  const firstAccount = results[0].account || {};
  const account = {
    ...firstAccount,
    client: {
      clientName: clientNameArg || firstAccount?.client?.clientName || firstAccount?.name || accountId,
      slackPublicChannelId: channelId
    }
  };

  const alert = await sendSlackAccountAlert(
    { botToken: config.slackBotToken, overrideChannelId: channelId },
    account,
    results
  );

  console.log(
    JSON.stringify(
      {
        accountId,
        channelId,
        actionableResults: results.length,
        alert
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
