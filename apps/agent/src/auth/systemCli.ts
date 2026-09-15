import {
	ensureAuthDirectories,
	readAuthLaunchSeedState,
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
import {
	chromium,
	firefox,
	type Browser,
	type BrowserContext,
	type BrowserContextOptions,
} from "playwright-core";
import { resolveSystemBrowser } from "../lib/browser/systemBrowser.js";

const SNAPSHOT_INTERVAL_MS = 750;
const CLOSE_STABILITY_MS = 1_000;

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

async function waitForAllPagesToClose(
	browser: Browser,
	context: BrowserContext,
): Promise<void> {
	let zeroSince: number | null = null;
	let disconnected = false;
	browser.once("disconnected", () => {
		disconnected = true;
	});

	while (!disconnected) {
		const openPages = context.pages().filter((page) => !page.isClosed()).length;
		if (openPages === 0) {
			zeroSince ??= Date.now();
			if (Date.now() - zeroSince >= CLOSE_STABILITY_MS) return;
		} else {
			zeroSince = null;
		}
		await sleep(200);
	}
}

async function runAuthLogin(provider: AuthProvider): Promise<void> {
	const authConfig = AUTH_PROVIDER_CONFIG[provider];
	const runtimeProvider = authConfig.providers[0];
	if (!runtimeProvider) {
		throw new Error(`No runtime provider is configured for ${provider}.`);
	}

	ensureAuthDirectories();
	const seedState = await readAuthLaunchSeedState(provider);
	const resolvedBrowser = resolveSystemBrowser();
	const browserType = resolvedBrowser.engine === "firefox" ? firefox : chromium;
	console.log(
		`[auth] Using installed ${resolvedBrowser.label}: ${resolvedBrowser.executablePath}`,
	);

	const browser = await browserType.launch({
		executablePath: resolvedBrowser.executablePath,
		headless: false,
	});
	const context = await browser.newContext({
		viewport: null,
		...(seedState
			? {
					storageState:
						seedState as BrowserContextOptions["storageState"],
				}
			: {}),
	});

	let latestState = await context.storageState();
	let snapshotInFlight: Promise<void> | null = null;
	const capture = () => {
		if (snapshotInFlight) return snapshotInFlight;
		snapshotInFlight = context
			.storageState()
			.then((state) => {
				latestState = state;
			})
			.catch(() => {})
			.finally(() => {
				snapshotInFlight = null;
			});
		return snapshotInFlight;
	};
	const interval = setInterval(() => {
		void capture();
	}, SNAPSHOT_INTERVAL_MS);

	try {
		const page = await context.newPage();
		page.on("domcontentloaded", () => void capture());
		page.on("load", () => void capture());
		page.on("close", () => void capture());
		context.on("page", (newPage) => {
			newPage.on("domcontentloaded", () => void capture());
			newPage.on("load", () => void capture());
			newPage.on("close", () => void capture());
		});

		const entryUrl = resolveAuthEntryUrl(provider);
		await page.goto(entryUrl, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
		if (provider === "chatgpt") {
			console.log(
				"[auth] ChatGPT home opened. Click Log in manually in this browser; the script will not force the /auth/login route.",
			);
		}
		console.log(
			`[auth] Sign in to ${getProviderDisplayName(runtimeProvider)} in the opened browser, then close all browser windows from this auth session.`,
		);
		await waitForAllPagesToClose(browser, context);
		await capture();

		if (latestState.cookies.length === 0 && latestState.origins.length === 0) {
			throw new Error(
				`${getProviderDisplayName(runtimeProvider)} sign-in window was closed before a reusable session was captured.`,
			);
		}

		await saveReusableIdentitySessions(latestState);
		const savedState = await saveAuthSession(provider, latestState);
		await uploadAuthSession(provider, savedState);
	} finally {
		clearInterval(interval);
		await context.close().catch(() => {});
		await browser.close().catch(() => {});
	}
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
