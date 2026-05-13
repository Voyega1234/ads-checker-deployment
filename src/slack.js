const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1000;

export async function postSlackMessage({
  botToken,
  channelId,
  text,
  blocks,
  attachments,
  threadTs,
  maxRetries = DEFAULT_MAX_RETRIES
}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${botToken}`
      },
      body: JSON.stringify({
        channel: channelId,
        text,
        blocks,
        attachments,
        thread_ts: threadTs
      })
    });

    const body = await response.json().catch(() => ({}));
    if (response.ok && body.ok !== false) return body;

    const message = body.error || response.statusText;
    lastError = new Error(`Slack chat.postMessage failed: ${response.status} ${message}`);

    if (!shouldRetrySlackPost(response, body) || attempt >= maxRetries) {
      throw lastError;
    }

    const waitMs = getSlackRetryDelayMs(response, attempt);
    await sleep(waitMs);
  }

  throw lastError;
}

function shouldRetrySlackPost(response, body) {
  if (response.status === 429) return true;
  if (response.status >= 500) return true;
  return ["ratelimited", "fatal_error", "internal_error"].includes(body?.error);
}

function getSlackRetryDelayMs(response, attempt) {
  const retryAfter = Number.parseFloat(response.headers.get("retry-after") || "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000) + 250;
  }
  return DEFAULT_RETRY_BASE_MS * 2 ** attempt;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
