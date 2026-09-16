import { ExternalServiceError, toErrorMessage } from "@oneglanse/errors";
import { RETRYABLE_ERRORS, logger } from "@oneglanse/utils";
import type { Page } from "playwright";

const ABORTED_NAVIGATION_SETTLE_MS = 5_000;
const ABORTED_NAVIGATION_POLL_MS = 250;

function jitter(baseMs: number, factor = 0.3): number {
	const delta = Math.round(baseMs * factor);
	const min = Math.max(0, baseMs - delta);
	const max = baseMs + delta;
	return Math.round(min + Math.random() * (max - min));
}

function isSameOrigin(currentUrl: string, targetUrl: string): boolean {
	try {
		return new URL(currentUrl).origin === new URL(targetUrl).origin;
	} catch {
		return false;
	}
}

async function recoverSuccessfulAbortedNavigation(
	page: Page,
	targetUrl: string,
	message: string,
): Promise<boolean> {
	if (!message.includes("net::ERR_ABORTED")) return false;

	// A normal Chromium profile attached over CDP can briefly report
	// ERR_ABORTED while startup/session restoration replaces about:blank with
	// the provider route. The URL transition is asynchronous, so an immediate
	// page.url() check is too early. Poll only for the intended provider origin;
	// never accept an abort that lands on another origin.
	const deadline = Date.now() + ABORTED_NAVIGATION_SETTLE_MS;
	let currentUrl = page.url();

	while (Date.now() < deadline && !isSameOrigin(currentUrl, targetUrl)) {
		await page.waitForTimeout(ABORTED_NAVIGATION_POLL_MS);
		currentUrl = page.url();
	}

	if (!isSameOrigin(currentUrl, targetUrl)) return false;

	await page
		.waitForLoadState("domcontentloaded", { timeout: 5_000 })
		.catch(() => {});
	currentUrl = page.url();
	if (!isSameOrigin(currentUrl, targetUrl)) return false;

	logger.warn(
		`navigation reported ERR_ABORTED after reaching provider origin; continuing at ${currentUrl}`,
	);
	return true;
}

export async function navigateWithRetry(
	page: Page,
	url: string,
	options: Parameters<Page["goto"]>[1] = {},
	maxRetries = 3,
	delayMs = 2000,
): Promise<void> {
	// Scope the Referer to just this navigation request (not all sub-resources).
	// page.goto referer option is per-navigation; setExtraHTTPHeaders would
	// leak the header to every subsequent request (images, scripts, etc.).
	let referer = options?.referer;
	if (referer === undefined) {
		try {
			const currentUrl = page.url();
			if (currentUrl && currentUrl !== "about:blank") {
				referer = currentUrl;
			}
			// No synthetic referer injection for cold starts — sending a hardcoded
			// Google referer on every first navigation is a detectable behavioral
			// pattern. Let the browser send no referer (equivalent to a direct
			// address-bar navigation) which is also natural.
		} catch {
			// Non-critical — proceed without referrer
		}
	}

	const gotoOptions = referer !== undefined ? { ...options, referer } : options;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await page.goto(url, gotoOptions);
			return;
		} catch (err) {
			const message = toErrorMessage(err);
			if (await recoverSuccessfulAbortedNavigation(page, url, message)) {
				return;
			}

			// ERR_ABORTED is transient in local normal-browser/CDP startup even when
			// the first origin poll does not settle in time. Retry it like the other
			// known navigation transport errors, but still fail after maxRetries.
			const isRetryable =
				message.includes("net::ERR_ABORTED") ||
				RETRYABLE_ERRORS.some((e) => message.includes(e));

			if (!isRetryable || attempt === maxRetries) {
				throw new ExternalServiceError(
					"navigation",
					message,
					502,
					{ url, attempt },
					err,
				);
			}

			logger.warn(
				`navigation failed (attempt ${attempt}/${maxRetries}): ${message} — retrying in ${Math.round(jitter(delayMs) / 100) / 10}s`,
			);

			await page.waitForTimeout(jitter(delayMs));
		}
	}
}
