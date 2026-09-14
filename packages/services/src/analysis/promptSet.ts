import { randomUUID } from "node:crypto";
import type {
	PromptPayload,
	VisibilityPromptDefinition,
	VisibilityPromptSet,
} from "@oneglanse/types";
import { z } from "zod";

const PromptDefinitionSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1),
	language: z.string().min(2),
	lens: z.enum(["general", "branded", "comparative"]),
	intent: z.string().min(1),
	prompt: z.string().min(1),
	enabled: z.boolean().optional(),
	repeat: z.number().int().min(1).max(10).optional(),
});

const PromptSetSchema = z.object({
	schemaVersion: z.literal("izi.ai-visibility.prompt-set.v1"),
	id: z.string().min(1),
	version: z.string().min(1),
	name: z.string().min(1),
	defaultRepeat: z.number().int().min(1).max(10),
	prompts: z.array(PromptDefinitionSchema).min(1),
});

export function parseVisibilityPromptSet(input: unknown): VisibilityPromptSet {
	const parsed = PromptSetSchema.parse(input);
	const seen = new Set<string>();
	for (const prompt of parsed.prompts) {
		if (seen.has(prompt.id)) {
			throw new Error(`Duplicate prompt id: ${prompt.id}`);
		}
		seen.add(prompt.id);
	}
	return parsed as VisibilityPromptSet;
}

export function enabledVisibilityPrompts(
	promptSet: VisibilityPromptSet,
): VisibilityPromptDefinition[] {
	return promptSet.prompts.filter((prompt) => prompt.enabled !== false);
}

export function repeatCountForPrompt(
	promptSet: VisibilityPromptSet,
	prompt: VisibilityPromptDefinition,
): number {
	return prompt.repeat ?? promptSet.defaultRepeat;
}

export function createVisibilityRunGroupId(): string {
	return randomUUID();
}

export function buildVisibilityPromptExecutions(
	promptSet: VisibilityPromptSet,
	runGroupId = createVisibilityRunGroupId(),
	options?: { runLabel?: string },
): PromptPayload["prompts"] {
	const executions: PromptPayload["prompts"] = [];
	const runLabel = options?.runLabel?.trim() || undefined;

	for (const prompt of enabledVisibilityPrompts(promptSet)) {
		const repeatTotal = repeatCountForPrompt(promptSet, prompt);
		for (let repeatIndex = 1; repeatIndex <= repeatTotal; repeatIndex++) {
			executions.push({
				id: `${prompt.id}::${runGroupId}::r${repeatIndex}`,
				prompt: prompt.prompt,
				visibility: {
					runGroupId,
					runLabel,
					promptSetId: promptSet.id,
					promptSetVersion: promptSet.version,
					promptDefinitionId: prompt.id,
					promptVersion: prompt.version,
					language: prompt.language,
					lens: prompt.lens,
					intent: prompt.intent,
					repeatIndex,
					repeatTotal,
				},
			});
		}
	}

	return executions;
}
