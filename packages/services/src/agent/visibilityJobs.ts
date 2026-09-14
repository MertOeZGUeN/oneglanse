import { randomUUID } from "node:crypto";
import { db, schema } from "@oneglanse/db";
import { ValidationError, toErrorMessage } from "@oneglanse/errors";
import type {
	PromptPayload,
	Provider,
	VisibilityPromptSet,
} from "@oneglanse/types";
import { PROVIDER_LIST } from "@oneglanse/types";
import { and, eq, isNull } from "drizzle-orm";
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

function normalizeWorkspaceDomain(value: string): string {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return "";
	try {
		const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
		return url.hostname.replace(/^www\./, "");
	} catch {
		return trimmed.replace(/^www\./, "").replace(/\/$/, "");
	}
}

/**
 * Convenience resolver for the local acceptance runner. It only auto-selects when
 * one active workspace and one active member match the requested domain; otherwise
 * callers must pass explicit IDs rather than guessing.
 */
export async function resolveVisibilityRunIdentityByDomain(args: {
	domain: string;
}): Promise<{ workspaceId: string; userId: string }> {
	const targetDomain = normalizeWorkspaceDomain(args.domain);
	if (!targetDomain) throw new ValidationError("Visibility workspace domain is empty.");

	const rows = await db
		.select({
			workspaceId: schema.workspaces.id,
			domain: schema.workspaces.domain,
			userId: schema.workspaceMembers.userId,
		})
		.from(schema.workspaces)
		.innerJoin(
			schema.workspaceMembers,
			eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
		)
		.where(
			and(
				isNull(schema.workspaces.deletedAt),
				isNull(schema.workspaceMembers.deletedAt),
			),
		)
		.execute();

	const matches = rows.filter(
		(row) => normalizeWorkspaceDomain(row.domain) === targetDomain,
	);
	const workspaceIds = [...new Set(matches.map((row) => row.workspaceId))];
	if (workspaceIds.length === 0) {
		throw new ValidationError(`No active workspace found for domain ${targetDomain}.`);
	}
	if (workspaceIds.length > 1) {
		throw new ValidationError(
			`Multiple active workspaces found for domain ${targetDomain}; pass --workspace explicitly.`,
			{ workspaceIds },
		);
	}

	const workspaceId = workspaceIds[0] as string;
	const userIds = [
		...new Set(
			matches.filter((row) => row.workspaceId === workspaceId).map((row) => row.userId),
		),
	];
	if (userIds.length === 0) {
		throw new ValidationError(`Workspace ${workspaceId} has no active member.`);
	}
	if (userIds.length > 1) {
		throw new ValidationError(
			`Workspace ${workspaceId} has multiple active members; pass --user explicitly.`,
			{ userIds },
		);
	}

	return { workspaceId, userId: userIds[0] as string };
}

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
	runLabel?: string;
}): Promise<SubmitVisibilityJobResult> {
	const workspace = await getWorkspaceById({ workspaceId: args.workspaceId });
	const allowedProviders = allowedProvidersForWorkspace(
		workspace.enabledProviders,
		args.providers,
	);

	const jobGroupId = randomUUID();
	const prompts = buildVisibilityPromptExecutions(args.promptSet, jobGroupId, {
		runLabel: args.runLabel,
	});
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
