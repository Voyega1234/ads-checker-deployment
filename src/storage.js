export async function uploadScreenshotToSupabase({
  supabaseUrl,
  serviceKey,
  bucket,
  prefix,
  fileName,
  buffer,
  contentType = "image/png"
}) {
  if (!supabaseUrl || !serviceKey || !bucket) return null;

  const objectPath = buildObjectPath(prefix, fileName);
  const uploadUrl = `${trimTrailingSlash(supabaseUrl)}/storage/v1/object/${encodePath(bucket)}/${encodePath(
    objectPath
  )}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": contentType,
      "x-upsert": "true"
    },
    body: buffer
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || body.error || response.statusText;
    throw new Error(`Supabase upload failed: ${response.status} ${message}`);
  }

  return {
    objectPath,
    publicUrl: `${trimTrailingSlash(supabaseUrl)}/storage/v1/object/public/${encodePath(
      bucket
    )}/${encodePath(objectPath)}`
  };
}

function buildObjectPath(prefix, fileName) {
  const date = new Date().toISOString().slice(0, 10);
  const cleanPrefix = `${prefix || ""}`.replace(/^\/+|\/+$/g, "");
  return [cleanPrefix, date, fileName].filter(Boolean).join("/");
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function encodePath(value) {
  return `${value}`
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
