import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { validateScreenshotWithGemini } from "./gemini-validator.js";

async function main() {
  const config = loadConfig();
  const target = process.argv[2];

  if (!target) {
    throw new Error("Usage: node src/test-gemini-images.js <image-or-directory>");
  }

  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required.");
  }

  const targetPath = path.resolve(target);
  const stat = await fs.stat(targetPath);
  const files = stat.isDirectory() ? await listImages(targetPath) : [targetPath];

  if (!files.length) {
    console.log("No image files found.");
    return;
  }

  const results = [];

  for (const file of files) {
    try {
      const validation = await validateScreenshotWithGemini({
        config,
        screenshotPath: file
      });

      results.push({
        file,
        status: validation?.parsed?.status || "ERROR",
        adjustmentRequired: validation?.parsed?.adjustmentRequired || "",
        rationale: validation?.parsed?.rationale || "",
        rawText: validation?.rawText || ""
      });
    } catch (error) {
      results.push({
        file,
        status: "ERROR",
        adjustmentRequired: "",
        rationale: error.message
      });
    }
  }

  for (const result of results) {
    console.log(
      [
        "",
        path.basename(result.file),
        `STATUS: ${result.status}`,
        `ADJUSTMENT_REQUIRED: ${result.adjustmentRequired || "-"}`,
        `RATIONALE: ${result.rationale || "-"}`
      ].join("\n")
    );
  }

  const summary = {
    total: results.length,
    pass: results.filter((item) => item.status === "PASS").length,
    fail: results.filter((item) => item.status === "FAIL").length,
    error: results.filter((item) => item.status === "ERROR").length
  };

  console.log(`\nSummary: ${JSON.stringify(summary)}`);
}

async function listImages(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
