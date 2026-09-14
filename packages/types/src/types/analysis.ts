import type { BrandMetricMap } from "./metrics.js";
import type { Source } from "./sources.js";
import type {
	VisibilityMeasurementResult,
	VisibilityRunStatus,
	VisibilityTrackedEntity,
} from "./visibility.js";

export interface AnalysisFilters {
	modelFilter?: string;
	timeFilter?: "all" | "7d" | "14d" | "30d";
	promptId?: string; // For detail view
}

/** Input for single response analysis */
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
	// Metadata is populated by application code.
	metadata?: {
		brandName: string;
		brandDomain: string;
		analysisMode?: "llm" | "deterministic-v1";
		legacyCompositeDisabled?: boolean;
	};

	/**
	 * Legacy OneGlanse headline field retained for compatibility.
	 * In the IZI deterministic fork the legacy composite is disabled and stays 0.
	 */
	geoScore: {
		overall: number;
	};

	/**
	 * PRESENCE — binary visibility for the individual observation in deterministic mode.
	 */
	presence: {
		mentioned: boolean;
		visibility: number;
	};

	/**
	 * POSITION — absolute position among configured tracked brands in reading order.
	 */
	position: {
		rankPosition: number | null;
	};

	/**
	 * Legacy semantic field retained for compatibility. Not measured in deterministic mode.
	 */
	sentiment: {
		score: number;
	};

	/**
	 * Legacy semantic field retained for compatibility. Deterministic mode only reports
	 * mentioned_only / not_mentioned and does not infer recommendation intent.
	 */
	recommendation: {
		type:
			| "top_pick"
			| "strong_alternative"
			| "conditional"
			| "mentioned_only"
			| "discouraged"
			| "not_mentioned";
	};

	/**
	 * COMPETITIVE LANDSCAPE — populated from configured competitors only.
	 */
	competitors: {
		name: string;
		domain: string;
		visibility: number;
		sentiment: number;
		rankPosition: number | null;
		isRecommended: boolean;
	}[];

	/**
	 * Legacy semantic field retained for compatibility. Not inferred in deterministic mode.
	 */
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

	/**
	 * Legacy semantic field retained for compatibility. Not inferred in deterministic mode.
	 */
	risks: {
		items: {
			severity: "critical" | "warning" | "info";
		}[];
	};

	/** Raw, auditable deterministic observation used by IZI AI Visibility. */
	measurement?: VisibilityMeasurementResult;
}

export interface AnalysisModelInput {
	model_provider: string;
	response: string;
}

/** PromptAnalysis as stored in ClickHouse  */
export interface PromptAnalysis {
	id: string;
	prompt_id: string;
	workspace_id: string;
	user_id: string;
	model_provider: string;
	prompt: string; // Store for convenience, though prompt is in prompt_responses too
	brand_analysis: string; // Complete BrandAnalysisResult as JSON string
	prompt_run_at: string;
	created_at: string;
}

/** Single analysis record - flat structure for easy filtering */
export interface AnalysisRecord {
	// Identifiers
	id: string;
	prompt_id: string;
	prompt_run_at: string;
	prompt: string;

	// User context
	user_id: string;
	workspace_id: string;

	// Model info
	model_provider: string;

	// Response data
	response: string;
	sources: Source[];

	// Full analysis data (parsed from JSON if available)
	brand_analysis?: BrandAnalysisResult;

	// Analysis status
	is_analysed?: boolean;

	// Timestamps
	created_at: string;
}

/** Metadata about available filters */
export interface AnalysisMetadata {
	available_brands: Array<{
		name: string;
		website: string;
	}>;
	available_models: string[];
}

/** Complete analysis response */
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
