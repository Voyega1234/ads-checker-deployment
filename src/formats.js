export const DEFAULT_FORMATS = [
  "MOBILE_FEED_STANDARD",
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "MARKETPLACE_MOBILE",
  "INSTAGRAM_REELS",
  "INSTAGRAM_PROFILE_FEED",
  "INSTAGRAM_EXPLORE_GRID_HOME",
  "INSTAGRAM_SEARCH_CHAIN",
  "INSTAGRAM_SEARCH_GRID",
  "MOBILE_BANNER",
  "FACEBOOK_REELS_MOBILE",
  "FACEBOOK_STORY_MOBILE"
];

const FORMAT_VIEWPORTS = {
  MOBILE_FEED_STANDARD: { width: 1080, height: 1350 },
  INSTAGRAM_STANDARD: { width: 1080, height: 1080 },
  INSTAGRAM_STORY: { width: 1080, height: 1920 },
  MARKETPLACE_MOBILE: { width: 1080, height: 1080 },
  INSTAGRAM_REELS: { width: 1080, height: 1920 },
  INSTAGRAM_PROFILE_FEED: { width: 1080, height: 1080 },
  INSTAGRAM_EXPLORE_GRID_HOME: { width: 1080, height: 1080 },
  INSTAGRAM_SEARCH_CHAIN: { width: 1080, height: 1080 },
  INSTAGRAM_SEARCH_GRID: { width: 1080, height: 1080 },
  MOBILE_BANNER: { width: 1080, height: 1080 },
  FACEBOOK_REELS_MOBILE: { width: 1080, height: 1920 },
  FACEBOOK_STORY_MOBILE: { width: 1080, height: 1920 },
};

export function getViewportForFormat(format) {
  return FORMAT_VIEWPORTS[format] ?? { width: 1080, height: 1920 };
}

export function parseFormats(value) {
  if (!value) return DEFAULT_FORMATS;
  return value
    .split(",")
    .map((format) => format.trim().replace(/^AD_FORMATS=/i, ""))
    .filter(Boolean);
}
