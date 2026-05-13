import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { getViewportForFormat } from "./formats.js";

let sharedBrowserPromise;
let sharedBrowser;

export async function renderPreviewScreenshot({
  html,
  adId,
  adName,
  format,
  waitMs = 5000,
  retries = 2,
  timeoutMs = 90000
}) {
  const safeAdName = slugify(adName || adId);
  const fileName = `${safeAdName}-${adId}-${format}.png`;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1000, deadline - Date.now());

  const browser = await getSharedBrowser(Math.min(30000, remaining()));
  let page;

  try {
    const viewport = getViewportForFormat(format);
    page = await browser.newPage({
      viewport,
      deviceScaleFactor: 1,
      isMobile: true
    });

    const consoleMessages = [];
    page.on("console", (message) => {
      consoleMessages.push(`${message.type()}: ${message.text()}`.slice(0, 500));
    });

    await page.setContent(wrapPreviewHtml(html), {
      waitUntil: "domcontentloaded",
      timeout: Math.min(30000, remaining())
    });

    await waitForPreviewContent(page, waitMs, remaining);

    const text = await page.locator("body").innerText().catch(() => "");

    let rawBuffer;
    let quality = { isFlatDark: false };

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      rawBuffer = await page.screenshot({
        fullPage: false,
        timeout: Math.min(30000, remaining())
      });

      quality = estimateScreenshotQuality(rawBuffer);
      if (!quality.isFlatDark) break;
      const retryWaitMs = Math.min(waitMs, 1000 * (attempt + 1), remaining());
      if (retryWaitMs > 0) {
        await page.waitForTimeout(retryWaitMs);
      }
    }

    const crop = cropSignificantContent(rawBuffer);

    return {
      screenshotFileName: fileName,
      buffer: crop.buffer,
      pageText: text,
      viewport,
      debug: {
        frameCount: page.frames().length,
        frameUrls: page.frames().map((frame) => frame.url()).filter(Boolean),
        consoleMessages: consoleMessages.slice(-20),
        screenshotQuality: quality,
        crop: crop.debug
      }
    };
  } finally {
    if (page) {
      await page.close({ runBeforeUnload: false }).catch(() => {});
    }
  }
}

export async function closePreviewRenderer() {
  const browser = sharedBrowserPromise ? await sharedBrowserPromise.catch(() => null) : null;
  sharedBrowserPromise = undefined;
  sharedBrowser = undefined;

  if (browser) {
    await closeBrowser(browser);
  }
}

export async function saveRenderedScreenshot({ outputDir, fileName, buffer }) {
  const screenshotsDir = path.join(outputDir, "screenshots");
  await fs.mkdir(screenshotsDir, { recursive: true });
  const screenshotPath = path.join(screenshotsDir, fileName);
  await fs.writeFile(screenshotPath, buffer);
  return screenshotPath;
}

function wrapPreviewHtml(html) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        background: #f2f4f7;
        overflow: hidden;
      }

      .preview-root {
        width: 100vw;
        height: 100vh;
        display: flex;
        align-items: stretch;
        justify-content: center;
      }

      iframe {
        width: 100% !important;
        height: 100vh !important;
        border: 0 !important;
      }
    </style>
  </head>
  <body><div class="preview-root">${html}</div></body>
</html>`;
}

async function waitForPreviewContent(page, waitMs, remaining) {
  await page.waitForLoadState("load", { timeout: Math.min(15000, remaining()) }).catch(() => {});
  await page
    .locator("iframe")
    .first()
    .waitFor({ state: "attached", timeout: Math.min(10000, remaining()) })
    .catch(() => {});

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    await frame.waitForLoadState("domcontentloaded", { timeout: Math.min(10000, remaining()) }).catch(() => {});
    await frame.waitForLoadState("load", { timeout: Math.min(10000, remaining()) }).catch(() => {});
  }

  const settleMs = Math.min(waitMs, remaining());
  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }
}

async function getSharedBrowser(timeout) {
  if (sharedBrowser?.isConnected()) return sharedBrowser;

  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium
      .launch({
        headless: true,
        timeout
      })
      .then((browser) => {
        sharedBrowser = browser;
        browser.on("disconnected", () => {
          if (sharedBrowser === browser) {
            sharedBrowser = undefined;
            sharedBrowserPromise = undefined;
          }
        });
        return browser;
      })
      .catch((error) => {
        sharedBrowser = undefined;
        sharedBrowserPromise = undefined;
        throw error;
      });
  }

  return sharedBrowserPromise;
}

async function closeBrowser(browser) {
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
}

function estimateScreenshotQuality(buffer) {
  const png = PNG.sync.read(buffer);
  const step = 12;
  let count = 0;
  let sum = 0;
  let sumSquares = 0;

  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const idx = (png.width * y + x) << 2;
      const luma =
        0.2126 * png.data[idx] + 0.7152 * png.data[idx + 1] + 0.0722 * png.data[idx + 2];
      sum += luma;
      sumSquares += luma * luma;
      count += 1;
    }
  }

  const mean = sum / count;
  const variance = sumSquares / count - mean * mean;

  return {
    lumaMean: Math.round(mean * 100) / 100,
    lumaVariance: Math.round(variance * 100) / 100,
    isFlatDark: mean < 35 && variance < 180
  };
}

function cropSignificantContent(buffer) {
  const png = PNG.sync.read(buffer);
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];

      if (a > 0 && !isBlankPreviewBackground(r, g, b)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const detectedWidth = maxX - minX + 1;
  const detectedHeight = maxY - minY + 1;
  const tooSmall = detectedWidth < png.width * 0.12 || detectedHeight < png.height * 0.12;

  if (maxX < minX || maxY < minY || tooSmall) {
    return {
      buffer,
      debug: {
        wasCropped: false,
        reason: tooSmall ? "detected-content-too-small" : "no-content-detected",
        original: { width: png.width, height: png.height },
        detected: { x: minX, y: minY, width: detectedWidth, height: detectedHeight }
      }
    };
  }

  const padding = 8;
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  const width = Math.min(png.width - x, detectedWidth + padding * 2);
  const height = Math.min(png.height - y, detectedHeight + padding * 2);
  const cropped = new PNG({ width, height });

  PNG.bitblt(png, cropped, x, y, width, height, 0, 0);

  return {
    buffer: PNG.sync.write(cropped),
    debug: {
      wasCropped: true,
      original: { width: png.width, height: png.height },
      crop: { x, y, width, height }
    }
  };
}

function isBlankPreviewBackground(r, g, b) {
  const isWhite = r > 245 && g > 245 && b > 245;
  const isWrapperGray = Math.abs(r - 242) < 8 && Math.abs(g - 244) < 8 && Math.abs(b - 247) < 8;
  return isWhite || isWrapperGray;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "ad-preview";
}
