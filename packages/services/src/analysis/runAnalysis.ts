import type { AnalysisInputSingle, BrandAnalysisResult } from "@oneglanse/types";
import { measureVisibility } from "./deterministicVisibility.js";

/**
 * API-free analysis path used by the IZI fork.
 *
 * The upstream project sends captured responses to OpenAI/Anthropic for semantic
 * scoring. This fork deliberately does not. It only derives auditable facts from
 * the rendered response text and captured source URLs.
 */
export async function runAnalysis(
	input: AnalysisInputSingle,
): Promise<BrandAnalysisResult> {
	const measurement = measureVisibility({
		prompt: input.prompt,
		response: input.response,
		sources: input.sources,
		brand: {
			name: input.brandName,
			domain: input.brandDomain,
			aliases: input.brandAliases,
		},
		properties: input.properties,
		competitors: input.competitors,
		captureStatus: input.captureStatus,
	});

	const configuredCompetitors = new Map(
		(input.competitors ?? []).map((competitor) => [competitor.name, competitor]),
	);

	return {
		metadata: {
			brandName: input.brandName,
			brandDomain: input.brandDomain,
			analysisMode: "deterministic-v1",
			legacyCompositeDisabled: true,
		},
		// The old composite score depended on a second LLM call. It is intentionally
		// disabled rather than replaced with an arbitrary new score.
		geoScore: { overall: 0 },
		presence: {
			mentioned: measurement.brand.mentioned,
			visibility: measurement.brand.mentioned ? 100 : 0,
		},
		position: {
			rankPosition: measurement.brand.rankPosition,
		},
		// Semantic sentiment/recommendation inference is outside deterministic v1.
		sentiment: { score: 0 },
		recommendation: {
			type: measurement.brand.mentioned ? "mentioned_only" : "not_mentioned",
		},
		competitors: measurement.competitors.map((competitor) => ({
			name: competitor.name,
			domain: configuredCompetitors.get(competitor.name)?.domain ?? "",
			visibility: competitor.count > 0 ? 100 : 0,
			sentiment: 0,
			rankPosition: competitor.rankPosition,
			isRecommended: false,
		})),
		perception: {
			coreClaims: [],
			differentiators: [],
			bestKnownFor: null,
			pricingPerception: "not_mentioned",
		},
		risks: { items: [] },
		measurement,
	};
}
