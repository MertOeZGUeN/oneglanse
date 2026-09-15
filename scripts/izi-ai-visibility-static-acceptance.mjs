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
	console[passed ? "log" : "error"](`${passed ? "PASS" : "FAIL"}  ${name}${!passed && details ? ` — ${details}` : ""}`);
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
		"each observation must start from a fresh consumer chat",
	);
	check(`${provider}: rendered response extraction configured`, source.includes("extractResponse:"));
	check(`${provider}: source extraction configured`, source.includes("extractSources:"));
}

const packageJson = JSON.parse(read("package.json"));
const serviceIndex = read("packages/services/src/index.ts");
const serviceEnv = read("packages/services/src/env.ts");
const runAnalysis = read("packages/services/src/analysis/runAnalysis.ts");
const deterministic = read("packages/services/src/analysis/deterministicVisibility.ts");
const promptSet = read("packages/services/src/analysis/promptSet.ts");
const promptRunner = read("apps/agent/src/core/prompt-runner/index.ts");
const retryPolicy = read("apps/agent/src/core/prompt-runner/retryPolicy.ts");
const localRunner = read("scripts/run-visibility-local.mjs");
const localAuth = read("scripts/visibility-auth.mjs");
const localAgentRunner = read("apps/agent/src/dockerless/runVisibility.ts");
const localAgentAuth = read("apps/agent/src/dockerless/auth.ts");
const localBootstrap = read("apps/agent/src/dockerless/bootstrap.ts");
const systemAuth = read("apps/agent/src/auth/systemCli.ts");
const systemBrowser = read("apps/agent/src/lib/browser/systemBrowser.ts");
const browserLaunch = read("apps/agent/src/lib/browser/launch.ts");
const preflight = read("scripts/visibility-preflight.mjs");
const delta = read("scripts/compare-visibility-local.mjs");
const frozenAcceptance = JSON.parse(read("config/visibility/gloria-live-acceptance-v1.json"));
const baseline = JSON.parse(read("config/visibility/gloria-baseline-v1.json"));
const profile = JSON.parse(read("config/visibility/gloria-profile-v1.json"));

check("analysis service does not export an LLM client", !serviceIndex.includes("./llm/"));
check(
	"analysis runtime has no model API-key configuration",
	!["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANALYSIS_LLM_PROVIDER"].some((key) => serviceEnv.includes(key)),
);
check(
	"analysis path is deterministic",
	runAnalysis.includes("measureVisibility") && !/["']openai["']|anthropic|analysisPrompt/.test(runAnalysis),
);
check(
	"failed captures excluded from visibility denominator",
	deterministic.includes('item.status === "answered" || item.status === "no_brand"'),
);
check(
	"repeat variability preserved without composite scoring",
	deterministic.includes("summarizeVisibilityRepeatSpread") &&
		deterministic.includes('schemaVersion: "izi.ai-visibility.repeat-spread.v1"'),
);
check(
	"versioned prompt sets preserve canonical ids and repeat metadata",
	promptSet.includes("buildVisibilityPromptExecutions") &&
		promptSet.includes("promptDefinitionId: prompt.id") &&
		promptSet.includes("repeatIndex") &&
		promptSet.includes("repeatTotal"),
);
check(
	"success screenshot evidence captured",
	retryPolicy.includes("captureEvidenceScreenshot") && retryPolicy.includes('status: "answered"'),
);
check(
	"failure states remain explicit observations",
	promptRunner.includes("login_required") && promptRunner.includes("capture_error") && promptRunner.includes("blocked"),
);

check(
	"Dockerless root runner executes real provider agent directly",
	localRunner.includes("src/dockerless/runVisibility.ts") &&
		localRunner.includes("IZI_AI_VISIBILITY_EVIDENCE_DIR") &&
		localRunner.includes("measureVisibility") &&
		!localRunner.includes('runCommand("docker"'),
);
check(
	"Dockerless agent runner reuses createAgent and prompt runner",
	localAgentRunner.includes('import("../core/createAgent.js")') &&
		localAgentRunner.includes('import("../core/prompt-runner/index.js")'),
);
check(
	"Dockerless auth uses an installed consumer browser and persists reusable sessions",
	!localAuth.includes("ensureLocalCamoufoxRuntime") &&
		localAuth.includes("src/dockerless/auth.ts") &&
		localAgentAuth.includes('import("../auth/systemCli.js")') &&
		systemAuth.includes("resolveSystemBrowser") &&
		systemAuth.includes("saveAuthSession") &&
		systemBrowser.includes("Microsoft Edge"),
);
check(
	"Dockerless runtime uses installed browser mode without changing cloud browser behavior",
	localBootstrap.includes('ONEGLANSE_LOCAL_BROWSER_MODE ||= "system"') &&
		browserLaunch.includes("resolveSystemBrowser") &&
		browserLaunch.includes("shouldUseLocalSystemBrowser") &&
		browserLaunch.includes("resolveCamoufoxLaunchOptions"),
);
check(
	"Dockerless bootstrap never requires live infrastructure services",
	localBootstrap.includes("127.0.0.1:9") &&
		localBootstrap.includes('ONEGLANSE_APP_MODE = "local"'),
);
check(
	"preflight is file-backed and declares infrastructure unnecessary",
	preflight.includes('izi.ai-visibility.preflight.v4') &&
		preflight.includes("dockerRequired: false") &&
		preflight.includes("postgresRequired: false") &&
		preflight.includes("clickhouseRequired: false") &&
		preflight.includes("redisRequired: false") &&
		!preflight.includes("packages/services/dist/index.js"),
);
check(
	"local evidence bundle contains raw run, manifest and screenshots",
	localRunner.includes('"run.json"') &&
		localRunner.includes('"evidence-manifest.json"') &&
		localRunner.includes('"screenshots"') &&
		localRunner.includes('izi.ai-visibility.evidence-manifest.v1'),
);
check(
	"acceptance produces provider-specific failures and source gate",
	localRunner.includes("providerAcceptance") &&
		localRunner.includes("ACC-SOURCES-001") &&
		localRunner.includes('"acceptance-report.json"'),
);
check(
	"successful capture can deterministically become no_brand",
	localRunner.includes('status === "answered" ? undefined : status'),
	"answered capture status must not override brand-absence measurement",
);
check(
	"local T0/T1 delta rejects mismatched matrices",
	delta.includes("Prompt-set id/version differs between cohorts") &&
		delta.includes("Provider/prompt/repeat execution matrix differs between cohorts") &&
		delta.includes("comparable"),
);
check(
	"package visibility commands use Dockerless path",
	packageJson.scripts["visibility:auth"] === "node scripts/visibility-auth.mjs" &&
		packageJson.scripts["visibility:preflight"] === "node scripts/visibility-preflight.mjs" &&
		packageJson.scripts["visibility:acceptance"].includes("run-visibility-local.mjs") &&
		packageJson.scripts["visibility:baseline"].includes("run-visibility-local.mjs") &&
		packageJson.scripts["visibility:delta"].includes("compare-visibility-local.mjs"),
);

check(
	"frozen acceptance set contains general and source probes",
	frozenAcceptance.prompts.some((prompt) => prompt.id === "ACC-GENERAL-001") &&
		frozenAcceptance.prompts.some((prompt) => prompt.id === "ACC-SOURCES-001"),
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
check(
	"Gloria profile is explicit and deterministic",
	profile.schemaVersion === "izi.ai-visibility.brand-profile.v1" &&
		profile.brand?.domain === "gloria.com.tr" &&
		profile.properties?.length === 5 &&
		profile.competitors?.length === 7,
);

const failed = checks.filter((item) => !item.passed);
console.log(`\nIZI AI Visibility static acceptance: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length > 0) process.exit(1);
