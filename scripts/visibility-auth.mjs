import process from "node:process";
import {
  buildLocalWorkspacePackages,
  ensureEnvFiles,
  runCommand,
} from "./lib/runtime.mjs";

const SUPPORTED = new Set(["chatgpt", "claude", "gemini", "perplexity"]);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseProviders(raw) {
  const values = (raw || "chatgpt,claude,gemini,perplexity")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !SUPPORTED.has(value));
  if (invalid.length) throw new Error(`Unsupported provider(s): ${invalid.join(", ")}`);
  return [...new Set(values)];
}

async function main() {
  process.env.ONEGLANSE_LOCAL_BROWSER_MODE ||= "system";
  await ensureEnvFiles();
  await buildLocalWorkspacePackages();

  const providers = parseProviders(readArg("--providers"));
  console.log(`Dockerless provider auth: ${providers.join(", ")}`);
  console.log("For each provider, sign in in the visible browser and close the auth window when finished.");

  for (const provider of providers) {
    console.log(`\n=== ${provider.toUpperCase()} AUTH ===`);
    await runCommand("pnpm", [
      "--filter",
      "@oneglanse/agent",
      "exec",
      "node",
      "--loader",
      "ts-node/esm",
      "src/dockerless/auth.ts",
      "--provider",
      provider,
    ]);
  }

  console.log("\nProvider auth flow completed. Run `pnpm visibility:preflight` next.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
