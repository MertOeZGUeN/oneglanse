import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const authRoot = path.join(root, ".oneglanse-storage", "auth");
const supported = new Set(["chatgpt", "claude", "gemini", "perplexity"]);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseProviders(raw) {
  const values = (raw || "chatgpt,claude,gemini,perplexity")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !supported.has(value));
  if (invalid.length) throw new Error(`Unsupported provider(s): ${invalid.join(", ")}`);
  return [...new Set(values)];
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function providerStatus(provider) {
  const sessionPath = path.join(authRoot, "sessions", provider, `${provider}-auth.json`);
  const statusPath = path.join(authRoot, "status", `${provider}.json`);
  const session = readJsonIfExists(sessionPath);
  const persistedStatus = readJsonIfExists(statusPath);
  const cookieCount = Array.isArray(session?.cookies) ? session.cookies.length : 0;
  const originCount = Array.isArray(session?.origins) ? session.origins.length : 0;
  const hasSession = cookieCount > 0 || originCount > 0;

  let reason = "ready";
  if (persistedStatus?.connecting) reason = "auth_in_progress";
  else if (!hasSession && persistedStatus?.error) reason = "auth_error";
  else if (!hasSession) reason = "login_required";

  return {
    provider,
    status: reason === "ready" ? "ready" : "not_ready",
    reason,
    sessionPresent: Boolean(session),
    cookieCount,
    originCount,
    lastUpdatedAt: persistedStatus?.lastUpdatedAt ?? null,
    syncedAt: persistedStatus?.syncedAt ?? null,
    authError: persistedStatus?.error ?? null,
    nextAction:
      reason === "ready"
        ? null
        : reason === "auth_in_progress"
          ? "Finish the visible provider login window, close it, then run preflight again."
          : `Run \`pnpm visibility:auth -- --providers ${provider}\`, sign in, close the auth window, then run preflight again.`,
  };
}

function main() {
  const requestedProviders = parseProviders(readArg("--providers"));
  const providers = requestedProviders.map(providerStatus);
  const readyProviders = providers.filter((item) => item.status === "ready").map((item) => item.provider);
  const missingAuthProviders = providers
    .filter((item) => item.status !== "ready")
    .map((item) => item.provider);

  const report = {
    schemaVersion: "izi.ai-visibility.preflight.v4",
    executionMode: "dockerless-local-consumer-ui",
    runtime: {
      dockerRequired: false,
      postgresRequired: false,
      clickhouseRequired: false,
      redisRequired: false,
      storageRoot: path.join(root, ".oneglanse-storage"),
      authRoot,
    },
    requestedProviders,
    readyProviders,
    missingAuthProviders,
    providers,
    nextAction:
      missingAuthProviders.length === 0
        ? "Run `pnpm visibility:acceptance`."
        : "Run `pnpm visibility:auth` to capture the missing provider sessions, then run preflight again.",
    pass: missingAuthProviders.length === 0,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
