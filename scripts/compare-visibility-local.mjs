import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runsRoot = path.join(root, ".oneglanse-storage", "visibility-runs");

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function deltaMetrics(before, after) {
  return {
    mentionRate: round(after.mentionRate - before.mentionRate),
    citationRate: round(after.citationRate - before.citationRate),
    top3PresenceRate: round(after.top3PresenceRate - before.top3PresenceRate),
    shareOfVoice: round(after.shareOfVoice - before.shareOfVoice),
  };
}

function executionSignature(observation) {
  return [
    observation.provider,
    observation.promptDefinitionId,
    observation.promptVersion,
    observation.language,
    observation.lens,
    observation.intent,
    observation.repeatIndex,
  ].join("|");
}

async function findRunByLabel(label) {
  if (!fs.existsSync(runsRoot)) return null;
  const candidates = [];
  for (const entry of await fsp.readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runFile = path.join(runsRoot, entry.name, "run.json");
    if (!fs.existsSync(runFile)) continue;
    try {
      const run = readJson(runFile);
      if (run.runLabel === label) {
        candidates.push({ run, runFile, mtimeMs: fs.statSync(runFile).mtimeMs });
      }
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

async function resolveRun(pathArg, label) {
  if (pathArg) {
    const candidate = path.resolve(root, pathArg);
    const runFile = fs.statSync(candidate).isDirectory() ? path.join(candidate, "run.json") : candidate;
    return { run: readJson(runFile), runFile };
  }
  const found = await findRunByLabel(label);
  if (!found) throw new Error(`No local visibility run found for label ${label}.`);
  return found;
}

function groupBreakdown(observations, dimension, aggregateVisibility) {
  const groups = new Map();
  for (const observation of observations) {
    const key = dimension === "prompt" ? observation.promptDefinitionId : observation[dimension];
    const normalized = key ?? "unknown";
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push(observation);
  }
  return new Map(
    [...groups.entries()].map(([key, rows]) => [
      key,
      aggregateVisibility(rows.map((row) => row.measurement)),
    ]),
  );
}

function compareBreakdown(beforeObs, afterObs, dimension, aggregateVisibility) {
  const before = groupBreakdown(beforeObs, dimension, aggregateVisibility);
  const after = groupBreakdown(afterObs, dimension, aggregateVisibility);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((key) => {
    const beforeAgg = before.get(key) ?? aggregateVisibility([]);
    const afterAgg = after.get(key) ?? aggregateVisibility([]);
    return {
      key,
      before: beforeAgg,
      after: afterAgg,
      deltaPercentagePoints: deltaMetrics(beforeAgg, afterAgg),
    };
  });
}

async function main() {
  const beforeLabel = readArg("--before-label") || "T0_PRE_CLOCKWORK_FIXES";
  const afterLabel = readArg("--after-label") || "T1_POST_FIXES";
  const beforeResolved = await resolveRun(readArg("--before"), beforeLabel);
  const afterResolved = await resolveRun(readArg("--after"), afterLabel);

  const deterministic = await import(
    pathToFileURL(path.join(root, "packages/services/dist/analysis/deterministicVisibility.js")).href,
  );

  const before = beforeResolved.run;
  const after = afterResolved.run;
  const warnings = [];

  if (before.promptSet?.id !== after.promptSet?.id || before.promptSet?.version !== after.promptSet?.version) {
    warnings.push("Prompt-set id/version differs between cohorts.");
  }

  const beforeMatrix = (before.observations || []).map(executionSignature).sort();
  const afterMatrix = (after.observations || []).map(executionSignature).sort();
  if (JSON.stringify(beforeMatrix) !== JSON.stringify(afterMatrix)) {
    warnings.push("Provider/prompt/repeat execution matrix differs between cohorts.");
  }

  const comparable = warnings.length === 0;
  const beforeAggregate = deterministic.aggregateVisibility(
    (before.observations || []).map((row) => row.measurement),
  );
  const afterAggregate = deterministic.aggregateVisibility(
    (after.observations || []).map((row) => row.measurement),
  );

  const report = {
    schemaVersion: "izi.ai-visibility.local-delta.v1",
    comparable,
    warnings,
    before: {
      runGroupId: before.runGroupId,
      runLabel: before.runLabel,
      runFile: beforeResolved.runFile,
      aggregate: beforeAggregate,
    },
    after: {
      runGroupId: after.runGroupId,
      runLabel: after.runLabel,
      runFile: afterResolved.runFile,
      aggregate: afterAggregate,
    },
    deltaPercentagePoints: comparable ? deltaMetrics(beforeAggregate, afterAggregate) : null,
    breakdowns: comparable
      ? {
          provider: compareBreakdown(before.observations, after.observations, "provider", deterministic.aggregateVisibility),
          language: compareBreakdown(before.observations, after.observations, "language", deterministic.aggregateVisibility),
          lens: compareBreakdown(before.observations, after.observations, "lens", deterministic.aggregateVisibility),
          intent: compareBreakdown(before.observations, after.observations, "intent", deterministic.aggregateVisibility),
          prompt: compareBreakdown(before.observations, after.observations, "prompt", deterministic.aggregateVisibility),
        }
      : null,
  };

  console.log(JSON.stringify(report, null, 2));
  const outputPath = readArg("--output") || path.join(path.dirname(afterResolved.runFile), "delta-report.json");
  await fsp.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  if (!comparable) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
