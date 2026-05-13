import "dotenv/config";

const GRAPH_BASE = "https://graph.facebook.com";
const accessToken = process.env.META_ACCESS_TOKEN;
const apiVersion = process.env.META_API_VERSION || "v25.0";
const timeoutMs = 30000;

if (!accessToken) {
  throw new Error("Missing META_ACCESS_TOKEN");
}

const [, , csvUrl, ...clientNames] = process.argv;

if (!csvUrl || !clientNames.length) {
  throw new Error(
    "Usage: node src/resolve-client-targets.js <csv-url> <client-name> [client-name...]"
  );
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

async function fetchAccessibleAdAccounts() {
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

async function fetchActiveClients() {
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
  const publicChannelIdIndex = column("Slack Public Channel ID");

  if (clientIndex === -1 || statusIndex === -1) {
    throw new Error('Active clients CSV is missing "Client ID" or "Status" columns.');
  }

  return rows
    .slice(1)
    .filter((row) => `${row[statusIndex] || ""}`.trim() === "Active")
    .map((row) => ({
      clientName: `${row[clientIndex] || ""}`.trim(),
      slackPublicChannelId: `${row[publicChannelIdIndex] || ""}`.trim()
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

async function main() {
  const [accounts, activeClients] = await Promise.all([
    fetchAccessibleAdAccounts(),
    fetchActiveClients()
  ]);

  const targets = clientNames.map((requestedName) => {
    const client = activeClients.find((entry) => namesMatch(entry.clientName, requestedName));
    const account = client
      ? accounts.find((entry) => namesMatch(entry.name, client.clientName))
      : accounts.find((entry) => namesMatch(entry.name, requestedName));

    return {
      requestedName,
      clientName: client?.clientName || "",
      slackPublicChannelId: client?.slackPublicChannelId || "",
      accountId: account?.id || "",
      accountName: account?.name || "",
      matched: Boolean(client && account)
    };
  });

  console.log(JSON.stringify(targets, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
