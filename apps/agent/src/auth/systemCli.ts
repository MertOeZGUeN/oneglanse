import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
	ensureAuthDirectories,
	getAgentAuthRootDir,
	readPersistedAuthStatus,
	saveAuthSession,
	saveReusableIdentitySessions,
	uploadAuthSession,
	writeProviderAuthStatus,
} from "@oneglanse/services";
import { AUTH_PROVIDER_LIST, type AuthProvider } from "@oneglanse/types";
import {
	AUTH_PROVIDER_CONFIG,
	getProviderDisplayName,
} from "@oneglanse/utils";
import { chromium } from "playwright-core";
import { resolveSystemBrowser } from "../lib/browser/systemBrowser.js";

const PROFILE_CAPTURE_RETRIES = 5;
const PROFILE_CAPTURE_RETRY_MS = 1_000;

function parseProviderArg(argv: string[]): AuthProvider {
	const index = argv.indexOf("--provider");
	const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
	if (!value || !AUTH_PROVIDER_LIST.includes(value as AuthProvider)) {
		throw new Error(`--provider must be one of: ${AUTH_PROVIDER_LIST.join(", ")}`);
	}
	return value as AuthProvider;
}

function resolveAuthEntryUrl(provider: AuthProvider): string {
	const authConfig = AUTH_PROVIDER_CONFIG[provider];
	if (provider === "chatgpt") {
		return authConfig.postLoginUrls[0] || "https://chatgpt.com/";
	}
	return authConfig.loginUrl;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesDomainSuffix(domain: string, suffixes: readonly string[]): boolean {
	const normalized = domain.replace(/^\./, "").toLowerCase();
	return suffixes.some(
		(suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
	);
}

async function waitForUserConfirmation(providerName: string): Promise<void> {
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		await prompt.question(
			`[auth] Sign in to ${providerName} in the opened normal browser. When the signed-in home screen is visible, close that auth browser window, then press Enter here to capture the session...`,
		);
	} finally {
		prompt.close();
	}
}

async function captureProfileStorageState(
	profileDir: string,
	executablePath: string,
): Promise<Awaited<ReturnType<import("playwright-core").BrowserContext["storageState"]>>> {
	let lastError: unknown = null;

	for (let attempt = 1; attempt <= PROFILE_CAPTURE_RETRIES; attempt += 1) {
		try {
			const context = await chromium.launchPersistentContext(profileDir, {
				executablePath,
				headless: true,
				args: [
					"--disable-background-mode",
					"--no-first-run",
					"--no-default-browser-check",
				],
			});
			try {
				return await context.storageState();
			} finally {
				await context.close().catch(() => {});
			}
		} catch (error) {
			lastError = error;
			if (attempt < PROFILE_CAPTURE_RETRIES) {
				await sleep(PROFILE_CAPTURE_RETRY_MS);
			}
		}
	}

	const detail = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(
		`Could not reopen the dedicated auth profile to capture its session. Make sure the auth browser window is fully closed, then retry. Last error: ${detail}`,
	);
}

async function runAuthLogin(provider: AuthProvider): Promise<void> {
	const authConfig = AUTH_PROVIDER_CONFIG[provider];
	const runtimeProvider = authConfig.providers[0];
	if (!runtimeProvider) {
		throw new Error(`No runtime provider is configured for ${provider}.`);
	}

	ensureAuthDirectories();
	const resolvedBrowser = resolveSystemBrowser();
	if (resolvedBrowser.engine !== "chromium") {
		throw new Error(
			"Dockerless manual auth currently requires Microsoft Edge or Google Chrome. Set ONEGLANSE_SYSTEM_BROWSER_EXECUTABLE to an installed Edge/Chrome executable.",
		);
	}

	const profileDir = path.join(
		getAgentAuthRootDir(),
		"native-profiles",
		provider,
	);
	mkdirSync(profileDir, { recursive: true });
	const entryUrl = resolveAuthEntryUrl(provider);

	console.log(
		`[auth] Using installed ${resolvedBrowser.label}: ${resolvedBrowser.executablePath}`,
	);
	console.log(`[auth] Dedicated profile: ${profileDir}`);
	console.log(
		"[auth] Manual login browser is launched directly by Windows, not by Playwright. No CAPTCHA/challenge is automated or bypassed.",
	);

	const child = spawn(
		resolvedBrowser.executablePath,
		[
			`--user-data-dir=${profileDir}`,
			"--disable-background-mode",
			"--no-first-run",
			"--no-default-browser-check",
			"--new-window",
			entryUrl,
		],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		},
	);
	child.unref();

	const providerName = getProviderDisplayName(runtimeProvider);
	await waitForUserConfirmation(providerName);
	await sleep(750);

	const latestState = await captureProfileStorageState(
		profileDir,
		resolvedBrowser.executablePath,
	);
	const providerCookies = latestState.cookies.filter((cookie) =>
		matchesDomainSuffix(cookie.domain, authConfig.domainSuffixes),
	);
	const providerOrigins = latestState.origins.filter((originEntry) => {
		try {
			return matchesDomainSuffix(
				new URL(originEntry.origin).hostname,
				authConfig.domainSuffixes,
			);
		} catch {
			return false;
		}
	});

	if (providerCookies.length === 0 && providerOrigins.length === 0) {
		throw new Error(
			`${providerName} profile contains no provider session data. Complete the login in the opened browser before pressing Enter.`,
		);
	}

	await saveReusableIdentitySessions(latestState);
	const savedState = await saveAuthSession(provider, latestState);
	await uploadAuthSession(provider, savedState);
	console.log(
		`[auth] Captured ${providerName} session (${providerCookies.length} provider cookies, ${providerOrigins.length} provider origins).`,
	);
}

const provider = parseProviderArg(process.argv.slice(2));
runAuthLogin(provider)
	.then(() => process.exit(0))
	.catch(async (error) => {
		const runtimeProvider = AUTH_PROVIDER_CONFIG[provider].providers[0];
		const providerName = runtimeProvider
			? getProviderDisplayName(runtimeProvider)
			: provider;
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error(`[auth] ${providerName} login failed:`, error);
		const existingStatus = await readPersistedAuthStatus(provider).catch(
			() => null,
		);
		await writeProviderAuthStatus(provider, {
			connecting: false,
			lastUpdatedAt: new Date().toISOString(),
			syncedAt: existingStatus?.syncedAt ?? null,
			error: errorMessage,
			launcherPid: null,
		}).catch(() => {});
		process.exit(1);
	});
