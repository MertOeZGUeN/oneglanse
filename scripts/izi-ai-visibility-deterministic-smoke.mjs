import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const services = await import(
  pathToFileURL(path.resolve(process.cwd(), "packages/services/dist/index.js")).href
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = {
  title: "Gloria Serenity Resort",
  cited_text: "Official resort page",
  url: "https://www.gloria.com.tr/en/hotels/gloria-serenity-resort/",
  domain: "gloria.com.tr",
};

const beforeMeasurement = services.measureVisibility({
  prompt: "Which luxury resorts in Belek are best?",
  response: "Maxx Royal Belek is one option.",
  sources: [],
  brand: { name: "Gloria Hotels & Resorts", aliases: ["Gloria"] , domain: "gloria.com.tr" },
  competitors: [{ name: "Maxx Royal Belek", aliases: ["Maxx Royal"] }],
});

const afterMeasurement = services.measureVisibility({
  prompt: "Which luxury resorts in Belek are best?",
  response: "Gloria Serenity Resort and Maxx Royal Belek are strong options.",
  sources: [source],
  brand: { name: "Gloria Hotels & Resorts", aliases: ["Gloria"], domain: "gloria.com.tr" },
  properties: [{ name: "Gloria Serenity Resort", aliases: ["Gloria Serenity"] }],
  competitors: [{ name: "Maxx Royal Belek", aliases: ["Maxx Royal"] }],
});

assert(beforeMeasurement.status === "no_brand", "before observation should be valid no_brand");
assert(afterMeasurement.status === "answered", "after observation should be answered");
assert(afterMeasurement.brand.mentioned, "Gloria should be detected");
assert(afterMeasurement.brand.ownedDomainCited, "owned citation should be detected");
assert(afterMeasurement.properties[0]?.count === 1, "property mention should be detected once");

const blockedMeasurement = services.measureVisibility({
  prompt: "Which luxury resorts in Belek are best?",
  response: "",
  sources: [],
  brand: { name: "Gloria Hotels & Resorts", aliases: ["Gloria"], domain: "gloria.com.tr" },
  captureStatus: "blocked",
});
const aggregate = services.aggregateVisibility([afterMeasurement, blockedMeasurement]);
assert(aggregate.eligibleObservations === 1, "blocked capture must be excluded from denominator");
assert(aggregate.mentionRate === 100, "eligible mention rate should remain 100");

const spread = services.summarizeVisibilityRepeatSpread([
  beforeMeasurement,
  afterMeasurement,
  blockedMeasurement,
]);
assert(spread.eligibleObservations === 2, "repeat spread should exclude blocked capture");
assert(spread.mentioned.min === 0 && spread.mentioned.max === 1, "repeat mention spread should be 0..1");

function record(label, measurement, promptVersion = "1.0.0") {
  return {
    id: `${label}-1`,
    prompt_id: `EN-GEN-LUX-001::${label}::r1`,
    prompt_run_at: "2026-09-14 12:00:00",
    prompt: measurement.prompt,
    user_id: "u1",
    workspace_id: "w1",
    model_provider: "chatgpt",
    response: "sample",
    sources: [],
    capture_status: measurement.status,
    visibility_metadata: {
      runGroupId: label,
      runLabel: label,
      promptSetId: "gloria-baseline-v1",
      promptSetVersion: "1.0.0",
      promptDefinitionId: "EN-GEN-LUX-001",
      promptVersion,
      language: "en",
      lens: "general",
      intent: "luxury_resort_discovery",
      repeatIndex: 1,
      repeatTotal: 1,
    },
    brand_analysis: { measurement },
    is_analysed: true,
    created_at: "2026-09-14 12:00:00",
  };
}

const before = record("T0_PRE_CLOCKWORK_FIXES", beforeMeasurement);
const after = record("T1_POST_FIXES", afterMeasurement);
const delta = services.compareVisibilityCohorts(
  [before, after],
  "T0_PRE_CLOCKWORK_FIXES",
  "T1_POST_FIXES",
);
assert(delta.comparable, `matching cohorts should be comparable: ${delta.warnings.join("; ")}`);
assert(delta.deltaPercentagePoints.mentionRate === 100, "mention-rate delta should be +100 pp");
assert(delta.deltaPercentagePoints.citationRate === 100, "citation-rate delta should be +100 pp");
assert(delta.breakdowns.some((row) => row.dimension === "provider" && row.key === "chatgpt"), "provider breakdown should exist");

const mismatchedAfter = record("T1_POST_FIXES", afterMeasurement, "2.0.0");
const mismatched = services.compareVisibilityCohorts(
  [before, mismatchedAfter],
  "T0_PRE_CLOCKWORK_FIXES",
  "T1_POST_FIXES",
);
assert(!mismatched.comparable, "prompt-version mismatch must fail comparability");
assert(
  mismatched.warnings.some((warning) => warning.includes("execution matrix")),
  "mismatch should explain execution-matrix incompatibility",
);

console.log("IZI AI Visibility deterministic smoke: PASS");
