import fs from "node:fs/promises";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || "output/unified-alert-preview-recovery-enriched.json";
  const output = args.out || "output/recovery-placement-from-latest-unified.json";
  const unified = JSON.parse(await fs.readFile(input, "utf8"));
  const results = [];

  for (const thread of unified.threadMessages || []) {
    const blocks = thread.blocks || [];
    for (const block of blocks) {
      if (block.type !== "image") continue;
      const parsed = parsePlacementImageTitle(block.title?.text || "");
      if (!parsed.adId || !parsed.format) continue;
      results.push({
        account: {
          id: unified.meta?.accountId || "",
          name: unified.meta?.accountName || unified.meta?.clientName || ""
        },
        ad: { id: parsed.adId },
        format: parsed.format,
        screenshotUrl: block.image_url || "",
        analysis: {
          status: "FAIL",
          risk: "high",
          issues: [{ message: parsed.finding || "Issue detected" }]
        }
      });
    }
  }

  const report = {
    generatedAt: unified.meta?.generatedAt || new Date().toISOString(),
    results,
    accountAlerts: []
  };
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, results: results.length }, null, 2));
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

function parsePlacementImageTitle(title) {
  const clean = `${title || ""}`.replace(/^📐\s*/, "").trim();
  const parts = clean.split("·").map((part) => part.trim());
  const format = parts[0] || "";
  const adMatch = (parts[1] || "").match(/Ad\s+(\d+)/i);
  return {
    format,
    adId: adMatch ? adMatch[1] : "",
    finding: parts.slice(2).join(" · ")
  };
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
