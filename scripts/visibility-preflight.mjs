import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseProviders(raw) {
  const supported = new Set(["chatgpt", "claude", "gemini", "perplexity"]);
  const values = (raw || "chatgpt,claude,gemini,perplexity")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !supported.has(value));
  if (invalid.length) throw new Error(`Unsupported provider(s): ${invalid.join(", ")}`);
  return [...new Set(values)];
}

async function resolveIdentity(services) {
  const explicitWorkspaceId = readArg("--workspace") || process.env.IZI_VISIBILITY_WORKSPACE_ID;
  const explicitUserId = readArg("--user") || process.env.IZI_VISIBILITY_USER_ID;

  if (Boolean(explicitWorkspaceId) !== Boolean(explicitUserId)) {
    throw new Error("Pass both --workspace and --user together, or omit both for domain resolution.");
  }

  if (explicitWorkspaceId && explicitUserId) {
    return { workspaceId: explicitWorkspaceId, userId: explicitUserId, resolvedBy: "explicit" };
  }

  const domain =
    readArg("--domain") || process.env.IZI_VISIBILITY_WORKSPACE_DOMAIN || "gloria.com.tr";
  const resolved = await services.resolveVisibilityRunIdentityByDomain({ domain });
  return { ...resolved, resolvedBy: `domain:${domain}` };
}

async function main() {
  const servicesEntry = path.resolve(root, "packages/services/dist/index.js");
  if (!fs.existsSync(servicesEntry)) {
    throw new Error(
      "packages/services/dist/index.js is missing. Run through the package script so workspace services are built first.",
    );
  }

  const services = await import(pathToFileURL(servicesEntry).href);
  const requestedProviders = parseProviders(readArg("--providers"));
  const identity = await resolveIdentity(services);
  const workspace = await services.getWorkspaceById({ workspaceId: identity.workspaceId });
  const workspaceEnabled = workspace.enabledProviders;

  const permittedProviders = requestedProviders.filter((provider) => {
    if (!workspaceEnabled) return true;
    const authProvider = services.getAuthProviderForRuntimeProvider(provider);
    return workspaceEnabled.includes(authProvider);
  });
  const disabledProviders = requestedProviders.filter(
    (provider) => !permittedProviders.includes(provider),
  );
  const authenticatedProviders =
    await services.readAuthenticatedRuntimeProviders(permittedProviders);
  const missingAuthProviders = permittedProviders.filter(
    (provider) => !authenticatedProviders.includes(provider),
  );

  const report = {
    schemaVersion: "izi.ai-visibility.preflight.v1",
    workspace: {
      id: workspace.id,
      name: workspace.name,
      domain: workspace.domain,
      resolvedBy: identity.resolvedBy,
    },
    userId: identity.userId,
    requestedProviders,
    permittedProviders,
    authenticatedProviders,
    disabledProviders,
    missingAuthProviders,
    authStorage: services.getAuthStorageDiagnostics(),
    pass: disabledProviders.length === 0 && missingAuthProviders.length === 0,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
