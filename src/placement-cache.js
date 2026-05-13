import crypto from "node:crypto";

export async function loadPlacementCache(config, accountId) {
  if (!hasSupabase(config)) return createPlacementCache(null);
  const accountNumericId = normalizeAccountNumber(accountId);
  if (!accountNumericId) return createPlacementCache(null);

  const query = new URL(`${trimTrailingSlash(config.supabaseUrl)}/rest/v1/meta_ad_check_db`);
  query.searchParams.set("select", "ad_id,creative_id,ad_media_check_status,ad_media_assessment_result");
  query.searchParams.set("ad_account_id", `eq.${accountNumericId}`);

  try {
    const rows = await fetchSupabaseJson(config, query, "placement cache rows");
    const map = new Map();
    for (const row of rows || []) {
      const key = buildCacheKey(row.ad_id, row.creative_id);
      if (key) map.set(key, row);
    }
    return createPlacementCache({ config, accountNumericId, map });
  } catch (error) {
    console.warn(`Placement cache disabled: ${error.message}`);
    return createPlacementCache(null);
  }
}

export function buildPlacementFingerprint(ad, formats) {
  const payload = {
    creativeId: ad.creativeId || "",
    storyId: ad.creativeEffectiveObjectStoryId || "",
    imageHash: ad.creativeImageHash || "",
    thumbnailUrl: ad.creativeThumbnailUrl || "",
    objectType: ad.creativeObjectType || "",
    instagramPermalinkUrl: ad.creativeInstagramPermalinkUrl || "",
    formats: [...formats].sort()
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function createPlacementCache(state) {
  return {
    enabled: Boolean(state),
    get(ad, fingerprint, formats) {
      if (!state) return null;
      const row = state.map.get(buildCacheKey(ad.id, ad.creativeId));
      const cached = row?.ad_media_assessment_result;
      if (!cached || cached.fingerprint !== fingerprint) return null;
      if (!hasSameFormats(cached.formats, formats)) return null;
      if (!Array.isArray(cached.results) || !cached.results.length) return null;
      return cached.results;
    },
    async save(ad, fingerprint, formats, results) {
      if (!state) return;
      const key = buildCacheKey(ad.id, ad.creativeId);
      if (!key || !state.map.has(key)) return;

      const payload = {
        fingerprint,
        formats: [...formats],
        cached_at: new Date().toISOString(),
        results: results.map(stripResultForCache)
      };
      const status = results.some((result) => result.analysis?.risk === "error")
        ? "error"
        : results.some((result) => result.analysis?.risk && result.analysis.risk !== "ok")
          ? "rejected"
          : "verified";

      const patchUrl = new URL(`${trimTrailingSlash(state.config.supabaseUrl)}/rest/v1/meta_ad_check_db`);
      patchUrl.searchParams.set("ad_account_id", `eq.${state.accountNumericId}`);
      patchUrl.searchParams.set("ad_id", `eq.${ad.id}`);
      patchUrl.searchParams.set("creative_id", `eq.${ad.creativeId || ""}`);

      try {
        await fetchSupabaseJson(
          state.config,
          patchUrl,
          "placement cache update",
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              ad_media_check_status: status,
              ad_media_assessment_result: payload
            })
          }
        );
        state.map.set(key, {
          ad_id: ad.id,
          creative_id: ad.creativeId || "",
          ad_media_check_status: status,
          ad_media_assessment_result: payload
        });
      } catch (error) {
        console.warn(`Placement cache save skipped for ad ${ad.id}: ${error.message}`);
      }
    }
  };
}

function stripResultForCache(result) {
  return {
    format: result.format,
    dedupe: result.dedupe,
    screenshotPath: result.screenshotPath,
    screenshotUrl: result.screenshotUrl,
    analysis: result.analysis,
    geminiValidation: result.geminiValidation
  };
}

function hasSameFormats(left = [], right = []) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function buildCacheKey(adId, creativeId) {
  const ad = `${adId || ""}`.trim();
  const creative = `${creativeId || ""}`.trim();
  return ad && creative ? `${ad}:${creative}` : "";
}

function normalizeAccountNumber(accountId) {
  return `${accountId || ""}`.replace(/^act_/, "").trim();
}

function hasSupabase(config) {
  return Boolean(config.supabaseUrl && config.supabaseServiceKey);
}

async function fetchSupabaseJson(config, url, label, options = {}) {
  const headers = {
    apikey: config.supabaseServiceKey,
    authorization: `Bearer ${config.supabaseServiceKey}`,
    ...(options.headers || {})
  };
  if (options.body) headers["content-type"] = "application/json";

  const response = await fetch(url, {
    ...options,
    headers
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message || payload?.error || response.statusText;
    throw new Error(`${label} failed: ${response.status} ${message}`);
  }
  return payload;
}

function trimTrailingSlash(value) {
  return `${value || ""}`.replace(/\/+$/, "");
}
