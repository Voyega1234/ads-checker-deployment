import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { fetchAdPreviewHtml, fetchRunnableAds, resolveSelectedAdAccounts } from "./meta.js";
import { closePreviewRenderer, renderPreviewScreenshot, saveRenderedScreenshot } from "./renderer.js";
import { sendSlackAccountAlert } from "./alerts.js";
import { validateScreenshotWithGemini } from "./gemini-validator.js";
import { buildPlacementFingerprint, loadPlacementCache } from "./placement-cache.js";
import { uploadScreenshotToSupabase } from "./storage.js";

const args = new Set(process.argv.slice(2));
const isDemo = args.has("--demo");
const asJson = args.has("--json");

async function main() {
  const config = loadConfig();
  const runStartTime = Date.now();
  await fs.mkdir(config.outputDir, { recursive: true });
  const releaseLock = await acquireRunLock(config);

  try {
    await cleanupOutputArtifacts(config.outputDir);
    await runChecks({ config, runStartTime });
  } finally {
    await closePreviewRenderer();
    await releaseLock();
  }
}

async function runChecks({ config, runStartTime }) {
  const selectedAccounts = isDemo
    ? [{ id: "demo-account", name: "Demo Account" }]
    : await resolveSelectedAdAccounts(config);

  if (!selectedAccounts.length) {
    console.log("No ad accounts matched the current filters.");
    return;
  }

  const results = [];
  const accountAlerts = [];
  let totalAds = 0;
  let uniqueCreativeChecks = 0;
  let dedupedAds = 0;
  let cachedAds = 0;

  for (const account of selectedAccounts) {
    const accountStartTime = Date.now();
    logProgress(`\n[ACCOUNT] ${account.name || account.id}`);
    const ads = isDemo ? await loadDemoAds() : await fetchRunnableAds(config, account);
    const limitedAds = config.adLimit != null ? ads.slice(0, config.adLimit) : ads;

    if (!limitedAds.length) {
      if (!asJson) console.log(`\n[SKIP] ${account.name} — no active ads found`);
      continue;
    }

    totalAds += limitedAds.length;
    const accountResults = [];
    const accountDedupedAds = { count: 0 };
    const accountUniqueCreatives = { count: 0 };
    const accountCachedAds = { count: 0 };
    const dedupeCache = new Map();
    const placementCache = isDemo ? null : await loadPlacementCache(config, account.id);

    for (const adBatch of chunkItems(limitedAds, config.adConcurrency)) {
      const batchRuns = await Promise.all(
        adBatch.map((ad) =>
          processAd({
            ad,
            account,
            config,
            isDemo,
            dedupeCache,
            placementCache
          })
        )
      );

      for (const run of batchRuns) {
        if (run.cacheHit) {
          cachedAds += 1;
          accountCachedAds.count += 1;
          logProgress(`[AD] ${run.ad.name} (${config.formats.length} placements, cached)`);
        } else if (run.reusedFromAdId) {
          dedupedAds += 1;
          accountDedupedAds.count += 1;
          logProgress(
            `[AD] ${run.ad.name} (${config.formats.length} placements, reused creative ${run.ad.creativeId})`
          );
        } else {
          uniqueCreativeChecks += 1;
          accountUniqueCreatives.count += 1;
          logProgress(`[AD] ${run.ad.name} (${config.formats.length} placements)`);
        }

        for (const result of run.placementResults) {
          results.push(result);
          accountResults.push(result);

          if (!asJson) {
            printResult(result);
          }
        }

        if (!asJson) {
          console.log(`  ⏱  ${run.adElapsed}s for ${config.formats.length} placements`);
        }

        await writeReport(config.outputDir, results, accountAlerts);
      }
    }

    const accountElapsed = ((Date.now() - accountStartTime) / 1000).toFixed(1);
    const accountChecks = accountResults.length;
    const accountAvgPerAd = limitedAds.length
      ? Number(accountElapsed) / limitedAds.length
      : 0;
    const accountAvgPerPreview = accountChecks
      ? Number(accountElapsed) / accountChecks
      : 0;
    if (!asJson) {
      console.log(
        [
          `\n── ${account.name}: ${limitedAds.length} creatives × ${config.formats.length} placements = ${accountChecks} previews`,
          `   Unique creative checks: ${accountUniqueCreatives.count}`,
          `   Reused duplicates    : ${accountDedupedAds.count}`,
          `   Cached from DB       : ${accountCachedAds.count}`,
          `   Time: ${formatDuration(accountElapsed)}`,
          `   Avg: 1 image/video × ${config.formats.length} placements = ${formatDuration(accountAvgPerAd)}`,
          `   Avg per preview: ${formatDuration(accountAvgPerPreview)}`
        ].join("\n")
      );
    }

    const alert = await trySendAccountAlert(
      {
        botToken: config.slackBotToken,
        overrideChannelId: config.slackOverrideChannelId
      },
      account,
      accountResults
    );
    accountAlerts.push({
      accountId: account.id,
      accountName: account.name,
      clientName: account.client?.clientName || null,
      alert
    });

    await writeReport(config.outputDir, results, accountAlerts);

    if (config.accountDelayMs > 0) {
      await sleep(config.accountDelayMs);
    }
  }

  if (!results.length) {
    console.log("No active ads matched the current filters.");
    return;
  }

  const reportPath = await writeReport(config.outputDir, results, accountAlerts);
  const totalElapsed = (Date.now() - runStartTime) / 1000;
  const totalChecks = results.length;
  const avgPerAd = totalAds > 0 ? totalElapsed / totalAds : 0;
  const avgPerPreview = totalChecks > 0 ? totalElapsed / totalChecks : 0;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          reportPath,
          results,
          accountAlerts,
          stats: {
            totalElapsedSeconds: Number(totalElapsed.toFixed(1)),
            totalElapsed: formatDuration(totalElapsed),
            totalAds,
            uniqueCreativeChecks,
            dedupedAds,
            cachedAds,
            placementsPerAd: config.formats.length,
            totalChecks,
            avgPerAdSeconds: Number(avgPerAd.toFixed(1)),
            avgPerAd: formatDuration(avgPerAd),
            avgPerPreviewSeconds: Number(avgPerPreview.toFixed(1)),
            avgPerPreview: formatDuration(avgPerPreview)
          }
        },
        null,
        2
      )
    );
  } else {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📊 Run Summary`);
    console.log(`   Accounts      : ${selectedAccounts.length}`);
    console.log(`   Creatives     : ${totalAds}`);
    console.log(`   Unique checks : ${uniqueCreativeChecks}`);
    console.log(`   Reused dupes  : ${dedupedAds}`);
    console.log(`   Cached DB     : ${cachedAds}`);
    console.log(`   Placements    : ${config.formats.length} per creative`);
    console.log(`   Total previews: ${totalChecks}`);
    console.log(`   Total time    : ${formatDuration(totalElapsed)}`);
    console.log(`   Avg creative  : 1 image/video × ${config.formats.length} placements = ${formatDuration(avgPerAd)}`);
    console.log(`   Avg preview   : ${formatDuration(avgPerPreview)}`);
    console.log(`${"─".repeat(60)}`);
    console.log(`\nReport saved: ${reportPath}`);
  }
}

async function loadDemoAds() {
  return [
    {
      id: "demo-ad-001",
      name: "Demo Square Creative In Story",
      campaignName: "Demo Campaign",
      adsetName: "Demo Ad Set",
      spend: 42.5
    }
  ];
}

async function writeReport(outputDir, results, accountAlerts = []) {
  const reportPath = path.join(outputDir, "report-latest.json");
  await fs.writeFile(
    reportPath,
    JSON.stringify({ generatedAt: new Date(), results, accountAlerts }, null, 2)
  );
  return reportPath;
}

async function acquireRunLock(config) {
  if (config.disableRunLock) return async () => {};

  const lockPath = path.join(config.outputDir, "run.lock");
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString()
  };

  try {
    await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const existing = await readJsonFile(lockPath);
    if (existing?.pid && isProcessAlive(existing.pid)) {
      throw new Error(
        `Another checker run appears to be active (pid ${existing.pid}). ` +
          "Kill it or set DISABLE_RUN_LOCK=1 if you are sure it is stale."
      );
    }

    await fs.rm(lockPath, { force: true });
    await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), { flag: "wx" });
  }

  return async () => {
    const existing = await readJsonFile(lockPath);
    if (!existing?.pid || existing.pid === process.pid) {
      await fs.rm(lockPath, { force: true });
    }
  };
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupOutputArtifacts(outputDir) {
  await Promise.all([
    ...["screenshots", "html", "debug"].map((directory) =>
      fs.rm(path.join(outputDir, directory), { recursive: true, force: true })
    ),
    removeGeneratedReports(outputDir)
  ]);
}

async function removeGeneratedReports(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const staleReports = entries.filter(
    (entry) =>
      entry.isFile() &&
      /^(report-\d|image-preview-report-\d).+\.json$/i.test(entry.name)
  );

  await Promise.all(
    staleReports.map((entry) => fs.rm(path.join(outputDir, entry.name), { force: true }))
  );
}

async function inspectPreview({ ad, format, config, isDemo, account }) {
  try {
    const html = isDemo
      ? await fs.readFile("samples/preview-instagram-story.html", "utf8")
      : await fetchAdPreviewHtml(config, ad.id, format);

    const rendered = await renderPreviewScreenshot({
      html,
      adId: ad.id,
      adName: ad.name,
      format,
      waitMs: config.previewWaitMs,
      retries: config.previewRetries,
      timeoutMs: config.renderTimeoutMs
    });

    const geminiValidation = await tryGeminiValidation({
      config,
      imageBuffer: rendered.buffer,
      format,
      creativeObjectType: ad.creativeObjectType
    });

    if (!geminiValidation?.analysis) {
      return {
        account,
        ad,
        format,
        dedupe: {
          key: buildCreativeDedupeKey(account, ad),
          reusedFromAdId: null,
          reusedFromAdName: null
        },
        analysis: {
          format,
          risk: "error",
          issues: [
            {
              severity: "high",
              code: "gemini_validation_failed",
              message: geminiValidation?.error || "Gemini validation failed."
            }
          ]
        },
        screenshotPath: undefined,
        screenshotUrl: undefined,
        geminiValidation
      };
    }

    const analysis = geminiValidation.analysis;
    const shouldSaveScreenshot = shouldPersistScreenshot(analysis);
    const screenshotPath = shouldSaveScreenshot
      ? await saveRenderedScreenshot({
          outputDir: config.outputDir,
          fileName: rendered.screenshotFileName,
          buffer: rendered.buffer
        })
      : undefined;
    const uploadedScreenshot = shouldSaveScreenshot
      ? await tryUploadScreenshot(config, rendered.screenshotFileName, rendered.buffer)
      : null;

    const result = {
      account,
      ad,
      format,
      dedupe: {
        key: buildCreativeDedupeKey(account, ad),
        reusedFromAdId: null,
        reusedFromAdName: null
      },
      screenshotPath,
      screenshotUrl:
        uploadedScreenshot?.publicUrl ||
        (screenshotPath ? buildScreenshotUrl(config.screenshotBaseUrl, rendered.screenshotFileName) : undefined),
      analysis,
      geminiValidation
    };
    return result;
  } catch (error) {
    return {
      account,
      ad,
      format,
      dedupe: {
        key: buildCreativeDedupeKey(account, ad),
        reusedFromAdId: null,
        reusedFromAdName: null
      },
      analysis: {
        format,
        risk: "error",
        issues: [
          {
            severity: "high",
            code: "preview_inspection_failed",
            message: error.message
          }
        ]
      },
      screenshotPath: undefined,
      screenshotUrl: undefined
    };
  }
}

function printResult(result) {
  const source = result.geminiValidation ? ` (${result.geminiValidation.provider})` : "";
  const issues = result.analysis.issues.length
    ? result.analysis.issues.map((issue) => `    - ${issue.severity}: ${issue.message}`).join("\n")
    : "    - no issues";

  const geminiSummary = result.geminiValidation?.parsed
    ? [
        `  validator: ${result.geminiValidation.model}`,
        `  status: ${result.geminiValidation.parsed.status}`,
        `  adjustment_required: ${result.geminiValidation.parsed.adjustmentRequired}`,
        `  rationale: ${result.geminiValidation.parsed.rationale}`
      ]
    : result.geminiValidation?.error
      ? [
          `  validator: ${result.geminiValidation.model}`,
          `  gemini_error: ${result.geminiValidation.error}`
        ]
    : [];
  const dedupeSummary = result.dedupe?.reusedFromAdId
    ? [
        `  dedupe_key: ${result.dedupe.key}`,
        `  reused_from: ${result.dedupe.reusedFromAdName || result.dedupe.reusedFromAdId}`
      ]
    : [];

  console.log(
    [
      "",
      `[${result.analysis.risk.toUpperCase()}]${source} ${result.ad.name}`,
      `  account: ${result.account?.name || result.account?.id || "-"}`,
      `  placement: ${result.format}`,
      `  screenshot: ${result.screenshotPath}`,
      ...dedupeSummary,
      ...geminiSummary,
      "  issues:",
      issues
    ].join("\n")
  );
}

async function processAd({ ad, account, config, isDemo, dedupeCache, placementCache }) {
  const adStartTime = Date.now();
  const dedupeKey = buildCreativeDedupeKey(account, ad);
  const fingerprint = buildPlacementFingerprint(ad, config.formats);
  const cachedResults = placementCache?.get(ad, fingerprint, config.formats);

  if (cachedResults) {
    return {
      ad,
      placementResults: cachedResults.map((result) =>
        cloneCachedPlacementResult(result, {
          ad,
          account,
          dedupeKey
        })
      ),
      reusedFromAdId: null,
      reusedFromAdName: null,
      cacheHit: true,
      adElapsed: ((Date.now() - adStartTime) / 1000).toFixed(1)
    };
  }

  if (!dedupeKey) {
    const placementResults = await inspectAdPlacements({ ad, account, config, isDemo });
    await placementCache?.save(ad, fingerprint, config.formats, placementResults);
    return {
      ad,
      placementResults,
      reusedFromAdId: null,
      reusedFromAdName: null,
      cacheHit: false,
      adElapsed: ((Date.now() - adStartTime) / 1000).toFixed(1)
    };
  }

  const cachedPromise = dedupeCache.get(dedupeKey);
  if (cachedPromise) {
    const cached = await cachedPromise;
    const placementResults = cached.results.map((result) =>
      cloneDedupedResult(result, {
        ad,
        dedupeKey,
        reusedFromAdId: cached.sourceAd.id,
        reusedFromAdName: cached.sourceAd.name
      })
    );
    await placementCache?.save(ad, fingerprint, config.formats, placementResults);
    return {
      ad,
      placementResults,
      reusedFromAdId: cached.sourceAd.id,
      reusedFromAdName: cached.sourceAd.name,
      cacheHit: false,
      adElapsed: ((Date.now() - adStartTime) / 1000).toFixed(1)
    };
  }

  const computePromise = (async () => {
    const placementResults = await inspectAdPlacements({ ad, account, config, isDemo });
    return {
      sourceAd: {
        id: ad.id,
        name: ad.name
      },
      results: placementResults.map((result) =>
        cloneDedupedResult(result, {
          ad,
          dedupeKey,
          reusedFromAdId: null,
          reusedFromAdName: null
        })
      )
    };
  })();

  dedupeCache.set(dedupeKey, computePromise);

  try {
    const cached = await computePromise;
    const placementResults = cached.results.map((result) =>
      cloneDedupedResult(result, {
        ad,
        dedupeKey,
        reusedFromAdId: null,
        reusedFromAdName: null
      })
    );
    await placementCache?.save(ad, fingerprint, config.formats, placementResults);
    return {
      ad,
      placementResults,
      reusedFromAdId: null,
      reusedFromAdName: null,
      cacheHit: false,
      adElapsed: ((Date.now() - adStartTime) / 1000).toFixed(1)
    };
  } catch (error) {
    dedupeCache.delete(dedupeKey);
    throw error;
  }
}

async function inspectAdPlacements({ ad, account, config, isDemo }) {
  return mapWithConcurrency(config.formats, config.placementConcurrency, async (format) =>
    inspectPreview({ ad, format, config, isDemo, account })
  );
}

async function trySendAccountAlert(destinations, account, results) {
  try {
    return await sendSlackAccountAlert(destinations, account, results);
  } catch (error) {
    return { error: error.message };
  }
}

async function tryGeminiValidation({ config, screenshotPath, imageBuffer, format, creativeObjectType }) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await validateScreenshotWithGemini({
        config,
        screenshotPath,
        imageBuffer,
        format,
        creativeObjectType
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
      }
    }
  }

  return {
    provider: "gemini",
    model: config.geminiModel,
    error: lastError?.message || "Gemini validation failed after retries."
  };
}

async function tryUploadScreenshot(config, fileName, buffer) {
  if (!config.supabaseUrl || !config.supabaseServiceKey || !config.supabaseStorageBucket) {
    console.warn(
      "Screenshot upload skipped: missing SUPABASE_URL, SUPABASE_SERVICE_KEY, or SUPABASE_STORAGE_BUCKET"
    );
    return null;
  }
  try {
    return await uploadScreenshotToSupabase({
      supabaseUrl: config.supabaseUrl,
      serviceKey: config.supabaseServiceKey,
      bucket: config.supabaseStorageBucket,
      prefix: config.supabaseStoragePrefix,
      fileName,
      buffer
    });
  } catch (error) {
    console.warn(`Screenshot upload failed for ${fileName}: ${error.message}`);
    return { error: error.message };
  }
}

function shouldPersistScreenshot(analysis) {
  return ["high", "medium"].includes(analysis.risk);
}

function buildScreenshotUrl(baseUrl, fileName) {
  if (!baseUrl) return undefined;
  return new URL(`screenshots/${fileName}`, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function logProgress(message) {
  if (asJson) {
    console.error(message);
    return;
  }
  console.log(message);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildCreativeDedupeKey(account, ad) {
  const accountId = account?.id || "unknown-account";

  if (ad?.creativeEffectiveObjectStoryId) {
    return `${accountId}:story:${ad.creativeEffectiveObjectStoryId}`;
  }

  if (ad?.creativeImageHash) {
    return `${accountId}:image:${ad.creativeImageHash}`;
  }

  if (ad?.creativeInstagramPermalinkUrl) {
    return `${accountId}:ig:${ad.creativeInstagramPermalinkUrl}`;
  }

  if (ad?.creativeThumbnailUrl) {
    return `${accountId}:thumb:${normalizeAssetUrl(ad.creativeThumbnailUrl)}`;
  }

  if (!ad?.creativeId) return "";
  return `${accountId}:creative:${ad.creativeId}`;
}

function normalizeAssetUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function cloneDedupedResult(result, { ad, dedupeKey, reusedFromAdId, reusedFromAdName }) {
  return {
    ...result,
    ad,
    dedupe: {
      key: dedupeKey,
      reusedFromAdId,
      reusedFromAdName
    }
  };
}

function cloneCachedPlacementResult(result, { ad, account, dedupeKey }) {
  return {
    ...result,
    account,
    ad,
    dedupe: {
      ...(result.dedupe || {}),
      key: dedupeKey,
      reusedFromAdId: result.dedupe?.reusedFromAdId || null,
      reusedFromAdName: result.dedupe?.reusedFromAdName || null,
      cacheHit: true
    }
  };
}

function formatDuration(secondsValue) {
  const seconds = Number(secondsValue) || 0;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  return `${hours}h ${remainingMinutes}m`;
}

main().then(() => {
  if (loadConfig().forceExitOnComplete) {
    setImmediate(() => process.exit(process.exitCode || 0));
  }
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
