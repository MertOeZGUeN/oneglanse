import fs from "node:fs/promises";
import path from "node:path";
import type { Provider, VisibilityRunStatus } from "@oneglanse/types";
import { logger } from "@oneglanse/utils";
import type { Page } from "playwright";

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function evidenceRoot(): string {
	const configured = process.env.IZI_AI_VISIBILITY_EVIDENCE_DIR?.trim();
	return configured || path.resolve(process.cwd(), "data", "ai-visibility-evidence");
}

export async function captureEvidenceScreenshot(args: {
	page: Page;
	provider: Provider;
	workspaceId: string;
	promptId: string;
	status: VisibilityRunStatus;
}): Promise<{ screenshotPath: string | null; capturedAt: string }> {
	const capturedAt = new Date().toISOString();
	const datePart = capturedAt.slice(0, 10);
	const timestampPart = capturedAt.replace(/[:.]/g, "-");
	const dir = path.join(
		evidenceRoot(),
		safeSegment(args.workspaceId),
		safeSegment(args.provider),
		datePart,
	);
	const fileName = `${timestampPart}__${safeSegment(args.promptId)}__${safeSegment(args.status)}.png`;
	const screenshotPath = path.join(dir, fileName);

	try {
		await fs.mkdir(dir, { recursive: true });
		const screenshot = await args.page.screenshot({
			type: "png",
			fullPage: true,
		});
		await fs.writeFile(screenshotPath, screenshot);
		return { screenshotPath, capturedAt };
	} catch (error) {
		logger.warn(
			`failed to capture AI visibility evidence screenshot for ${args.provider}/${args.promptId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { screenshotPath: null, capturedAt };
	}
}
