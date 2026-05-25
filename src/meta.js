const GRAPH_BASE = "https://graph.facebook.com";

const AD_FIELDS = [
  "id",
  "account_id",
  "name",
  "creative{id,name,effective_object_story_id,image_hash,image_url,thumbnail_url,object_type,instagram_permalink_url,asset_feed_spec}",
  "effective_status",
  "configured_status",
  "campaign{id,name,effective_status,configured_status}",
  "adset{id,name,effective_status,configured_status}"
];

export async function fetchRunnableAds(config, adAccount) {
  assertMetaConfig(config);

  if (config.newAdIds?.length) {
    return fetchAdsByIds(config, adAccount);
  }

  const insightsField = config.spendDatePreset
    ? `insights.date_preset(${config.spendDatePreset}){spend}`
    : "insights{spend}";

  const fields = [
    ...AD_FIELDS,
    insightsField
  ].join(",");

  const params = new URLSearchParams({
    access_token: config.metaAccessToken,
    fields,
    limit: String(config.adLimit ? Math.min(Math.max(config.adLimit, 1), 100) : 100)
  });

  if (config.queryActiveOnly) {
    params.set(
      "filtering",
      JSON.stringify([
        {
          field: "ad.effective_status",
          operator: "IN",
          value: ["ACTIVE"]
        }
      ])
    );
  }

  const ads = [];
  let url = `${GRAPH_BASE}/${config.metaApiVersion}/${adAccount.id}/ads?${params}`;

  while (url) {
    const payload = await graphFetch(url, { timeoutMs: config.metaTimeoutMs });
    ads.push(...(payload.data || []));
    if (config.adLimit != null && ads.length >= config.adLimit) break;
    url = payload.paging?.next;
  }

  const imageUrlsByHash = await resolveAdImageUrlsByHash(config, adAccount.id, ads);

  return ads
    .map((ad) => normalizeRunnableAd(ad, imageUrlsByHash))
    .filter((ad) => (config.enforceActiveDelivery ? isActiveDelivery(ad) : true))
    .filter((ad) => ad.spend >= config.minSpend)
    .slice(0, config.adLimit ?? Infinity);
}

async function fetchAdsByIds(config, adAccount) {
  const fields = AD_FIELDS.join(",");
  const accountNum = normalizeAccountNumber(adAccount.id);
  const fetched = await Promise.all(
    config.newAdIds.map(async (adId) => {
      const params = new URLSearchParams({
        access_token: config.metaAccessToken,
        fields
      });
      try {
        return await graphFetch(`${GRAPH_BASE}/${config.metaApiVersion}/${adId}?${params}`, {
          timeoutMs: config.metaTimeoutMs
        });
      } catch (error) {
        console.warn(`New ad direct fetch skipped for ${adId}: ${error.message}`);
        return null;
      }
    })
  );
  const ads = fetched.filter((ad) => ad && normalizeAccountNumber(ad.account_id) === accountNum);
  const imageUrlsByHash = await resolveAdImageUrlsByHash(config, adAccount.id, ads);
  return ads
    .map((ad) => normalizeRunnableAd(ad, imageUrlsByHash))
    .slice(0, config.adLimit ?? Infinity);
}

function normalizeRunnableAd(ad, imageUrlsByHash = new Map()) {
  const creative = ad.creative || {};
  const assetImage = firstAssetImage(creative);
  const creativeImageHash = creative.image_hash || assetImage.hash || "";
  const resolvedImageUrl = creativeImageHash ? imageUrlsByHash.get(creativeImageHash) : "";
  const creativeThumbnailUrl =
    creative.thumbnail_url ||
    creative.image_url ||
    assetImage.thumbnailUrl ||
    assetImage.url ||
    resolvedImageUrl ||
    "";

  return {
    id: ad.id,
    name: ad.name || ad.id,
    creativeId: creative.id || "",
    creativeName: creative.name || "",
    creativeEffectiveObjectStoryId: creative.effective_object_story_id || "",
    creativeImageHash,
    creativeThumbnailUrl,
    creativeObjectType: creative.object_type || "",
    creativeInstagramPermalinkUrl: creative.instagram_permalink_url || "",
    effectiveStatus: ad.effective_status || "",
    configuredStatus: ad.configured_status || "",
    campaignName: ad.campaign?.name || "",
    campaignEffectiveStatus: ad.campaign?.effective_status || "",
    campaignConfiguredStatus: ad.campaign?.configured_status || "",
    adsetName: ad.adset?.name || "",
    adsetEffectiveStatus: ad.adset?.effective_status || "",
    adsetConfiguredStatus: ad.adset?.configured_status || "",
    spend: Number.parseFloat(ad.insights?.data?.[0]?.spend || "0")
  };
}

function normalizeAccountNumber(value) {
  return `${value || ""}`.replace(/^act_/, "");
}

function firstAssetImage(creative) {
  const images = creative.asset_feed_spec?.images || [];
  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    const hash = image.hash || image.image_hash || "";
    const url = image.url || image.image_url || "";
    const thumbnailUrl = image.thumbnail_url || "";
    if (hash || url || thumbnailUrl) {
      return { hash, url, thumbnailUrl };
    }
  }
  return { hash: "", url: "", thumbnailUrl: "" };
}

async function resolveAdImageUrlsByHash(config, adAccountId, ads) {
  const hashes = [
    ...new Set(
      ads
        .flatMap((ad) => {
          const creative = ad.creative || {};
          return [
            creative.image_hash,
            ...(creative.asset_feed_spec?.images || []).map((image) => image?.hash || image?.image_hash)
          ];
        })
        .filter(Boolean)
    )
  ];

  if (!hashes.length) return new Map();

  const params = new URLSearchParams({
    access_token: config.metaAccessToken,
    fields: "hash,url,permalink_url,width,height,name",
    hashes: JSON.stringify(hashes)
  });

  try {
    const payload = await graphFetch(`${GRAPH_BASE}/${config.metaApiVersion}/${adAccountId}/adimages?${params}`, {
      timeoutMs: config.metaTimeoutMs
    });
    return new Map((payload.data || []).map((image) => [image.hash, image.url || image.permalink_url || ""]));
  } catch (error) {
    console.warn(`Ad image hash resolution skipped for ${adAccountId}: ${error.message}`);
    return new Map();
  }
}

export async function resolveSelectedAdAccounts(config) {
  assertMetaConfig(config);

  if (config.metaAdAccountIds.length) {
    const accounts = await fetchAccessibleAdAccounts(config);
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    return config.metaAdAccountIds.map((id) => accountById.get(id) || { id, name: id });
  }

  if (!config.activeClientsCsvUrl && config.metaAdAccountId) {
    const accounts = await fetchAccessibleAdAccounts(config);
    const matchedAccount = accounts.find((account) => account.id === config.metaAdAccountId);
    return [matchedAccount || { id: config.metaAdAccountId, name: config.metaAdAccountId }];
  }

  if (!config.activeClientsCsvUrl) {
    throw new Error(
      "Missing ad account selector. Set META_AD_ACCOUNT_ID, META_AD_ACCOUNT_IDS, or ACTIVE_CLIENTS_CSV_URL."
    );
  }

  const [accounts, activeClients] = await Promise.all([
    fetchAccessibleAdAccounts(config),
    fetchActiveClients(config.activeClientsCsvUrl)
  ]);

  const matched = accounts
    .map((account) => {
      const client = activeClients.find((entry) => namesMatch(account.name, entry.clientName));
      return client ? { ...account, client } : null;
    })
    .filter(Boolean);

  const limit = config.adAccountLimit ?? 10;
  return matched.slice(0, limit);
}

export async function fetchAdPreviewHtml(config, adId, adFormat) {
  assertMetaConfig(config);

  const params = new URLSearchParams({
    access_token: config.metaAccessToken,
    ad_format: adFormat
  });

  const url = `${GRAPH_BASE}/${config.metaApiVersion}/${adId}/previews?${params}`;
  const payload = await graphFetch(url, { timeoutMs: config.metaTimeoutMs });
  const body = payload.data?.[0]?.body;

  if (!body) {
    throw new Error(`No preview body returned for ad ${adId} (${adFormat})`);
  }

  return body;
}

async function graphFetch(url, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: fetchOptions.signal || controller?.signal
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload.error?.message || response.statusText;
      throw new Error(`Meta API error ${response.status}: ${message}`);
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Meta API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertMetaConfig(config) {
  const missing = [];
  if (!config.metaAccessToken) missing.push("META_ACCESS_TOKEN");
  if (!config.metaAdAccountId && !config.metaAdAccountIds.length && !config.activeClientsCsvUrl) {
    missing.push("META_AD_ACCOUNT_ID or META_AD_ACCOUNT_IDS or ACTIVE_CLIENTS_CSV_URL");
  }

  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

function isActiveDelivery(ad) {
  return (
    ad.effectiveStatus === "ACTIVE" &&
    (!ad.campaignEffectiveStatus || ad.campaignEffectiveStatus === "ACTIVE") &&
    (!ad.adsetEffectiveStatus || ad.adsetEffectiveStatus === "ACTIVE") &&
    (!ad.configuredStatus || ad.configuredStatus === "ACTIVE") &&
    (!ad.campaignConfiguredStatus || ad.campaignConfiguredStatus === "ACTIVE") &&
    (!ad.adsetConfiguredStatus || ad.adsetConfiguredStatus === "ACTIVE")
  );
}

async function fetchAccessibleAdAccounts(config) {
  const params = new URLSearchParams({
    access_token: config.metaAccessToken,
    fields: "id,name,account_status",
    limit: "500"
  });

  let url = `${GRAPH_BASE}/${config.metaApiVersion}/me/adaccounts?${params}`;
  const accounts = [];

  while (url) {
    const payload = await graphFetch(url, { timeoutMs: config.metaTimeoutMs });
    accounts.push(...(payload.data || []));
    url = payload.paging?.next;
  }

  return accounts
    .filter((account) => account.account_status === 1)
    .map((account) => ({ id: account.id, name: account.name || account.id }));
}

async function fetchActiveClients(csvUrl) {
  const response = await fetch(csvUrl);
  if (!response.ok) {
    throw new Error(`Active clients CSV fetch failed: ${response.status} ${response.statusText}`);
  }

  const csv = await response.text();
  const rows = parseCsv(csv);
  if (!rows.length) return [];

  const header = rows[0];
  const column = (name) => header.indexOf(name);
  const clientIndex = column("Client ID");
  const statusIndex = column("Status");
  const publicChannelIndex = column("Slack Public Channel");
  const publicChannelIdIndex = column("Slack Public Channel ID");
  const creativeChannelIndex = column("Slack Creative Channel");
  const creativeChannelIdIndex = column("Slack Creative Channel ID");

  if (clientIndex === -1 || statusIndex === -1) {
    throw new Error('Active clients CSV is missing "Client ID" or "Status" columns.');
  }

  return rows
    .slice(1)
    .filter((row) => `${row[statusIndex] || ""}`.trim() === "Active")
    .map((row) => ({
      clientName: `${row[clientIndex] || ""}`.trim(),
      slackPublicChannel: `${row[publicChannelIndex] || ""}`.trim(),
      slackPublicChannelId: `${row[publicChannelIdIndex] || ""}`.trim(),
      slackCreativeChannel: `${row[creativeChannelIndex] || ""}`.trim(),
      slackCreativeChannelId: `${row[creativeChannelIdIndex] || ""}`.trim()
    }))
    .filter((entry) => entry.clientName);
}

function namesMatch(accountName, clientName) {
  const account = normalizeName(accountName);
  const client = normalizeName(clientName);
  return account === client || account.includes(client) || client.includes(account);
}

function normalizeName(value) {
  return `${value || ""}`
    .toLowerCase()
    .replace(/\(cc\)/g, "")
    .replace(/ads?/g, "")
    .replace(/clinic/g, "clinic")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.length)) rows.push(row);
  return rows;
}
