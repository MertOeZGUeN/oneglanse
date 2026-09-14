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
const promptSet = read("packages/services/src/analysis/promptSet.ts");
const visibilityJobs = read("packages/services/src/agent/visibilityJobs.ts");
const promptRunner = read("apps/agent/src/core/prompt-runner/index.ts");
const retryPolicy = read("apps/agent/src/core/prompt-runner/retryPolicy.ts");
const schema = read("packages/db/clickhouse-init/schema.sql");
const storage = read("packages/services/src/prompt/storePromptResponses.ts");

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
	"versioned prompt sets support repeat and lenses",
	promptSet.includes("repeatCountForPrompt") &&
		promptSet.includes("buildVisibilityPromptExecutions") &&
		promptSet.includes('"general"') &&
		promptSet.includes('"branded"') &&
		promptSet.includes('"comparative"'),
);
check(
	"prompt-set runner queues real provider jobs",
	visibilityJobs.includes("buildVisibilityPromptExecutions") &&
		visibilityJobs.includes("run-provider") &&
		visibilityJobs.includes("readAuthenticatedRuntimeProviders"),
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

const failed = checks.filter((item) => !item.passed);
console.log(`\nIZI AI Visibility static acceptance: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length > 0) process.exit(1);
