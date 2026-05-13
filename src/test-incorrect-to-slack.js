import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { sendSlackAccountAlert } from "./alerts.js";
import { validateScreenshotWithGemini } from "./gemini-validator.js";
import { uploadScreenshotToSupabase } from "./storage.js";

async function main() {
  const config = loadConfig();
  const targetDir = process.argv[2];
  const channelId = process.argv[3] || process.env.SLACK_TEST_CHANNEL_ID;

  if (!targetDir) {
    throw new Error("Usage: node src/test-incorrect-to-slack.js <image-directory> <channel-id>");
  }

  if (!channelId) {
    throw new Error("Slack channel id is required.");
  }

  if (!config.slackBotToken) {
    throw new Error("SLACK_BOT_TOKEN is required.");
  }

  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required.");
  }

  const files = await listImages(path.resolve(targetDir));
  if (!files.length) {
    console.log("No image files found.");
    return;
  }

  const account = {
    id: "act_test_incorrect",
    name: "Incorrect Folder Test",
    client: {
      clientName: "Incorrect Folder Test",
      slackPublicChannelId: channelId
    }
  };

  const results = [];

  for (const file of files) {
    const validation = await validateScreenshotWithGemini({
      config,
      screenshotPath: file
    });

    const imageBuffer = await fs.readFile(file);
    const uploaded = await uploadScreenshotToSupabase({
      supabaseUrl: config.supabaseUrl,
      serviceKey: config.supabaseServiceKey,
      bucket: config.supabaseStorageBucket,
      prefix: config.supabaseStoragePrefix,
      fileName: path.basename(file),
      buffer: imageBuffer,
      contentType: inferMimeType(file)
    });

    results.push({
      account,
      ad: {
        id: path.basename(file),
        name: path.basename(file),
        campaignName: "Incorrect Folder Test",
        adsetName: "Incorrect Folder Test",
        spend: 0
      },
      format: "TEST_IMAGE",
      screenshotPath: file,
      screenshotUrl: uploaded.publicUrl,
      analysis: validation.analysis,
      geminiValidation: validation
    });
  }

  const alert = await sendSlackAccountAlert({ botToken: config.slackBotToken }, account, results);
  console.log(JSON.stringify(alert, null, 2));
}

async function listImages(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function inferMimeType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
