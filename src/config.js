import "dotenv/config";
import path from "node:path";
import { parseFormats } from "./formats.js";

export function loadConfig() {
  return {
    metaAccessToken: process.env.META_ACCESS_TOKEN,
    metaAdAccountId: normalizeAdAccountId(process.env.META_AD_ACCOUNT_ID),
    metaAdAccountIds: parseAccountIds(process.env.META_AD_ACCOUNT_IDS),
    newAdIds: parseIdList(process.env.NEW_AD_IDS || process.env.NEW_AD_ID),
    metaApiVersion: process.env.META_API_VERSION || "v25.0",
    activeClientsCsvUrl: process.env.ACTIVE_CLIENTS_CSV_URL,
    adAccountLimit: parseOptionalInteger(process.env.AD_ACCOUNT_LIMIT),
    geminiAuthMode: process.env.GEMINI_AUTH_MODE || "adc",
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
    formats: parseFormats(process.env.AD_FORMATS),
    minSpend: Number.parseFloat(process.env.MIN_SPEND || "0.01"),
    spendDatePreset: parseOptionalString(process.env.SPEND_DATE_PRESET),
    queryActiveOnly: parseBooleanFlag(process.env.QUERY_ACTIVE_ONLY, true),
    enforceActiveDelivery: parseBooleanFlag(process.env.ENFORCE_ACTIVE_DELIVERY, true),
    adLimit: parseAdLimit(process.env.AD_LIMIT),
    metaTimeoutMs: parseInteger(process.env.META_TIMEOUT_MS, 30000),
    renderTimeoutMs: parseInteger(process.env.RENDER_TIMEOUT_MS, 90000),
    geminiTimeoutMs: parseInteger(process.env.GEMINI_TIMEOUT_MS, 60000),
    previewDelayMs: parseInteger(process.env.PREVIEW_DELAY_MS, 0),
    accountDelayMs: parseInteger(process.env.ACCOUNT_DELAY_MS, 1000),
    previewWaitMs: parseInteger(process.env.PREVIEW_WAIT_MS, 5000),
    previewRetries: parseInteger(process.env.PREVIEW_RETRIES, 2),
    placementConcurrency: Math.max(1, parseInteger(process.env.PLACEMENT_CONCURRENCY, 2)),
    adConcurrency: Math.max(1, parseInteger(process.env.AD_CONCURRENCY, 1)),
    placementCacheVersion: process.env.PLACEMENT_CACHE_VERSION || "1",
    placementCacheTtlHours: parseInteger(process.env.PLACEMENT_CACHE_TTL_HOURS, 168),
    forceExitOnComplete: process.env.FORCE_EXIT_ON_COMPLETE !== "0",
    disableRunLock: process.env.DISABLE_RUN_LOCK === "1",
    slackBotToken: process.env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_OAUTH,
    slackOverrideChannelId: process.env.SLACK_OVERRIDE_CHANNEL_ID,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    screenshotBaseUrl: process.env.SCREENSHOT_BASE_URL,
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    supabaseServiceKey:
      process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_SERVICE_KEY,
    supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || "ads-placement",
    supabaseStoragePrefix: process.env.SUPABASE_STORAGE_PREFIX || "ad-preview-checker",
    outputDir: path.resolve(process.env.OUTPUT_DIR || "output")
  };
}

function normalizeAdAccountId(value) {
  if (!value) return undefined;
  return value.startsWith("act_") ? value : `act_${value}`;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalInteger(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAdLimit(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "none" || normalized === "0") {
    return undefined;
  }

  return parseOptionalInteger(normalized);
}

function parseOptionalString(value) {
  const normalized = `${value || ""}`.trim();
  return normalized ? normalized : undefined;
}

function parseBooleanFlag(value, fallback) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseAccountIds(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => normalizeAdAccountId(entry.trim()))
    .filter(Boolean);
}

function parseIdList(value) {
  if (!value) return [];
  return [
    ...new Set(
      String(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ];
}
