import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const localAppUrl = "http://localhost:3000";

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

async function bootstrapLocalEnv() {
  const runtimeEntry = path.resolve(root, "scripts/lib/runtime.mjs");
  const runtime = await import(pathToFileURL(runtimeEntry).href);
  await runtime.ensureEnvFiles();
  const localEnv = runtime.buildLocalRuntimeEnv(localAppUrl);
  for (const [key, value] of Object.entries(localEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
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

function providerReason({ permitted, authenticated, authStatus }) {
  if (!permitted) return "disabled_in_workspace";
  if (authenticated) return "ready";
  if (authStatus?.connecting) return "auth_in_progress";
  if (authStatus?.error) return "auth_error";
  if (!authStatus?.connected) return "login_required";
  if (!authStatus?.synced) return "session_not_ready";
  return "runtime_auth_unavailable";
}

function toMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  await bootstrapLocalEnv();

  const servicesEntry = path.resolve(root, "packages/services/dist/index.js");
  if (!fs.existsSync(servicesEntry)) {
    throw new Error(
      "packages/services/dist/index.js is missing. Run through the package script so workspace services are built first.",
    );
  }

  const services = await import(pathToFileURL(servicesEntry).href);
  const requestedProviders = parseProviders(readArg("--providers"));
  const authStatuses = await services.readProviderAuthStatuses();

  let identity = null;
  let workspace = null;
  let workspaceError = null;

  try {
    identity = await resolveIdentity(services);
    workspace = await services.getWorkspaceById({ workspaceId: identity.workspaceId });
  } catch (error) {
    workspaceError = toMessage(error);
  }

  const workspaceEnabled = workspace?.enabledProviders ?? null;
  const permittedProviders = requestedProviders.filter((provider) => {
    if (!workspace) return true;
    if (!workspaceEnabled) return true;
    const authProvider = services.getAuthProviderForRuntimeProvider(provider);
    return workspaceEnabled.includes(authProvider);
  });
  const disabledProviders = workspace
    ? requestedProviders.filter((provider) => !permittedProviders.includes(provider))
    : [];
  const authenticatedProviders =
    await services.readAuthenticatedRuntimeProviders(permittedProviders);
  const missingAuthProviders = permittedProviders.filter(
    (provider) => !authenticatedProviders.includes(provider),
  );

  const providers = requestedProviders.map((provider) => {
    const authProvider = services.getAuthProviderForRuntimeProvider(provider);
    const authStatus = authStatuses.find((item) => item.provider === authProvider) || null;
    const permitted = permittedProviders.includes(provider);
    const authenticated = authenticatedProviders.includes(provider);
    const reason = providerReason({ permitted, authenticated, authStatus });
    return {
      provider,
      authProvider,
      permitted,
      authenticated,
      status: reason === "ready" ? "ready" : "not_ready",
      reason,
      lastUpdatedAt: authStatus?.lastUpdatedAt ?? null,
      syncedAt: authStatus?.syncedAt ?? null,
      authError: authStatus?.error ?? null,
      nextAction:
        reason === "ready"
          ? null
          : reason === "disabled_in_workspace"
            ? "Enable this provider for the Gloria workspace."
            : reason === "auth_in_progress"
              ? "Finish the interactive login window, then run preflight again."
              : "Run `pnpm auth`, connect this provider in the local Providers screen, then run preflight again.",
    };
  });

  const workspaceReady = Boolean(workspace && identity);
  const report = {
    schemaVersion: "izi.ai-visibility.preflight.v3",
    runtime: {
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      databaseReady: workspaceReady,
      databaseOrWorkspaceError: workspaceError,
    },
    workspace: workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          domain: workspace.domain,
          resolvedBy: identity?.resolvedBy ?? null,
        }
      : null,
    userId: identity?.userId ?? null,
    requestedProviders,
    permittedProviders,
    authenticatedProviders,
    disabledProviders,
    missingAuthProviders,
    providers,
    authStorage: services.getAuthStorageDiagnostics(),
    nextAction: !workspaceReady
      ? "Start the local OneGlanse runtime with `pnpm local` when you are ready to create/use the Gloria workspace. Provider login readiness can still be inspected above."
      : providers.some((provider) => provider.status !== "ready")
        ? "Run `pnpm auth`, finish missing provider logins, then rerun preflight."
        : "Ready for `pnpm visibility:acceptance`.",
    pass: workspaceReady && providers.every((provider) => provider.status === "ready"),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
