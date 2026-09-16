import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { ExternalServiceError, toErrorMessage } from "@oneglanse/errors";
import {
	ensureAuthDirectories,
	getAgentAuthRootDir,
	getRuntimeProfileSeedPlan,
} from "@oneglanse/services";
import {
	type Provider,
	resolveAppMode,
	shouldUseProxyInMode,
} from "@oneglanse/types";
import { logger } from "@oneglanse/utils";
import type { Browser, BrowserContext } from "playwright";
import { chromium, firefox } from "playwright-core";
import { env } from "../../env.js";
import {
	type CamoufoxProxyConfig,
	resolveCamoufoxLaunchOptions,
} from "./camoufox.js";
import { ensureDisplay } from "./display.js";
import type { DisplayHandle } from "./display.js";
import { PlaywrightBrowserContextCompat } from "./playwrightCompat.js";
import {
	type ProxyScheme,
	type UpstreamProxyConfig,
	checkProxyReachable,
} from "./proxy/forwarder.js";
import { resolveSystemBrowser } from "./systemBrowser.js";

const DEFAULT_PROXY_PORT: Record<ProxyScheme, number> = {
	http: 80,
	https: 443,
};
const THORDATA_PROXY_API_TIMEOUT_MS = 10_000;
const LOCAL_CDP_STARTUP_TIMEOUT_MS = 15_000;
const LOCAL_CDP_POLL_MS = 250;
const leasedThorDataProxyUrls = new Set<string>();

let proxyAcquisitionLock = Promise.resolve();

const QUARANTINE_TTL_MS = 10 * 60 * 1000;
const quarantinedProxies = new Map<string, number>();

type FirefoxLaunchOptions = NonNullable<Parameters<typeof firefox.launch>[0]>;
function resolveRuntimeHeadlessMode(): "virtual" | "headful" | "headless" {
	const configuredMode = process.env.CAMOUFOX_HEADLESS_MODE as
		| "virtual"
		| "headful"
		| "headless"
		| undefined;
	if (configuredMode === "headless" || configuredMode === "headful") {
		return configuredMode;
	}

	const appMode = resolveAppMode(env.ONEGLANSE_APP_MODE);
	if (appMode === "local") {
		return "headless";
	}

	if (process.platform === "linux") {
		return "virtual";
	}

	return "headless";
}

function quarantineProxy(hostPort: string): void {
	quarantinedProxies.set(hostPort, Date.now() + QUARANTINE_TTL_MS);
	logger.warn(
		`[proxy-quarantine] ${hostPort} quarantined for ${QUARANTINE_TTL_MS / 60000}min`,
	);
}

function isProxyQuarantined(hostPort: string): boolean {
	const expiry = quarantinedProxies.get(hostPort);
	if (!expiry) return false;
	if (Date.now() >= expiry) {
		quarantinedProxies.delete(hostPort);
		return false;
	}
	return true;
}

type ProxyAllocation = {
	proxy: UpstreamProxyConfig | null;
	release: () => void;
};

function normalizeProxyScheme(protocol: string): ProxyScheme {
	const normalized = protocol.trim().toLowerCase().replace(/:$/, "");

	switch (normalized) {
		case "http":
		case "https":
			return normalized;
		default:
			throw new Error(`unsupported proxy protocol: ${protocol}`);
	}
}

function normalizeProxyHost(hostname: string): string {
	return hostname.replace(/^\[(.*)\]$/, "$1");
}

function formatProxyServerUrl(
	scheme: ProxyScheme,
	host: string,
	port: number,
): string {
	const hostPart =
		host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return `${scheme}://${hostPart}:${port}`;
}

function parseProxyConfig(
	serverUrl: string,
	username?: string,
	password?: string,
): UpstreamProxyConfig {
	const parsed = new URL(serverUrl);
	const scheme = normalizeProxyScheme(parsed.protocol);
	const port = Number(parsed.port || DEFAULT_PROXY_PORT[scheme]);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`invalid proxy port: ${parsed.port}`);
	}

	return {
		scheme,
		host: normalizeProxyHost(parsed.hostname),
		port,
		username,
		password,
		serverUrl: `${scheme}://${parsed.host}`,
		logProxy: `${scheme}://${parsed.host}`,
	};
}

function parseThorDataProxyLine(
	value: string,
): { host: string; port: number } | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	const separator = trimmed.lastIndexOf(":");
	if (separator <= 0 || separator === trimmed.length - 1) {
		return null;
	}

	const host = normalizeProxyHost(trimmed.slice(0, separator));
	const port = Number(trimmed.slice(separator + 1));
	if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
		return null;
	}

	return { host, port };
}

async function acquireThorDataProxyInner(): Promise<ProxyAllocation> {
	const apiUrl = env.THORDATA_PROXY_API_URL?.trim();
	if (!apiUrl) {
		throw new Error(
			"THORDATA_PROXY_API_URL is required when using ThorData API proxy discovery.",
		);
	}

	const response = await fetch(apiUrl, {
		headers: { Accept: "text/plain" },
		signal: AbortSignal.timeout(THORDATA_PROXY_API_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`ThorData proxy API failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
		);
	}

	const proxyLines = (await response.text())
		.split(/\r?\n/)
		.map((line) => parseThorDataProxyLine(line))
		.filter((proxy): proxy is { host: string; port: number } => proxy !== null);

	if (proxyLines.length === 0) {
		throw new Error("ThorData proxy API returned no usable proxies.");
	}

	const scheme = normalizeProxyScheme(env.PROXY_SCHEME?.trim() || "http");
	const candidates = proxyLines
		.map((proxy) => {
			const serverUrl = formatProxyServerUrl(scheme, proxy.host, proxy.port);
			return {
				proxy: parseProxyConfig(serverUrl),
				serverUrl,
				hostPort: `${proxy.host}:${proxy.port}`,
			};
		})
		.filter(
			({ serverUrl, hostPort }) =>
				!leasedThorDataProxyUrls.has(serverUrl) &&
				!isProxyQuarantined(hostPort),
		);

	if (candidates.length === 0) {
		throw new Error(
			"ThorData proxy API returned only proxies that are already leased or quarantined.",
		);
	}

	const selected = candidates[Math.floor(Math.random() * candidates.length)];
	if (!selected) {
		throw new Error("Could not select a ThorData proxy from the API response.");
	}

	leasedThorDataProxyUrls.add(selected.serverUrl);
	return {
		proxy: selected.proxy,
		release: () => {
			leasedThorDataProxyUrls.delete(selected.serverUrl);
		},
	};
}

async function buildProxyAllocationInner(): Promise<ProxyAllocation> {
	if (!shouldUseProxyInMode(resolveAppMode(env.ONEGLANSE_APP_MODE))) {
		return { proxy: null, release: () => {} };
	}
	return acquireThorDataProxyInner();
}

async function buildProxyAllocation(): Promise<ProxyAllocation> {
	const result = proxyAcquisitionLock.then(() => buildProxyAllocationInner());
	proxyAcquisitionLock = result.then(
		() => {},
		() => {},
	);
	return result;
}

function toCamoufoxProxyConfig(
	proxy: UpstreamProxyConfig | null,
): CamoufoxProxyConfig | undefined {
	if (!proxy) return undefined;
	return {
		server: proxy.serverUrl,
		username: proxy.username,
		password: proxy.password,
	};
}

function shouldUseLocalSystemBrowser(appMode: ReturnType<typeof resolveAppMode>): boolean {
	return (
		appMode === "local" &&
		process.env.ONEGLANSE_LOCAL_BROWSER_MODE?.trim().toLowerCase() === "system"
	);
}

async function reserveLocalPort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Could not reserve a local CDP port.")));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

async function waitForCdpEndpoint(endpoint: string): Promise<void> {
	const deadline = Date.now() + LOCAL_CDP_STARTUP_TIMEOUT_MS;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${endpoint}/json/version`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return;
			lastError = new Error(`CDP endpoint returned HTTP ${response.status}.`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, LOCAL_CDP_POLL_MS));
	}
	throw new Error(
		`Timed out waiting for normal browser CDP endpoint ${endpoint}: ${toErrorMessage(lastError)}`,
	);
}

export async function launchContext(provider: Provider): Promise<{
	browser: Browser;
	context: BrowserContext;
	proxy: string | null;
	cleanup: () => Promise<void>;
	invalidateProxyHint: () => Promise<void>;
}> {
	let upstreamProxy: UpstreamProxyConfig | null = null;
	let releaseProxyLease = () => {};
	let invalidateProxyHint: () => Promise<void> = async () => {};
	let displayHandle: DisplayHandle | null = null;
	let rawBrowser: import("playwright-core").Browser | null = null;
	let rawContext: import("playwright-core").BrowserContext | null = null;
	let context: PlaywrightBrowserContextCompat | null = null;
	let localBrowserProcess: ReturnType<typeof spawn> | null = null;

	const cleanup = async () => {
		await context?.close().catch(() => null);
		await rawBrowser?.close().catch(() => null);
		if (localBrowserProcess && localBrowserProcess.exitCode === null) {
			localBrowserProcess.kill();
		}
		releaseProxyLease();
		await displayHandle?.cleanup().catch(() => null);
	};

	try {
		const appMode = resolveAppMode(env.ONEGLANSE_APP_MODE);
		const runtimeHeadlessMode = resolveRuntimeHeadlessMode();
		const useSystemBrowser = shouldUseLocalSystemBrowser(appMode);
		if (shouldUseProxyInMode(appMode)) {
			logger.log("resolving proxy before browser launch");
			const proxyAllocation = await buildProxyAllocation();
			upstreamProxy = proxyAllocation.proxy;
			releaseProxyLease = proxyAllocation.release;
			if (upstreamProxy) {
				logger.log(
					`selected proxy for browser launch: ${upstreamProxy.logProxy}`,
				);
				const reachable = await checkProxyReachable(
					upstreamProxy.host,
					upstreamProxy.port,
				);
				if (!reachable) {
					throw new Error(
						`proxy connect failed: ${upstreamProxy.logProxy} unreachable (TCP pre-check)`,
					);
				}
				const hostPort = `${upstreamProxy.host}:${upstreamProxy.port}`;
				invalidateProxyHint = async () => {
					quarantineProxy(hostPort);
				};
			} else {
				throw new Error(
					"no proxy resolved for browser launch — aborting (direct connection is not allowed)",
				);
			}
		}

		displayHandle =
			!useSystemBrowser && runtimeHeadlessMode !== "headless"
				? await ensureDisplay({ allowExistingDisplay: false })
				: null;
		const display =
			runtimeHeadlessMode === "headless" ? undefined : displayHandle?.display;

		ensureAuthDirectories();
		const runtimeSeedPlan = await getRuntimeProfileSeedPlan(provider);

		if (useSystemBrowser) {
			const resolvedBrowser = resolveSystemBrowser();
			if (resolvedBrowser.engine !== "chromium") {
				throw new Error(
					"Dockerless local visibility runs currently require Microsoft Edge or Google Chrome.",
				);
			}
			const nativeProfileDir = path.join(
				getAgentAuthRootDir(),
				"native-profiles",
				runtimeSeedPlan.authProvider,
			);
			if (!existsSync(nativeProfileDir)) {
				throw new Error(
					`Dedicated consumer profile is missing for ${runtimeSeedPlan.authProvider}. Run visibility:auth again before the visibility test.`,
				);
			}
			if (upstreamProxy) {
				throw new Error(
					"Local normal-browser CDP mode does not support the cloud proxy path.",
				);
			}

			const debugPort = await reserveLocalPort();
			const cdpEndpoint = `http://127.0.0.1:${debugPort}`;
			logger.log(
				`launching normal local ${resolvedBrowser.label} outside Playwright and attaching over CDP (${resolvedBrowser.executablePath})`,
			);
			logger.log(`using dedicated authenticated consumer profile: ${nativeProfileDir}`);
			localBrowserProcess = spawn(
				resolvedBrowser.executablePath,
				[
					`--user-data-dir=${nativeProfileDir}`,
					`--remote-debugging-port=${debugPort}`,
					"--remote-debugging-address=127.0.0.1",
					"--disable-background-mode",
					"--no-first-run",
					"--no-default-browser-check",
					"--new-window",
					"about:blank",
				],
				{
					stdio: "ignore",
					windowsHide: false,
				},
			);
			await waitForCdpEndpoint(cdpEndpoint);
			rawBrowser = await chromium.connectOverCDP(cdpEndpoint);
			rawContext = rawBrowser.contexts()[0] ?? null;
			if (!rawContext) {
				throw new Error("Normal local browser exposed no default CDP context.");
			}
		} else {
			const camoufoxOptions = await resolveCamoufoxLaunchOptions({
				display,
				provider,
				proxy: toCamoufoxProxyConfig(upstreamProxy),
				headlessMode: runtimeHeadlessMode,
			});
			const launchOptions: FirefoxLaunchOptions = {
				...(camoufoxOptions as FirefoxLaunchOptions),
			};
			rawBrowser = await firefox.launch(launchOptions);
			rawContext = await rawBrowser.newContext({
				...(runtimeHeadlessMode === "headless" ? {} : { viewport: null }),
				...(runtimeSeedPlan.authStatePath
					? { storageState: runtimeSeedPlan.authStatePath }
					: {}),
			});
		}

		context = new PlaywrightBrowserContextCompat(rawContext);
		const browser =
			(rawBrowser as unknown as Browser | null) ?? context.getBrowser();

		return {
			browser,
			context,
			proxy: upstreamProxy?.logProxy ?? null,
			cleanup,
			invalidateProxyHint,
		};
	} catch (error) {
		await cleanup();
		throw new ExternalServiceError(
			"browser",
			toErrorMessage(error),
			502,
			{ provider },
			error,
		);
	}
}
