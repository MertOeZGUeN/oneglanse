import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  buildLocalWorkspacePackages,
  ensureEnvFiles,
  ensureLocalCamoufoxRuntime,
  repoRoot,
  runCommand,
} from "./lib/runtime.mjs";

const SUPPORTED_PROVIDERS = new Set(["chatgpt", "claude", "gemini", "perplexity"]);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function safeSegment(value) {
  return String(value || "run")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
}

function parseProviders(raw) {
  const values = (raw || "chatgpt,claude,gemini,perplexity")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !SUPPORTED_PROVIDERS.has(value));
  if (invalid.length) throw new Error(`Unsupported provider(s): ${invalid.join(", ")}`);
  return [...new Set(values)];
}

function loadJson(relativeOrAbsolutePath) {
  const absolute = path.resolve(repoRoot, relativeOrAbsolutePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function validateProfile(profile) {
  if (profile?.schemaVersion !== "izi.ai-visibility.brand-profile.v1") {
    throw new Error("Invalid visibility brand profile schemaVersion.");
  }
  if (!profile.brand?.name || !profile.brand?.domain) {
    throw new Error("Visibility brand profile requires brand.name and brand.domain.");
  }
  return profile;
}

function normalizeCaptureStatus(result) {
  const status = result.captureStatus || "answered";
  return status === "answered" ? undefined : status;
}

function providerAcceptance(records, provider, expectedExecutions) {
  const rows = records.filter((record) => record.provider === provider);
  const sourceProbe = rows.find((record) => record.promptDefinitionId === "ACC-SOURCES-001");
  const failures = [];

  if (rows.length !== expectedExecutions) {
    failures.push(`expected ${expectedExecutions} observations, received ${rows.length}`);
  }
  const badCapture = rows.filter((row) => row.captureStatus !== "answered");
  if (badCapture.length) {
    failures.push(`capture failures: ${badCapture.map((row) => `${row.promptDefinitionId}:${row.captureStatus}`).join(", ")}`);
  }
  if (rows.some((row) => !row.response?.trim())) failures.push("one or more rendered responses are empty");
  if (rows.some((row) => !row.screenshotPath)) failures.push("one or more evidence screenshots are missing");
  if (rows.some((row) => !row.measurement)) failures.push("one or more deterministic measurements are missing");
  if (!sourceProbe || (sourceProbe.sources?.length ?? 0) === 0) {
    failures.push("ACC-SOURCES-001 exposed no visible source URLs");
  }

  return {
    provider,
    observations: rows.length,
    failures,
    pass: failures.length === 0,
  };
}

async function main() {
  const promptSetPath = readArg("--prompt-set") || "config/visibility/gloria-live-acceptance-v1.json";
  const profilePath = readArg("--profile") || "config/visibility/gloria-profile-v1.json";
  const providers = parseProviders(readArg("--providers"));
  const runLabel = readArg("--run-label") || process.env.IZI_VISIBILITY_RUN_LABEL || null;
  const acceptance = hasArg("--acceptance");

  await ensureEnvFiles();
  await ensureLocalCamoufoxRuntime();
  await buildLocalWorkspacePackages();

  const promptSetModule = await import(
    pathToFileURL(path.join(repoRoot, "packages/services/dist/analysis/promptSet.js")).href
  );
  const deterministicModule = await import(
    pathToFileURL(path.join(repoRoot, "packages/services/dist/analysis/deterministicVisibility.js")).href
  );

  const promptSet = promptSetModule.parseVisibilityPromptSet(loadJson(promptSetPath));
  const profile = validateProfile(loadJson(profilePath));
  const runGroupId = promptSetModule.createVisibilityRunGroupId();
  const executions = promptSetModule.buildVisibilityPromptExecutions(promptSet, runGroupId, {
    runLabel: runLabel || undefined,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultRunName = runLabel
    ? `${safeSegment(runLabel)}__${timestamp}`
    : `${safeSegment(promptSet.id)}__${timestamp}`;
  const runDir = readArg("--output-dir")
    ? path.resolve(repoRoot, readArg("--output-dir"))
    : path.join(repoRoot, ".oneglanse-storage", "visibility-runs", defaultRunName);
  const tempDir = path.join(runDir, ".tmp");
  const screenshotsDir = path.join(runDir, "screenshots");
  await fsp.mkdir(tempDir, { recursive: true });
  await fsp.mkdir(screenshotsDir, { recursive: true });

  const observations = [];
  const payloadBase = {
    user_id: "local-user",
    workspace_id: `gloria-local-${runGroupId}`,
    prompts: executions,
  };

  console.log(`Dockerless visibility run ${runGroupId}`);
  console.log(`Prompt set: ${promptSet.id}@${promptSet.version} (${executions.length} executions/provider)`);
  console.log(`Providers: ${providers.join(", ")}`);
  console.log(`Output: ${runDir}`);

  for (const provider of providers) {
    const inputPath = path.join(tempDir, `${provider}-input.json`);
    const outputPath = path.join(tempDir, `${provider}-output.json`);
    await fsp.writeFile(inputPath, JSON.stringify(payloadBase, null, 2), "utf8");

    console.log(`\n=== ${provider.toUpperCase()} ===`);
    let rawResults = [];
    let providerError = null;
    try {
      await runCommand(
        "pnpm",
        [
          "--filter",
          "@oneglanse/agent",
          "exec",
          "node",
          "--loader",
          "ts-node/esm",
          "src/dockerless/runVisibility.ts",
          "--provider",
          provider,
          "--input",
          inputPath,
          "--output",
          outputPath,
        ],
        {
          env: {
            ...process.env,
            ONEGLANSE_APP_MODE: "local",
            IZI_AI_VISIBILITY_EVIDENCE_DIR: screenshotsDir,
          },
        },
      );
      rawResults = JSON.parse(await fsp.readFile(outputPath, "utf8"));
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
      console.error(`[${provider}] provider run failed: ${providerError}`);
      rawResults = executions.map((execution) => ({
        promptId: execution.id,
        prompt: execution.prompt,
        response: "",
        sources: [],
        captureStatus: "capture_error",
        screenshotPath: null,
        capturedAt: new Date().toISOString(),
        visibility: execution.visibility,
      }));
    }

    for (const result of rawResults) {
      const meta = result.visibility || {};
      const measurement = deterministicModule.measureVisibility({
        prompt: result.prompt,
        response: result.response,
        sources: result.sources || [],
        brand: profile.brand,
        properties: profile.properties || [],
        competitors: profile.competitors || [],
        captureStatus: normalizeCaptureStatus(result),
      });

      observations.push({
        provider,
        providerError,
        promptExecutionId: result.promptId,
        promptDefinitionId: meta.promptDefinitionId || result.promptId,
        promptVersion: meta.promptVersion || null,
        language: meta.language || null,
        lens: meta.lens || null,
        intent: meta.intent || null,
        repeatIndex: meta.repeatIndex || null,
        repeatTotal: meta.repeatTotal || null,
        prompt: result.prompt,
        response: result.response || "",
        sources: result.sources || [],
        captureStatus: result.captureStatus || "answered",
        screenshotPath: result.screenshotPath || null,
        capturedAt: result.capturedAt || null,
        measurement,
      });
    }
  }

  const eligibleMeasurements = observations.map((item) => item.measurement);
  const overallAggregate = deterministicModule.aggregateVisibility(eligibleMeasurements);
  const providerAggregates = Object.fromEntries(
    providers.map((provider) => [
      provider,
      deterministicModule.aggregateVisibility(
        observations.filter((item) => item.provider === provider).map((item) => item.measurement),
      ),
    ]),
  );

  const runDocument = {
    schemaVersion: "izi.ai-visibility.local-run.v1",
    runGroupId,
    runLabel,
    createdAt: new Date().toISOString(),
    executionMode: "dockerless-local-consumer-ui",
    promptSet: {
      id: promptSet.id,
      version: promptSet.version,
      path: promptSetPath,
    },
    profile: {
      brand: profile.brand.name,
      domain: profile.brand.domain,
      path: profilePath,
    },
    providers,
    aggregate: overallAggregate,
    providerAggregates,
    observations,
  };

  const manifest = {
    schemaVersion: "izi.ai-visibility.evidence-manifest.v1",
    runGroupId,
    runLabel,
    promptSetId: promptSet.id,
    promptSetVersion: promptSet.version,
    observations: observations.map((item) => ({
      provider: item.provider,
      promptExecutionId: item.promptExecutionId,
      promptDefinitionId: item.promptDefinitionId,
      language: item.language,
      lens: item.lens,
      intent: item.intent,
      repeatIndex: item.repeatIndex,
      repeatTotal: item.repeatTotal,
      captureStatus: item.captureStatus,
      deterministicStatus: item.measurement.status,
      responsePresent: Boolean(item.response.trim()),
      responseLength: item.response.length,
      sourceCount: item.sources.length,
      sourceUrls: item.sources.map((source) => source.url).filter(Boolean),
      screenshotPath: item.screenshotPath,
      capturedAt: item.capturedAt,
    })),
  };

  await fsp.writeFile(path.join(runDir, "run.json"), JSON.stringify(runDocument, null, 2), "utf8");
  await fsp.writeFile(
    path.join(runDir, "evidence-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  let acceptanceReport = null;
  if (acceptance) {
    const providerReports = providers.map((provider) =>
      providerAcceptance(observations, provider, executions.length),
    );
    acceptanceReport = {
      schemaVersion: "izi.ai-visibility.live-acceptance.v2",
      runGroupId,
      promptSetId: promptSet.id,
      promptSetVersion: promptSet.version,
      providers: providerReports,
      pass: providerReports.every((item) => item.pass),
    };
    await fsp.writeFile(
      path.join(runDir, "acceptance-report.json"),
      JSON.stringify(acceptanceReport, null, 2),
      "utf8",
    );
  }

  await fsp.rm(tempDir, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        schemaVersion: "izi.ai-visibility.local-run-summary.v1",
        runGroupId,
        runLabel,
        runDir,
        observations: observations.length,
        aggregate: overallAggregate,
        acceptance: acceptanceReport,
      },
      null,
      2,
    ),
  );

  if (acceptanceReport && !acceptanceReport.pass) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
