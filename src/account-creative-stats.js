import "dotenv/config";
import { parseFormats } from "./formats.js";

const GRAPH_BASE = "https://graph.facebook.com";
const accessToken = process.env.META_ACCESS_TOKEN;
const apiVersion = process.env.META_API_VERSION || "v25.0";
const minSpend = Number.parseFloat(process.env.MIN_SPEND || "0.01");
const spendDatePreset = process.env.SPEND_DATE_PRESET || "today";
const timeoutMs = 30000;

if (!accessToken) {
  throw new Error("Missing META_ACCESS_TOKEN");
}

async function graphFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || response.statusText);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
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

async function fetchAccounts() {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: "id,name,account_status",
    limit: "500"
  });

  let url = `${GRAPH_BASE}/${apiVersion}/me/adaccounts?${params}`;
  const accounts = [];

  while (url) {
    const payload = await graphFetch(url);
    accounts.push(...(payload.data || []));
    url = payload.paging?.next;
  }

  return accounts
    .filter((account) => account.account_status === 1)
    .map((account) => ({ id: account.id, name: account.name || account.id }));
}

async function fetchRunnableCount(account) {
  const fields = [
    "id",
    "creative{id}",
    "effective_status",
    "configured_status",
    "campaign{id,effective_status,configured_status}",
    "adset{id,effective_status,configured_status}",
    `insights.date_preset(${spendDatePreset}){spend}`
  ].join(",");

  const params = new URLSearchParams({
    access_token: accessToken,
    fields,
    limit: "100",
    filtering: JSON.stringify([
      {
        field: "ad.effective_status",
        operator: "IN",
        value: ["ACTIVE"]
      }
    ])
  });

  let url = `${GRAPH_BASE}/${apiVersion}/${account.id}/ads?${params}`;
  let count = 0;

  while (url) {
    const payload = await graphFetch(url);

    for (const ad of payload.data || []) {
      const mapped = {
        effectiveStatus: ad.effective_status || "",
        configuredStatus: ad.configured_status || "",
        campaignEffectiveStatus: ad.campaign?.effective_status || "",
        campaignConfiguredStatus: ad.campaign?.configured_status || "",
        adsetEffectiveStatus: ad.adset?.effective_status || "",
        adsetConfiguredStatus: ad.adset?.configured_status || "",
        spend: Number.parseFloat(ad.insights?.data?.[0]?.spend || "0")
      };

      if (isActiveDelivery(mapped) && mapped.spend >= minSpend) {
        count += 1;
      }
    }

    url = payload.paging?.next;
  }

  return count;
}

async function main() {
  const accounts = await fetchAccounts();
  const results = new Array(accounts.length);
  const concurrency = 3;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= accounts.length) return;

      const account = accounts[currentIndex];

      try {
        const count = await fetchRunnableCount(account);
        results[currentIndex] = { ...account, count };
      } catch (error) {
        results[currentIndex] = { ...account, count: null, error: error.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length || 1) }, () => worker()));

  const counted = results.filter(Boolean).filter((entry) => entry.count != null);
  const accountsWithAds = counted.filter((entry) => entry.count > 0);
  const totalCreatives = accountsWithAds.reduce((sum, entry) => sum + entry.count, 0);
  const avgCreativesPerAccount = accountsWithAds.length
    ? totalCreatives / accountsWithAds.length
    : 0;
  const placementsPerCreative = parseFormats(process.env.AD_FORMATS).length;

  console.log(
    JSON.stringify(
      {
        accountsAccessible: accounts.length,
        accountsCounted: counted.length,
        accountsWithAds: accountsWithAds.length,
        totalCreatives,
        avgCreativesPerAccount: Number(avgCreativesPerAccount.toFixed(2)),
        placementsPerCreative,
        totalPlacementChecks: totalCreatives * placementsPerCreative
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
