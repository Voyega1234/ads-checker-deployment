import { PNG } from "pngjs";

const EDGE_THRESHOLD = 72;
const SAMPLE_STEP = 3;

export function analyzeScreenshot({ buffer, pageText = "", format }) {
  const png = PNG.sync.read(buffer);
  const zones = analyzeZones(png);
  const global = analyzeGlobal(png);
  const issues = [];

  if (looksLikeErrorPage(pageText)) {
    issues.push({
      severity: "high",
      code: "preview_error_text",
      message: "Preview rendered with error/login-like text."
    });
  }

  if (global.lumaVariance < 18 || global.colorBuckets < 24) {
    issues.push({
      severity: "high",
      code: "blank_or_flat_render",
      message: "Screenshot is visually blank or nearly flat."
    });
  }

  for (const zone of Object.values(zones)) {
    if (zone.name === "center") continue;

    const ratioToCenter = zone.edgeDensity / Math.max(zones.center.edgeDensity, 0.001);
    const visualSignalDensity = zone.brightEdgeDensity + zone.darkEdgeDensity;
    const thresholds = signalThresholds(zone.name);
    const isHigh =
      (zone.edgeDensity > 0.14 && ratioToCenter > 0.72) ||
      visualSignalDensity > thresholds.high;
    const isMedium =
      (zone.edgeDensity > 0.09 && ratioToCenter > 0.55) ||
      visualSignalDensity > thresholds.medium;

    if (isHigh || isMedium) {
      issues.push({
        severity: isHigh ? "high" : "medium",
        code: `safe_zone_${zone.name}`,
        message: `${labelZone(zone.name)} has dense visual detail near the edge; text/logo/product may be cropped or covered.`,
        details: {
          edgeDensity: round(zone.edgeDensity),
          visualSignalDensity: round(visualSignalDensity),
          centerEdgeDensity: round(zones.center.edgeDensity),
          ratioToCenter: round(ratioToCenter)
        }
      });
    }
  }

  return {
    format,
    risk: getRisk(issues),
    issues,
    metrics: {
      lumaVariance: round(global.lumaVariance),
      colorBuckets: global.colorBuckets,
      zones: Object.fromEntries(
        Object.values(zones).map((zone) => [
          zone.name,
          {
            edgeDensity: round(zone.edgeDensity),
            brightEdgeDensity: round(zone.brightEdgeDensity),
            darkEdgeDensity: round(zone.darkEdgeDensity)
          }
        ])
      )
    }
  };
}

function analyzeZones(png) {
  const { width, height } = png;
  const specs = [
    ["top", 0, 0, width, Math.floor(height * 0.12)],
    ["bottom", 0, Math.floor(height * 0.82), width, height],
    ["left", 0, 0, Math.floor(width * 0.08), height],
    ["right", Math.floor(width * 0.92), 0, width, height],
    [
      "center",
      Math.floor(width * 0.18),
      Math.floor(height * 0.18),
      Math.floor(width * 0.82),
      Math.floor(height * 0.72)
    ]
  ];

  return Object.fromEntries(
    specs.map(([name, x0, y0, x1, y1]) => [
      name,
      {
        name,
        ...zoneStats(png, x0, y0, x1, y1)
      }
    ])
  );
}

function zoneStats(png, x0, y0, x1, y1) {
  let edges = 0;
  let brightEdges = 0;
  let darkEdges = 0;
  let samples = 0;

  for (let y = Math.max(y0 + 1, 1); y < y1; y += SAMPLE_STEP) {
    for (let x = Math.max(x0 + 1, 1); x < x1; x += SAMPLE_STEP) {
      const current = lumaAt(png, x, y);
      const left = lumaAt(png, x - 1, y);
      const up = lumaAt(png, x, y - 1);
      const edgeStrength = Math.abs(current - left) + Math.abs(current - up);

      if (edgeStrength > EDGE_THRESHOLD) {
        edges += 1;
      }

      if (current > 200 && edgeStrength > 35) brightEdges += 1;
      if (current < 35 && edgeStrength > 35) darkEdges += 1;

      samples += 1;
    }
  }

  return {
    edgeDensity: samples ? edges / samples : 0,
    brightEdgeDensity: samples ? brightEdges / samples : 0,
    darkEdgeDensity: samples ? darkEdges / samples : 0
  };
}

function analyzeGlobal(png) {
  const buckets = new Set();
  let count = 0;
  let sum = 0;
  let sumSquares = 0;

  for (let y = 0; y < png.height; y += SAMPLE_STEP) {
    for (let x = 0; x < png.width; x += SAMPLE_STEP) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const luma = rgbToLuma(r, g, b);

      sum += luma;
      sumSquares += luma * luma;
      count += 1;
      buckets.add(`${r >> 4}-${g >> 4}-${b >> 4}`);
    }
  }

  const mean = sum / count;
  return {
    lumaVariance: sumSquares / count - mean * mean,
    colorBuckets: buckets.size
  };
}

function lumaAt(png, x, y) {
  const idx = (png.width * y + x) << 2;
  return rgbToLuma(png.data[idx], png.data[idx + 1], png.data[idx + 2]);
}

function rgbToLuma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function looksLikeErrorPage(text) {
  return /something went wrong|log in|login|unsupported browser|error loading|not available|permission error|permissions error|ข้อผิดพลาดการอนุญาต|ไม่ได้รับอนุญาต|คุณไม่ได้รับอนุญาต|ให้ใช้โปรไฟล์นี้/i.test(
    text
  );
}

function getRisk(issues) {
  if (issues.some((issue) => issue.severity === "high")) return "high";
  if (issues.some((issue) => issue.severity === "medium")) return "medium";
  if (issues.length) return "low";
  return "ok";
}

function labelZone(name) {
  return {
    top: "Top safe zone",
    bottom: "Bottom safe zone",
    left: "Left edge",
    right: "Right edge"
  }[name] || name;
}

function signalThresholds(name) {
  if (name === "top") return { medium: 0.0015, high: 0.004 };
  if (name === "bottom") return { medium: 0.003, high: 0.007 };
  return { medium: 0.006, high: 0.012 };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
