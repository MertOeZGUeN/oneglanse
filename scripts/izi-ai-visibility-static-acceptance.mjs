import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const checks = [];

function read(relativePath) {
	return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function check(name, predicate, details) {
	const passed = Boolean(predicate);
	checks.push({ name, passed, details });
	if (!passed) {
		console.error(`FAIL  ${name}${details ? ` — ${details}` : ""}`);
	} else {
		console.log(`PASS  ${name}`);
	}
}

const providers = [
	["chatgpt", "resetChatgptPage"],
	["claude", "resetClaudePage"],
	["gemini", "resetGeminiPage"],
	["perplexity", "resetPerplexityPage"],
];

for (const [provider, resetFunction] of providers) {
	const source = read(`apps/agent/src/core/providers/${provider}/index.ts`);
	check(
		`${provider}: clean chat between prompts`,
		source.includes(`betweenPromptsHook: ${resetFunction}`),
		"each visibility observation must start from a fresh consumer chat",
	);
	check(
		`${provider}: rendered response extraction configured`,
		source.includes("extractResponse:"),
		"provider must capture the rendered consumer response",
	);
	check(
		`${provider}: source extraction configured`,
		source.includes("extractSources:"),
		"provider must expose citations/sources",
	);
}

const serviceIndex = read("packages/services/src/index.ts");
const serviceEnv = read("packages/services/src/env.ts");
const runAnalysis = read("packages/services/src/analysis/runAnalysis.ts");
const deterministic = read("packages/services/src/analysis/deterministicVisibility.ts");
const visibilityDelta = read("packages/services/src/analysis/visibilityDelta.ts");
const promptSet = read("packages/services/src/analysis/promptSet.ts");
const visibilityJobs = read("packages/services/src/agent/visibilityJobs.ts");
const promptRunner = read("apps/agent/src/core/prompt-runner/index.ts");
const retryPolicy = read("apps/agent/src/core/prompt-runner/retryPolicy.ts");
const schema = read("packages/db/clickhouse-init/schema.sql");
const storage = read("packages/services/src/prompt/storePromptResponses.ts");
const liveRunner = read("scripts/run-visibility-prompt-set.mjs");
const preflightRunner = read("scripts/visibility-preflight.mjs");
const deltaRunner = read("scripts/compare-visibility-runs.mjs");
const frozenAcceptance = read("config/visibility/gloria-live-acceptance-v1.json");
const baseline = JSON.parse(read("config/visibility/gloria-baseline-v1.json"));

check("analysis service does not export an LLM client", !serviceIndex.includes("./llm/"));
check(
	"analysis runtime has no model API-key configuration",
	!["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANALYSIS_LLM_PROVIDER"].some((key) =>
		serviceEnv.includes(key),
	),
);
check(
	"analysis path is deterministic",
	runAnalysis.includes("measureVisibility") &&
		!/["']openai["']|anthropic|analysisPrompt/.test(runAnalysis),
);
check(
	"failed captures excluded from visibility denominator",
	deterministic.includes('item.status === "answered" || item.status === "no_brand"'),
);
check(
	"repeat variability is preserved without composite scoring",
	deterministic.includes("summarizeVisibilityRepeatSpread") &&
		deterministic.includes('schemaVersion: "izi.ai-visibility.repeat-spread.v1"'),
);
check(
	"versioned prompt sets support repeat and lenses",
	promptSet.includes("repeatCountForPrompt") &&
		promptSet.includes("buildVisibilityPromptExecutions") &&
		promptSet.includes("promptDefinitionId: prompt.id") &&
		promptSet.includes('"general"') &&
		promptSet.includes('"branded"') &&
		promptSet.includes('"comparative"'),
);
check(
	"prompt-set runner queues real provider jobs",
	visibilityJobs.includes("buildVisibilityPromptExecutions") &&
		visibilityJobs.includes("run-provider") &&
		visibilityJobs.includes("readAuthenticatedRuntimeProviders") &&
		visibilityJobs.includes("runLabel: args.runLabel"),
);
check(
	"domain resolver refuses ambiguous local identity",
	visibilityJobs.includes("resolveVisibilityRunIdentityByDomain") &&
		visibilityJobs.includes("Multiple active workspaces found") &&
		visibilityJobs.includes("multiple active members"),
);
check(
	"success screenshot evidence captured",
	retryPolicy.includes("captureEvidenceScreenshot") && retryPolicy.includes('status: "answered"'),
);
check(
	"failure screenshot evidence captured",
	promptRunner.includes("captureEvidenceScreenshot") &&
		promptRunner.includes("login_required") &&
		promptRunner.includes("capture_error") &&
		promptRunner.includes("blocked"),
);
check(
	"evidence and run metadata persisted",
	["capture_status", "screenshot_path", "visibility_metadata"].every(
		(field) => schema.includes(field) && storage.includes(field),
	),
);
check(
	"live acceptance runner is wired to versioned prompt jobs",
	liveRunner.includes("submitVisibilityPromptSetJobGroup") &&
		liveRunner.includes("fetchAnalysedPrompts") &&
		liveRunner.includes("sourceSurfacePass") &&
		liveRunner.includes('readArg("--run-label")'),
);
check(
	"live runner writes evidence manifest and provider matrix",
	liveRunner.includes('izi.ai-visibility.evidence-manifest.v1') &&
		liveRunner.includes('"evidence-manifest.json"') &&
		liveRunner.includes('"acceptance-report.json"') &&
		liveRunner.includes("providers: report.providers"),
);
check(
	"preflight exposes provider-specific readiness reasons",
	preflightRunner.includes('izi.ai-visibility.preflight.v2') &&
		preflightRunner.includes('"disabled_in_workspace"') &&
		preflightRunner.includes('"login_required"') &&
		preflightRunner.includes('"auth_error"') &&
		preflightRunner.includes('"ready"'),
);
check(
	"local runner can auto-resolve Gloria identity by domain",
	liveRunner.includes("resolveVisibilityRunIdentityByDomain") &&
		liveRunner.includes('IZI_VISIBILITY_WORKSPACE_DOMAIN') &&
		liveRunner.includes('"gloria.com.tr"') &&
		liveRunner.includes("Pass both --workspace and --user together"),
);
check(
	"T0/T1 delta rejects mismatched execution matrices",
	visibilityDelta.includes("compareVisibilityCohorts") &&
		visibilityDelta.includes("Prompt-set id/version differs between cohorts") &&
		visibilityDelta.includes("Provider/prompt/repeat execution matrix differs between cohorts") &&
		visibilityDelta.includes("deltaPercentagePoints"),
);
check(
	"delta CLI compares labeled stored cohorts",
	deltaRunner.includes("compareVisibilityCohorts") &&
		deltaRunner.includes("T0_PRE_CLOCKWORK_FIXES") &&
		deltaRunner.includes("T1_POST_FIXES"),
);
check(
	"frozen acceptance set contains general and source probes",
	frozenAcceptance.includes("ACC-GENERAL-001") &&
		frozenAcceptance.includes("ACC-SOURCES-001"),
);
check(
	"Gloria baseline is 4-language x 4-intent and unbranded",
	baseline.prompts.length === 16 &&
		new Set(baseline.prompts.map((prompt) => prompt.language)).size === 4 &&
		new Set(baseline.prompts.map((prompt) => prompt.intent)).size === 4 &&
		baseline.prompts.every((prompt) => !/gloria/i.test(prompt.prompt)),
);
check(
	"Gloria baseline repeats each prompt three times",
	baseline.defaultRepeat === 3 && baseline.prompts.every((prompt) => prompt.repeat === undefined),
);

const failed = checks.filter((item) => !item.passed);
console.log(`\nIZI AI Visibility static acceptance: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length > 0) process.exit(1);
