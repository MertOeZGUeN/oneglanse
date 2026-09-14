import type { Source } from "./sources.js";

export type VisibilityRunStatus =
	| "answered"
	| "no_brand"
	| "no_answer"
	| "blocked"
	| "login_required"
	| "capture_error";

export type VisibilityLens = "general" | "branded" | "comparative";

export interface VisibilityTrackedEntity {
	name: string;
	aliases?: string[];
	domain?: string;
}

export interface VisibilityPromptExecutionMeta {
	runGroupId: string;
	promptSetId: string;
	promptSetVersion: string;
	promptVersion: string;
	language: string;
	lens: VisibilityLens;
	intent: string;
	repeatIndex: number;
	repeatTotal: number;
}

export interface VisibilityPromptDefinition {
	id: string;
	version: string;
	language: string;
	lens: VisibilityLens;
	intent: string;
	prompt: string;
	enabled?: boolean;
	repeat?: number;
}

export interface VisibilityPromptSet {
	schemaVersion: "izi.ai-visibility.prompt-set.v1";
	id: string;
	version: string;
	name: string;
	defaultRepeat: number;
	prompts: VisibilityPromptDefinition[];
}

export interface VisibilityMeasurementInput {
	prompt: string;
	response: string;
	sources?: Source[];
	brand: VisibilityTrackedEntity;
	properties?: VisibilityTrackedEntity[];
	competitors?: VisibilityTrackedEntity[];
	captureStatus?: Exclude<VisibilityRunStatus, "answered" | "no_brand">;
}

export interface VisibilityEntityMention {
	name: string;
	count: number;
	firstIndex: number | null;
	rankPosition: number | null;
}

export interface VisibilityMeasurementResult {
	schemaVersion: "izi.ai-visibility.observation.v1";
	analysisMode: "deterministic";
	status: VisibilityRunStatus;
	prompt: string;
	brand: {
		name: string;
		domain: string | null;
		mentioned: boolean;
		mentionCount: number;
		firstIndex: number | null;
		rankPosition: number | null;
		top3Presence: boolean;
		ownedDomainCited: boolean;
	};
	properties: VisibilityEntityMention[];
	competitors: VisibilityEntityMention[];
	citations: {
		urls: string[];
		domains: string[];
	};
}

export interface VisibilityAggregateResult {
	schemaVersion: "izi.ai-visibility.aggregate.v1";
	eligibleObservations: number;
	mentionRate: number;
	citationRate: number;
	top3PresenceRate: number;
	shareOfVoice: number;
	sourceDistribution: Array<{ domain: string; count: number }>;
}
