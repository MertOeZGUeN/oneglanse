import {
	type AskPromptResult,
	type PromptPayload,
	type Provider,
	type VisibilityRunStatus,
	resolveAppMode,
	shouldUseProxyInMode,
} from "@oneglanse/types";
import type { Page } from "playwright";
import {
	IPRefreshNeededError,
	classifyError,
	toErrorMessage,
} from "@oneglanse/errors";
import { logger } from "@oneglanse/utils";
import { env } from "../../env.js";
import { captureEvidenceScreenshot } from "../../lib/evidence/captureScreenshot.js";
import { PROVIDER_CONFIGS } from "../providers/index.js";
import { executePromptWithRetry } from "./retryPolicy.js";

function captureStatusForFailure(
	failureType: ReturnType<typeof classifyError>,
): VisibilityRunStatus {
	if (failureType === "logged_out") return "login_required";
	if (
		failureType === "bot_detection" ||
		failureType === "rate_limited" ||
		failureType === "no_editor"
	) {
		return "blocked";
	}
	return "capture_error";
}

function failedPromptResult(args: {
	userId: string;
	workspaceId: string;
	promptEntry: PromptPayload["prompts"][number];
	status: VisibilityRunStatus;
	screenshotPath?: string | null;
	capturedAt?: string;
}): AskPromptResult {
	return {
		userId: args.userId,
		workspaceId: args.workspaceId,
		promptId: args.promptEntry.id,
		prompt: args.promptEntry.prompt,
		response: "",
		sources: [],
		captureStatus: args.status,
		screenshotPath: args.screenshotPath,
		capturedAt: args.capturedAt,
		visibility: args.promptEntry.visibility,
	};
}

/**
 * Loops over all prompts in the payload and runs each through the retry policy.
 * Capture failures are preserved as explicit observations so they can never be
 * mistaken for a valid answer in which the tracked brand was absent.
 */
export async function runPrompts(
	payload: PromptPayload,
	page: Page,
	provider: Provider,
	onPromptProgress?: (current: number, total: number) => Promise<void>,
): Promise<AskPromptResult[]> {
	const { user_id: userId, workspace_id: workspaceId, prompts: promptsArray } = payload;

	await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});

	const config = PROVIDER_CONFIGS[provider];
	const results: AskPromptResult[] = [];
	const useProxy = shouldUseProxyInMode(resolveAppMode(env.ONEGLANSE_APP_MODE));
	let proxyProven = !useProxy;

	for (let i = 0; i < promptsArray.length; i++) {
		const promptEntry = promptsArray[i];
		if (!promptEntry) {
			logger.error(`Prompt at index ${i} is undefined.`);
			continue;
		}

		const preview = promptEntry.prompt.slice(0, 60) + (promptEntry.prompt.length > 60 ? "..." : "");
		logger.log(`prompt ${i + 1}/${promptsArray.length} — "${preview}"`);

		await onPromptProgress?.(i + 1, promptsArray.length).catch(() => {});

		let executeResult: { result: AskPromptResult; proxyNowProven: boolean };
		try {
			executeResult = await executePromptWithRetry(
				page,
				promptEntry,
				provider,
				userId,
				workspaceId,
				i,
				promptsArray.length,
				results,
				promptsArray.slice(i),
				proxyProven,
			);
		} catch (err) {
			if (err instanceof IPRefreshNeededError) throw err;

			const failureType = classifyError(err);
			const captureStatus = captureStatusForFailure(failureType);
			const evidence = await captureEvidenceScreenshot({
				page,
				provider,
				workspaceId,
				promptId: promptEntry.id,
				status: captureStatus,
			});
			logger.error(
				`prompt ${i + 1}/${promptsArray.length} failed permanently — recording ${captureStatus}: ${toErrorMessage(err)}`,
			);
			results.push(
				failedPromptResult({
					userId,
					workspaceId,
					promptEntry,
					status: captureStatus,
					screenshotPath: evidence.screenshotPath,
					capturedAt: evidence.capturedAt,
				}),
			);

			if (captureStatus === "login_required") {
				for (const remaining of promptsArray.slice(i + 1)) {
					results.push(
						failedPromptResult({
							userId,
							workspaceId,
							promptEntry: remaining,
							status: "login_required",
							capturedAt: evidence.capturedAt,
						}),
					);
				}
				break;
			}

			const hasMorePrompts = i < promptsArray.length - 1;
			if (config.betweenPromptsHook && hasMorePrompts) {
				await config.betweenPromptsHook(page).catch(() => {});
			}
			continue;
		}

		const { result, proxyNowProven } = executeResult;
		results.push(result);
		if (proxyNowProven) proxyProven = true;

		const hasMorePrompts = i < promptsArray.length - 1;
		if (config.betweenPromptsHook && hasMorePrompts) {
			await config.betweenPromptsHook(page);
		}
	}

	logger.success(`recorded ${results.length}/${promptsArray.length} prompt observations`);
	return results;
}
