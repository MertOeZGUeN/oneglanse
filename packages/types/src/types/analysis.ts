import type { BrandMetricMap } from "./metrics.js";
import type { Source } from "./sources.js";
import type {
	VisibilityMeasurementResult,
	VisibilityPromptExecutionMeta,
	VisibilityRunStatus,
	VisibilityTrackedEntity,
} from "./visibility.js";

export interface AnalysisFilters {
	modelFilter?: string;
	timeFilter?: "all" | "7d" | "14d" | "30d";
	promptId?: string;
}

export interface AnalysisInputSingle {
	brandDomain: string;
	brandName: string;
	brandAliases?: string[];
	response: string;
	prompt: string;
	sources?: Source[];
	properties?: VisibilityTrackedEntity[];
	competitors?: VisibilityTrackedEntity[];
	captureStatus?: Exclude<VisibilityRunStatus, "answered" | "no_brand">;
}

export interface BrandAnalysisResult {
	metadata?: {
		brandName: string;
		brandDomain: string;
		analysisMode?: "llm" | "deterministic-v1";
		legacyCompositeDisabled?: boolean;
	};

	geoScore: {
		overall: number;
	};

	presence: {
		mentioned: boolean;
		visibility: number;
	};

	position: {
		rankPosition: number | null;
	};

	sentiment: {
		score: number;
	};

	recommendation: {
		type:
			| "top_pick"
			| "strong_alternative"
			| "conditional"
			| "mentioned_only"
			| "discouraged"
			| "not_mentioned";
	};

	competitors: {
		name: string;
		domain: string;
		visibility: number;
		sentiment: number;
		rankPosition: number | null;
		isRecommended: boolean;
	}[];

	perception: {
		coreClaims: string[];
		differentiators: string[];
		bestKnownFor: string | null;
		pricingPerception:
			| "premium"
			| "mid_range"
			| "budget"
			| "free"
			| "not_mentioned";
	};

	risks: {
		items: {
			severity: "critical" | "warning" | "info";
		}[];
	};

	measurement?: VisibilityMeasurementResult;
}

export interface AnalysisModelInput {
	model_provider: string;
	response: string;
}

export interface PromptAnalysis {
	id: string;
	prompt_id: string;
	workspace_id: string;
	user_id: string;
	model_provider: string;
	prompt: string;
	brand_analysis: string;
	prompt_run_at: string;
	created_at: string;
}

export interface AnalysisRecord {
	id: string;
	prompt_id: string;
	prompt_run_at: string;
	prompt: string;
	user_id: string;
	workspace_id: string;
	model_provider: string;
	response: string;
	sources: Source[];
	capture_status?: VisibilityRunStatus;
	screenshot_path?: string;
	captured_at?: string;
	visibility_metadata?: VisibilityPromptExecutionMeta;
	brand_analysis?: BrandAnalysisResult;
	is_analysed?: boolean;
	created_at: string;
}

export interface AnalysisMetadata {
	available_brands: Array<{
		name: string;
		website: string;
	}>;
	available_models: string[];
}

export interface AnalysisResponse {
	records: AnalysisRecord[];
	metadata: AnalysisMetadata;
}

export interface AnalysisRow {
	id: string;
	prompt_id: string;
	prompt_run_at: string;
	user_id: string;
	workspace_id: string;
	model_provider: string;
	response: string;
	brand_metrics: string | BrandMetricMap;
	sources: Source[];
	created_at: string;
}
