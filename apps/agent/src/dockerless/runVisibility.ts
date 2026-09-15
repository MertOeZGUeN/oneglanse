import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { PromptPayload, Provider } from "@oneglanse/types";
import { configureDockerlessVisibilityEnv } from "./bootstrap.js";

const SUPPORTED_PROVIDERS = new Set<Provider>([
	"chatgpt",
	"claude",
	"gemini",
	"perplexity",
]);

function readArg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const provider = readArg("--provider") as Provider | undefined;
	const inputPath = readArg("--input");
	const outputPath = readArg("--output");

	if (!provider || !SUPPORTED_PROVIDERS.has(provider)) {
		throw new Error(
			"--provider must be one of: chatgpt, claude, gemini, perplexity",
		);
	}
	if (!inputPath || !outputPath) {
		throw new Error("--input and --output are required.");
	}

	configureDockerlessVisibilityEnv();
	const payload = JSON.parse(await fs.readFile(inputPath, "utf8")) as PromptPayload;
	const [{ createAgent }, { runPrompts }] = await Promise.all([
		import("../core/createAgent.js"),
		import("../core/prompt-runner/index.js"),
	]);

	const { page, cleanup } = await createAgent(provider);
	try {
		const results = await runPrompts(payload, page, provider);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, JSON.stringify(results, null, 2), "utf8");
	} finally {
		await cleanup();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
