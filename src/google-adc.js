import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GoogleAuth } from "google-auth-library";

const execFileAsync = promisify(execFile);
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

let tokenCache = null;
let projectCache = null;

export function resolveGeminiAuthMode() {
  const mode = String(process.env.GEMINI_AUTH_MODE || "adc").trim().toLowerCase();
  if (["api-key", "api_key", "apikey"].includes(mode)) return "api_key";
  if (["adc", "oauth", "application-default", "application_default_credentials"].includes(mode)) {
    return "adc";
  }
  throw new Error(`Unsupported GEMINI_AUTH_MODE: ${mode}`);
}

export function isGeminiAdcAuthEnabled() {
  return resolveGeminiAuthMode() === "adc";
}

export async function buildGeminiAuthHeaders(apiKey = "") {
  if (!isGeminiAdcAuthEnabled()) {
    const key = String(apiKey || process.env.GEMINI_API_KEY || "").trim();
    if (!key) return null;
    return { "x-goog-api-key": key };
  }

  const accessToken = await getGoogleAdcAccessToken();
  const headers = { authorization: `Bearer ${accessToken}` };
  const project = await getGoogleCloudProject();
  if (project) headers["x-goog-user-project"] = project;
  return headers;
}

export async function getGoogleAdcAccessToken() {
  const explicit = String(process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "").trim();
  if (explicit) return explicit;

  const now = Date.now();
  if (tokenCache?.token && tokenCache.expiresAtMs - now > 60_000) {
    return tokenCache.token;
  }

  const libraryToken = await getGoogleAuthLibraryToken();
  if (libraryToken) return libraryToken;

  const metadataToken = await getMetadataServerToken();
  if (metadataToken) return metadataToken;

  const gcloudToken = await getGcloudAdcToken();
  if (gcloudToken) return gcloudToken;

  throw new Error(
    "ADC token unavailable. Run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS."
  );
}

async function getGoogleAuthLibraryToken() {
  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const token = String(
      typeof accessToken === "string" ? accessToken : accessToken?.token || ""
    ).trim();
    if (!token) return "";
    tokenCache = { token, expiresAtMs: Date.now() + 50 * 60 * 1000 };
    return token;
  } catch {
    return "";
  }
}

async function getMetadataServerToken() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(METADATA_TOKEN_URL, {
      signal: controller.signal,
      headers: { "Metadata-Flavor": "Google" }
    });
    if (!response.ok) return "";
    const payload = await response.json();
    const token = String(payload.access_token || "").trim();
    if (!token) return "";
    const expiresInMs = Number(payload.expires_in || 300) * 1000;
    tokenCache = { token, expiresAtMs: Date.now() + expiresInMs };
    return token;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function getGcloudAdcToken() {
  try {
    const { stdout } = await execFileAsync(
      "gcloud",
      ["auth", "application-default", "print-access-token"],
      { timeout: 15_000, maxBuffer: 1024 * 1024 }
    );
    const token = String(stdout || "").trim();
    if (!token) return "";
    tokenCache = { token, expiresAtMs: Date.now() + 50 * 60 * 1000 };
    return token;
  } catch {
    return "";
  }
}

export async function getGoogleCloudProject() {
  if (projectCache !== null) return projectCache;

  projectCache =
    firstNonEmpty([
      process.env.GOOGLE_CLOUD_PROJECT,
      process.env.GCLOUD_PROJECT,
      process.env.GCP_PROJECT_ID,
      process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
      await projectFromGoogleAuthLibrary(),
      await projectFromCredentialsFile(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      await projectFromCredentialsFile(defaultAdcPath()),
      await projectFromGcloudConfig()
    ]) || "";

  return projectCache;
}

async function projectFromGoogleAuthLibrary() {
  try {
    const auth = new GoogleAuth();
    return await auth.getProjectId();
  } catch {
    return "";
  }
}

async function projectFromCredentialsFile(filePath) {
  const resolved = String(filePath || "").trim();
  if (!resolved) return "";
  try {
    const payload = JSON.parse(await fs.readFile(resolved, "utf8"));
    return firstNonEmpty([payload.quota_project_id, payload.project_id]);
  } catch {
    return "";
  }
}

function defaultAdcPath() {
  return path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
}

async function projectFromGcloudConfig() {
  try {
    const { stdout } = await execFileAsync("gcloud", ["config", "get-value", "project"], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

function firstNonEmpty(values) {
  return (values || []).map((value) => String(value || "").trim()).find(Boolean) || "";
}
