import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const workspaceId = readArg("--workspace") || process.env.IZI_VISIBILITY_WORKSPACE_ID;
  const beforeLabel =
    readArg("--before") || process.env.IZI_VISIBILITY_BEFORE_LABEL || "T0_PRE_CLOCKWORK_FIXES";
  const afterLabel =
    readArg("--after") || process.env.IZI_VISIBILITY_AFTER_LABEL || "T1_POST_FIXES";
  const limit = Number(readArg("--limit") || "10000");

  if (!workspaceId) {
    throw new Error(
      "Workspace is required. Pass --workspace or set IZI_VISIBILITY_WORKSPACE_ID.",
    );
  }

  const servicesEntry = path.resolve(root, "packages/services/dist/index.js");
  if (!fs.existsSync(servicesEntry)) {
    throw new Error(
      "packages/services/dist/index.js is missing. Run through the package script so workspace services are built first.",
    );
  }

  const services = await import(pathToFileURL(servicesEntry).href);
  const records = await services.fetchAnalysedPrompts({ workspaceId, limit });
  const comparison = services.compareVisibilityCohorts(records, beforeLabel, afterLabel);
  console.log(JSON.stringify(comparison, null, 2));

  if (!comparison.comparable) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
