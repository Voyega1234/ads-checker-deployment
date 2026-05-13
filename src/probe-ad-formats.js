import "dotenv/config";
import { fetchRunnableAds, fetchAdPreviewHtml } from "./meta.js";
import { loadConfig } from "./config.js";

const [, , accountIdArg, formatsArg] = process.argv;

if (!accountIdArg || !formatsArg) {
  throw new Error(
    "Usage: node src/probe-ad-formats.js <account-id> <comma-separated-formats>"
  );
}

const accountId = accountIdArg.startsWith("act_") ? accountIdArg : `act_${accountIdArg}`;
const formats = formatsArg
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

async function main() {
  const config = loadConfig();
  const ads = await fetchRunnableAds(config, { id: accountId, name: accountId });

  if (!ads.length) {
    throw new Error(`No runnable ads found for ${accountId}`);
  }

  const sampleAd = ads[0];
  const supported = [];
  const unsupported = [];
  const otherErrors = [];

  for (const format of formats) {
    try {
      await fetchAdPreviewHtml(config, sampleAd.id, format);
      supported.push(format);
    } catch (error) {
      const message = error.message || "";
      if (message.includes("ad_format must be one of")) {
        unsupported.push({ format, error: message });
      } else {
        otherErrors.push({ format, error: message });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        accountId,
        sampleAdId: sampleAd.id,
        sampleAdName: sampleAd.name,
        requestedCount: formats.length,
        supportedCount: supported.length,
        unsupportedCount: unsupported.length,
        otherErrorCount: otherErrors.length,
        supported,
        unsupported,
        otherErrors
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
