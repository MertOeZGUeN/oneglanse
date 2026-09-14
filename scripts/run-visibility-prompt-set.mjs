import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProviders(raw) {
  const supported = new Set(["chatgpt", "claude", "gemini", "perplexity", "ai-overview"]);
  const values = (raw || "chatgpt,claude,gemini,perplexity")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !supported.has(value));
  if (invalid.length) throw new Error(`Unsupported provider(s): ${invalid.join(", ")}`);
  return values;
}

function loadPromptSet(filePath, parseVisibilityPromptSet) {
  const absolute = path.resolve(root, filePath);
  const raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
  return parseVisibilityPromptSet(raw);
}

function buildProviderReport(records, providers) {
  return providers.map((provider) => {
    const rows = records.filter((record) => record.model_provider === provider);
    const sourceProbe = rows.find((record) => record.prompt_id.startsWith("ACC-SOURCES-001::"));
    const statuses = rows.map((record) => record.capture_status ?? "answered");
    const allAnswered = rows.length > 0 && statuses.every((status) => status === "answered");
    const responsePass = rows.length > 0 && rows.every((record) => record.response?.trim().length > 0);
    const screenshotPass = rows.length > 0 && rows.every((record) => Boolean(record.screenshot_path));
    const deterministicPass =
      rows.length > 0 && rows.every((record) => Boolean(record.brand_analysis?.measurement));
    const sourceSurfacePass = Boolean(sourceProbe && (sourceProbe.sources?.length ?? 0) > 0);

    return {
      provider,
      observations: rows.length,
      statuses,
      responsePass,
      screenshotPass,
      deterministicPass,
      sourceSurfacePass,
      sourceCount: sourceProbe?.sources?.length ?? 0,
      pass:
        allAnswered &&
        responsePass &&
        screenshotPass &&
        deterministicPass &&
        sourceSurfacePass,
    };
  });
}

async function waitForRun({ services, workspaceId, runGroupId, jobGroupId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let expectedResponses = null;

  while (Date.now() < deadline) {
    const raw = await services.redis.get(services.buildProgressKey(jobGroupId));
    if (raw) {
      const progress = JSON.parse(raw);
      expectedResponses = progress.stats?.expectedResponses ?? expectedResponses;
      if (progress.status === "completed") break;
    }
    await sleep(1500);
  }

  if (Date.now() >= deadline) throw new Error("Timed out waiting for provider jobs to complete.");

  while (Date.now() < deadline) {
    const records = await services.fetchAnalysedPrompts({ workspaceId, limit: 10000 });
    const runRecords = records.filter(
      (record) => record.visibility_metadata?.runGroupId === runGroupId,
    );
    const enough = expectedResponses === null || runRecords.length >= expectedResponses;
    const analysed = runRecords.length > 0 && runRecords.every((record) => record.is_analysed);
    if (enough && analysed) return runRecords;
    await sleep(1000);
  }

  throw new Error("Provider jobs completed, but analysis/storage did not settle before timeout.");
}

async function main() {
  const workspaceId = readArg("--workspace") || process.env.IZI_VISIBILITY_WORKSPACE_ID;
  const userId = readArg("--user") || process.env.IZI_VISIBILITY_USER_ID;
  const runLabel = readArg("--run-label") || process.env.IZI_VISIBILITY_RUN_LABEL;
  const promptSetPath =
    readArg("--prompt-set") || "config/visibility/gloria-v1.example.json";
  const providers = parseProviders(readArg("--providers"));
  const wait = hasArg("--wait");
  const timeoutMinutes = Number(readArg("--timeout-minutes") || "20");

  if (!workspaceId || !userId) {
    throw new Error(
      "Workspace and user are required. Pass --workspace/--user or set IZI_VISIBILITY_WORKSPACE_ID and IZI_VISIBILITY_USER_ID.",
    );
  }

  const servicesEntry = path.resolve(root, "packages/services/dist/index.js");
  if (!fs.existsSync(servicesEntry)) {
    throw new Error(
      "packages/services/dist/index.js is missing. Run through the package script so workspace services are built first.",
    );
  }

  const services = await import(pathToFileURL(servicesEntry).href);
  const promptSet = loadPromptSet(promptSetPath, services.parseVisibilityPromptSet);

  const submitted = await services.submitVisibilityPromptSetJobGroup({
    workspaceId,
    userId,
    promptSet,
    providers,
    runLabel,
  });

  console.log(JSON.stringify({ ...submitted, runLabel: runLabel || null }, null, 2));
  if (!wait || submitted.status !== "queued") return;

  const records = await waitForRun({
    services,
    workspaceId,
    runGroupId: submitted.runGroupId,
    jobGroupId: submitted.jobGroupId,
    timeoutMs: timeoutMinutes * 60 * 1000,
  });

  const providerReport = buildProviderReport(records, providers);
  const report = {
    schemaVersion: "izi.ai-visibility.live-acceptance.v1",
    runGroupId: submitted.runGroupId,
    runLabel: runLabel || null,
    promptSetId: promptSet.id,
    promptSetVersion: promptSet.version,
    providers: providerReport,
    pass: providerReport.every((item) => item.pass),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
