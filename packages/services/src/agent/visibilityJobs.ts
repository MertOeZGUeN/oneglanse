import { randomUUID } from "node:crypto";
import { toErrorMessage } from "@oneglanse/errors";
import type {
	PromptPayload,
	Provider,
	VisibilityPromptSet,
} from "@oneglanse/types";
import { PROVIDER_LIST } from "@oneglanse/types";
import { buildVisibilityPromptExecutions } from "../analysis/promptSet.js";
import { getWorkspaceById } from "../workspace/index.js";
import {
	getAuthProviderForRuntimeProvider,
	getMissingRuntimeProviders,
	readAuthenticatedRuntimeProviders,
} from "./auth.js";
import { buildProviderJobId } from "./jobs.js";
import { updateProviderProgress } from "./progress.js";
import { getProviderQueue } from "./queue.js";
import { redis, waitForRedis } from "./redis.js";

const AGENT_PROGRESS_TTL_SECONDS = 24 * 60 * 60;

export type SubmitVisibilityJobResult =
	| { status: "queued"; jobGroupId: string; runGroupId: string; promptCount: number }
	| { status: "empty" }
	| { status: "no-providers"; disconnectedProviders: Provider[] };

function allowedProvidersForWorkspace(
	enabledProviders: string[] | null | undefined,
	requestedProviders?: Provider[],
): Provider[] {
	const workspaceAllowed = enabledProviders
		? PROVIDER_LIST.filter((provider) =>
				enabledProviders.includes(getAuthProviderForRuntimeProvider(provider)),
			)
		: [...PROVIDER_LIST];

	if (!requestedProviders?.length) return workspaceAllowed;
	const requested = new Set(requestedProviders);
	return workspaceAllowed.filter((provider) => requested.has(provider));
}

async function enqueueVisibilityProviderJob(args: {
	jobGroupId: string;
	provider: Provider;
	prompts: PromptPayload["prompts"];
	userId: string;
	workspaceId: string;
}): Promise<void> {
	const queue = getProviderQueue(args.provider);
	await queue.waitUntilReady();
	const jobId = buildProviderJobId(args.jobGroupId, args.provider);
	const existing = await queue.getJob(jobId);
	if (existing) return;

	await queue.add(
		"run-provider",
		{
			jobGroupId: args.jobGroupId,
			provider: args.provider,
			runProviders: [args.provider],
			prompts: args.prompts,
			user_id: args.userId,
			workspace_id: args.workspaceId,
		},
		{ jobId },
	);
}

async function markProvidersFailed(args: {
	jobGroupId: string;
	providers: Provider[];
}): Promise<void> {
	await Promise.all(
		args.providers.map((provider) =>
			updateProviderProgress({
				jobGroupId: args.jobGroupId,
				provider,
				status: "failed",
				resultCount: 0,
			}),
		),
	);
}

export async function submitVisibilityPromptSetJobGroup(args: {
	workspaceId: string;
	userId: string;
	promptSet: VisibilityPromptSet;
	providers?: Provider[];
}): Promise<SubmitVisibilityJobResult> {
	const workspace = await getWorkspaceById({ workspaceId: args.workspaceId });
	const allowedProviders = allowedProvidersForWorkspace(
		workspace.enabledProviders,
		args.providers,
	);

	const jobGroupId = randomUUID();
	const prompts = buildVisibilityPromptExecutions(args.promptSet, jobGroupId);
	if (prompts.length === 0) return { status: "empty" };

	const authenticatedProviders =
		await readAuthenticatedRuntimeProviders(allowedProviders);
	if (authenticatedProviders.length === 0) {
		return {
			status: "no-providers",
			disconnectedProviders: await getMissingRuntimeProviders(allowedProviders),
		};
	}

	await waitForRedis();
	await redis.set(
		`job:${jobGroupId}:result`,
		JSON.stringify({
			status: "pending" as const,
			updateId: 0,
			providers: Object.fromEntries(
				authenticatedProviders.map((provider) => [provider, "pending"]),
			),
			results: Object.fromEntries(
				authenticatedProviders.map((provider) => [provider, 0]),
			),
			stats: {
				totalPrompts: prompts.length,
				expectedResponses: prompts.length * authenticatedProviders.length,
				actualResponses: 0,
			},
		}),
		"EX",
		AGENT_PROGRESS_TTL_SECONDS,
	);

	void Promise.allSettled(
		authenticatedProviders.map(async (provider) => {
			try {
				await enqueueVisibilityProviderJob({
					jobGroupId,
					provider,
					prompts,
					userId: args.userId,
					workspaceId: args.workspaceId,
				});
			} catch (error) {
				console.error(
					`[ai-visibility] failed to enqueue ${provider}: ${toErrorMessage(error)}`,
				);
				await markProvidersFailed({ jobGroupId, providers: [provider] });
			}
		}),
	);

	return {
		status: "queued",
		jobGroupId,
		runGroupId: jobGroupId,
		promptCount: prompts.length,
	};
}
