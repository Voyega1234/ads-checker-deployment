import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || "output/unified-alert-preview-movefast-6placements.json";
  const out = args.out || input.replace(/\.json$/i, ".html");
  const alert = JSON.parse(await fs.readFile(input, "utf8"));
  const report = normalizeAlert(alert);

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, renderHtml(report), "utf8");
  console.log(JSON.stringify({ out, groups: report.groups.length, client: report.meta.clientName }, null, 2));
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

function normalizeAlert(alert) {
  const groups = (alert.threadMessages || []).map((message, index) => normalizeThreadMessage(message, index));
  return {
    meta: alert.meta || {},
    groups
  };
}

function normalizeThreadMessage(message, index) {
  const blocks = message.blocks || [];
  const headerText = blocks[0]?.text?.text || "";
  const [titleLine = "", adIdLine = ""] = headerText.split("\n");
  const titleMatch = titleLine.match(/^\*(.+)\*\s+·\s+(\d+)\s+ads?/);
  const creativeName = titleMatch?.[1] || titleLine.replace(/\*/g, "") || `Issue group ${index + 1}`;
  const usedInAds = Number(titleMatch?.[2] || 0);
  const adIds = Array.from(adIdLine.matchAll(/`([^`]+)`/g)).map((match) => match[1]);

  const statusText = blocks.find((block) => block.text?.text?.includes("*Policy:*"))?.text?.text || "";
  const status = parseStatus(statusText);
  const placementIssues = parsePlacementIssues(blocks);
  const revisedText = parseRevisedText(blocks);
  const screenshots = blocks
    .filter((block) => block.type === "image" && block.image_url)
    .map((block) => ({
      url: block.image_url,
      title: block.title?.text || "Ad placement preview"
    }));
  const context = blocks.find((block) => block.type === "context")?.elements?.[0]?.text || "";

  return {
    key: message.key || `${index}`,
    creativeName,
    usedInAds,
    adIds,
    status,
    placementIssues,
    revisedText,
    screenshots: dedupeScreenshots(screenshots),
    context
  };
}

function parseStatus(text) {
  const clean = text.replace(/\*/g, "");
  return {
    policy: matchLabel(clean, "Policy"),
    spelling: matchLabel(clean, "Spelling"),
    placement: matchLabel(clean, "Placement"),
    image: matchLabel(clean, "Image")
  };
}

function matchLabel(text, label) {
  const pattern = new RegExp(`${label}:\\s*([^\\n·]+(?:\\([^)]*\\))?)`);
  return (text.match(pattern)?.[1] || "N/A").trim();
}

function parsePlacementIssues(blocks) {
  const block = blocks.find((item) => item.text?.text?.startsWith("*Placement issues*"));
  if (!block) return [];
  return block.text.text
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean)
    .map((line) => line.replace(/`/g, ""));
}

function parseRevisedText(blocks) {
  const block = blocks.find((item) => item.text?.text?.startsWith("*Revised text*"));
  if (!block) return "N/A";
  const match = block.text.text.match(/```([\s\S]*)```/);
  return (match?.[1] || "N/A").trim();
}

function dedupeScreenshots(screenshots) {
  const seen = new Set();
  const out = [];
  for (const item of screenshots) {
    const key = `${item.url}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function renderHtml(report) {
  const { meta, groups } = report;
  const date = formatDate(meta.generatedAt);
  const groupCards = groups.map(renderGroupCard).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(meta.clientName || "Ad Compliance Report")}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --panel: #ffffff;
      --text: #172026;
      --muted: #63707a;
      --line: #d7dee4;
      --danger: #c62828;
      --warn: #9a6500;
      --ok: #2e7d32;
      --code: #eef2f5;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    header {
      background: #101820;
      color: #fff;
      padding: 28px 24px;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 18px; letter-spacing: 0; }
    .subhead { color: #c8d1d9; margin: 0; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .metric {
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 8px;
      padding: 12px;
    }
    .metric b { display: block; font-size: 13px; color: #c8d1d9; margin-bottom: 4px; }
    .metric span { font-size: 18px; font-weight: 700; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-bottom: 18px;
    }
    input[type="search"] {
      flex: 1 1 280px;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      font: inherit;
      background: #fff;
    }
    .filter {
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
    }
    .group {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .group-head {
      padding: 16px;
      border-bottom: 1px solid var(--line);
    }
    .creative {
      font-size: 18px;
      font-weight: 750;
      margin: 0 0 10px;
    }
    .ids {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    code {
      background: var(--code);
      border: 1px solid #d9e1e7;
      border-radius: 6px;
      padding: 2px 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      color: #8a4f00;
    }
    .status {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }
    .status-item b { display: block; font-size: 13px; margin-bottom: 2px; }
    .fail { color: var(--danger); font-weight: 700; }
    .na { color: var(--muted); }
    .body {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr);
      gap: 18px;
      padding: 16px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: #101820;
      color: #f4f7fa;
      border-radius: 8px;
      padding: 14px;
      max-height: 420px;
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .issues {
      margin: 0 0 14px;
      padding-left: 18px;
      color: var(--muted);
    }
    .shots {
      display: grid;
      gap: 12px;
    }
    .shot img {
      width: 100%;
      max-height: 520px;
      object-fit: contain;
      background: #e8edf1;
      border: 1px solid var(--line);
      border-radius: 8px;
      display: block;
    }
    .shot-title {
      color: var(--muted);
      font-size: 13px;
      margin: 6px 0 0;
    }
    .context {
      padding: 0 16px 16px;
      color: var(--muted);
      font-size: 13px;
    }
    .empty { color: var(--muted); padding: 24px; text-align: center; display: none; }
    @media (max-width: 860px) {
      .summary, .status, .body { grid-template-columns: 1fr; }
      header, main { padding-left: 16px; padding-right: 16px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Ad Compliance Alert</h1>
    <p class="subhead">${escapeHtml(meta.clientName || meta.accountName || "Unknown client")} · <code>${escapeHtml(meta.accountId || "")}</code> · ${escapeHtml(date)}</p>
    <section class="summary" aria-label="Summary">
      <div class="metric"><b>Affected ads</b><span>${meta.adCount || 0} ads · ${meta.creativeCount || 0} creatives</span></div>
      <div class="metric"><b>Policy</b><span>${meta.policyCreativeCount || 0} creatives</span></div>
      <div class="metric"><b>Spelling</b><span>${meta.spellingCreativeCount || 0} creatives</span></div>
      <div class="metric"><b>Placement</b><span>${meta.placementAdCount || 0} ads</span></div>
    </section>
  </header>
  <main>
    <section class="toolbar" aria-label="Controls">
      <input id="search" type="search" placeholder="Search creative name, ad id, finding, revised text">
      <label class="filter"><input type="checkbox" data-filter="policy"> Policy</label>
      <label class="filter"><input type="checkbox" data-filter="spelling"> Spelling</label>
      <label class="filter"><input type="checkbox" data-filter="placement"> Placement</label>
      <label class="filter"><input type="checkbox" data-filter="screenshot"> Screenshot</label>
    </section>
    <section id="groups">${groupCards}</section>
    <div id="empty" class="empty">No issue groups match the current filters.</div>
  </main>
  <script>
    const search = document.querySelector("#search");
    const filters = Array.from(document.querySelectorAll("[data-filter]"));
    const cards = Array.from(document.querySelectorAll(".group"));
    const empty = document.querySelector("#empty");
    function applyFilters() {
      const q = search.value.trim().toLowerCase();
      const active = filters.filter((item) => item.checked).map((item) => item.dataset.filter);
      let visible = 0;
      for (const card of cards) {
        const textOk = !q || card.dataset.search.includes(q);
        const filterOk = active.length === 0 || active.some((name) => card.dataset[name] === "true");
        const show = textOk && filterOk;
        card.style.display = show ? "" : "none";
        if (show) visible += 1;
      }
      empty.style.display = visible ? "none" : "block";
    }
    search.addEventListener("input", applyFilters);
    filters.forEach((item) => item.addEventListener("change", applyFilters));
  </script>
</body>
</html>`;
}

function renderGroupCard(group) {
  const hasPolicy = isFail(group.status.policy);
  const hasSpelling = isFail(group.status.spelling);
  const hasPlacement = isFail(group.status.placement);
  const hasScreenshot = group.screenshots.length > 0;
  const search = [
    group.creativeName,
    group.adIds.join(" "),
    Object.values(group.status).join(" "),
    group.placementIssues.join(" "),
    group.revisedText,
    group.context
  ].join(" ").toLowerCase();

  return `<article class="group"
    data-policy="${hasPolicy}"
    data-spelling="${hasSpelling}"
    data-placement="${hasPlacement}"
    data-screenshot="${hasScreenshot}"
    data-search="${escapeAttr(search)}">
    <div class="group-head">
      <p class="creative">${escapeHtml(group.creativeName)} · ${group.usedInAds || group.adIds.length} ad${(group.usedInAds || group.adIds.length) === 1 ? "" : "s"}</p>
      <div class="ids">${group.adIds.map((id) => `<code>${escapeHtml(id)}</code>`).join("")}</div>
    </div>
    <div class="status">
      ${renderStatusItem("Policy", group.status.policy)}
      ${renderStatusItem("Spelling", group.status.spelling)}
      ${renderStatusItem("Placement", group.status.placement)}
      ${renderStatusItem("Screenshot", hasScreenshot ? "⚠ Attached" : "N/A")}
    </div>
    <div class="body">
      <section>
        ${group.placementIssues.length ? `<h2>Placement issues</h2><ul class="issues">${group.placementIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : ""}
        <h2>Revised text</h2>
        <pre>${escapeHtml(group.revisedText || "N/A")}</pre>
      </section>
      <section class="shots">
        ${group.screenshots.length ? group.screenshots.map(renderScreenshot).join("") : `<p class="na">No screenshot attached.</p>`}
      </section>
    </div>
    ${group.context ? `<div class="context">${escapeHtml(group.context)}</div>` : ""}
  </article>`;
}

function renderStatusItem(label, value) {
  const className = isFail(value) || value.includes("⚠") ? "fail" : "na";
  return `<div class="status-item"><b>${escapeHtml(label)}</b><span class="${className}">${escapeHtml(value)}</span></div>`;
}

function renderScreenshot(item) {
  return `<figure class="shot">
    <img src="${escapeAttr(item.url)}" alt="Ad placement preview">
    <figcaption class="shot-title">${escapeHtml(item.title)}</figcaption>
  </figure>`;
}

function isFail(value) {
  return `${value || ""}`.includes("✕");
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok"
  }).format(date);
}

function escapeHtml(value) {
  return `${value || ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
