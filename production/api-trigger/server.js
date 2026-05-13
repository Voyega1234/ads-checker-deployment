import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const DEFAULT_VIEWER_URL = "https://report-viewer-theta.vercel.app/report-viewer";
const VALID_MODES = new Set(["policy", "placement", "unified", "slack", "full"]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const config = {
  runner: (process.env.TRIGGER_RUNNER || "cloud-run").trim().toLowerCase(),
  pythonBin: process.env.PYTHON_BIN || "python3",
  localLogDir: process.env.TRIGGER_LOG_DIR || path.join(PROJECT_ROOT, "logs", "api-trigger"),
  localRunDir: process.env.TRIGGER_RUN_DIR || path.join(PROJECT_ROOT, "logs", "api-trigger", "runs"),
  maxConcurrentRuns: parsePositiveInt(process.env.MAX_CONCURRENT_RUNS, 1),
  projectId: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "",
  region: process.env.CLOUD_RUN_REGION || process.env.GCP_REGION || "",
  jobName: process.env.CLOUD_RUN_JOB_NAME || "",
  jobResourceName: process.env.CLOUD_RUN_JOB_RESOURCE || "",
  defaultChannel: process.env.SLACK_OVERRIDE_CHANNEL_ID || "",
  defaultViewerUrl: process.env.REPORT_VIEWER_URL || DEFAULT_VIEWER_URL,
  triggerToken: process.env.RUN_TRIGGER_TOKEN || "",
  allowUnauthenticated: process.env.ALLOW_UNAUTHENTICATED_TRIGGER === "1"
};

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const status = Number(error.status || 500);
    if (status >= 500) console.error(error);
    sendJson(response, status, { ok: false, error: error.message || "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(`ad-compliance trigger api listening on ${PORT}`);
});

async function route(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "ad-compliance-trigger",
      runner: config.runner,
      targetJob: getJobResourceName() || null,
      maxConcurrentRuns: config.runner === "local" ? config.maxConcurrentRuns : null
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/runs") {
    requireTriggerAuth(request);
    const body = await readJson(request);
    const args = buildWorkerArgs(body);
    const dryRun = body.dryRun === true;
    if (dryRun) {
      sendJson(response, 200, { ok: true, dryRun: true, args });
      return;
    }

    const operation =
      config.runner === "local"
        ? await runLocalWorker(args)
        : await runCloudRunJob(args);
    sendJson(response, 202, {
      ok: true,
      runner: config.runner,
      job: config.runner === "local" ? null : getJobResourceName(),
      args,
      operation
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "not_found" });
}

function requireTriggerAuth(request) {
  if (config.allowUnauthenticated) return;
  if (!config.triggerToken) {
    throw httpError(500, "RUN_TRIGGER_TOKEN is required unless ALLOW_UNAUTHENTICATED_TRIGGER=1");
  }

  const auth = String(request.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const headerToken = String(request.headers["x-trigger-token"] || "");
  if (bearer === config.triggerToken || headerToken === config.triggerToken) return;
  throw httpError(401, "unauthorized");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "invalid_json");
  }
}

function buildWorkerArgs(body) {
  const mode = normalizeMode(body.mode || "full");
  const args = ["--mode", mode];
  const account = normalizeAccount(body.accountId || body.account || "");
  const allAccounts = body.allAccounts === true;

  if (allAccounts) {
    args.push("--all-accounts");
    if (body.accountDelay !== undefined) {
      const delay = Number(body.accountDelay);
      if (!Number.isInteger(delay) || delay < 0) throw httpError(400, "accountDelay must be a non-negative integer");
      args.push("--account-delay", String(delay));
    }
  } else if (account) {
    args.push("--account", account);
  } else {
    throw httpError(400, "accountId or allAccounts=true is required");
  }

  const channel = normalizeSlackChannel(body.channel || config.defaultChannel);
  if (channel) args.push("--channel", channel);

  const viewerUrl = String(body.viewerUrl || config.defaultViewerUrl || "").trim();
  if (viewerUrl) args.push("--viewer-url", viewerUrl);

  if (body.skipSlack === true) args.push("--skip-slack");
  return args;
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!VALID_MODES.has(mode)) throw httpError(400, `invalid mode: ${value}`);
  return mode;
}

function normalizeAccount(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const account = raw.startsWith("act_") ? raw : `act_${raw}`;
  if (!/^act_\d{6,32}$/.test(account)) throw httpError(400, `invalid accountId: ${value}`);
  return account;
}

function normalizeSlackChannel(value) {
  const channel = String(value || "").trim();
  if (!channel) return "";
  if (!/^[A-Z0-9]{8,16}$/.test(channel)) throw httpError(400, `invalid channel: ${value}`);
  return channel;
}

async function runCloudRunJob(args) {
  const job = getJobResourceName();
  if (!job) throw httpError(500, "Cloud Run job target env is incomplete");
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(`https://run.googleapis.com/v2/${job}:run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{ args }]
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || response.statusText || "Cloud Run job run failed";
    throw httpError(response.status, message);
  }
  return data;
}

async function runLocalWorker(args) {
  await fs.promises.mkdir(config.localLogDir, { recursive: true });
  await fs.promises.mkdir(config.localRunDir, { recursive: true });
  const activeRuns = await getActiveLocalRuns();
  if (activeRuns.length >= config.maxConcurrentRuns) {
    const error = httpError(409, "run_already_in_progress");
    error.details = { activeRuns };
    throw error;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(config.localLogDir, `run-${runId}.log`);
  const lockPath = path.join(config.localRunDir, `${runId}.json`);
  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");
  const child = spawn(
    config.pythonBin,
    ["production/worker/main.py", ...args],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        REPORT_VIEWER_URL: config.defaultViewerUrl
      }
    }
  );
  child.unref();
  await writeJson(lockPath, {
    runId,
    pid: child.pid,
    args,
    logPath,
    startedAt: new Date().toISOString()
  });
  return {
    type: "local",
    runId,
    pid: child.pid,
    done: false,
    logPath,
    lockPath
  };
}

async function getActiveLocalRuns() {
  const entries = await fs.promises.readdir(config.localRunDir).catch(() => []);
  const active = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const lockPath = path.join(config.localRunDir, entry);
    const run = await readJsonFile(lockPath).catch(() => null);
    if (!run?.pid) {
      await fs.promises.unlink(lockPath).catch(() => {});
      continue;
    }
    if (isProcessAlive(run.pid)) {
      active.push({ ...run, lockPath });
      continue;
    }
    await fs.promises.unlink(lockPath).catch(() => {});
  }
  return active;
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getJobResourceName() {
  if (config.jobResourceName) return config.jobResourceName.replace(/^\/+/, "");
  if (!config.projectId || !config.region || !config.jobName) return "";
  return `projects/${config.projectId}/locations/${config.region}/jobs/${config.jobName}`;
}

async function getGoogleAccessToken() {
  const metadataUrl =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const response = await fetch(metadataUrl, {
    headers: { "Metadata-Flavor": "Google" }
  });
  if (!response.ok) {
    throw httpError(response.status, "Could not obtain Google metadata access token");
  }
  const data = await response.json();
  if (!data.access_token) throw httpError(500, "Google metadata response did not include access_token");
  return data.access_token;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(`${value || ""}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

process.on("uncaughtException", (error) => {
  console.error(error);
});

process.on("unhandledRejection", (error) => {
  console.error(error);
});
