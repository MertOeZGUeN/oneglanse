import type {
	VisibilityAggregateResult,
	VisibilityEntityMention,
	VisibilityMeasurementInput,
	VisibilityMeasurementResult,
	VisibilityTrackedEntity,
} from "@oneglanse/types";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasesFor(entity: VisibilityTrackedEntity): string[] {
	return [...new Set([entity.name, ...(entity.aliases ?? [])].map((value) => value.trim()))]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
}

type MatchRange = { start: number; end: number };

function findMatchRanges(text: string, entity: VisibilityTrackedEntity): MatchRange[] {
	const candidates: MatchRange[] = [];

	for (const alias of aliasesFor(entity)) {
		const pattern = new RegExp(
			`(^|[^\\p{L}\\p{N}])(${escapeRegExp(alias)})(?=$|[^\\p{L}\\p{N}])`,
			"giu",
		);

		for (const match of text.matchAll(pattern)) {
			const prefixLength = match[1]?.length ?? 0;
			const matchedAlias = match[2] ?? "";
			const start = (match.index ?? 0) + prefixLength;
			candidates.push({ start, end: start + matchedAlias.length });
		}
	}

	candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

	const selected: MatchRange[] = [];
	for (const candidate of candidates) {
		const overlaps = selected.some(
			(existing) => candidate.start < existing.end && candidate.end > existing.start,
		);
		if (!overlaps) selected.push(candidate);
	}

	return selected.sort((a, b) => a.start - b.start);
}

function mentionFor(text: string, entity: VisibilityTrackedEntity): VisibilityEntityMention {
	const matches = findMatchRanges(text, entity);
	return {
		name: entity.name,
		count: matches.length,
		firstIndex: matches[0]?.start ?? null,
		rankPosition: null,
	};
}

function applyRankPositions(
	brandMention: VisibilityEntityMention,
	competitorMentions: VisibilityEntityMention[],
): {
	brandRank: number | null;
	competitors: VisibilityEntityMention[];
} {
	const ranked = [brandMention, ...competitorMentions]
		.filter((item) => item.firstIndex !== null)
		.sort((a, b) => (a.firstIndex ?? Number.MAX_SAFE_INTEGER) - (b.firstIndex ?? Number.MAX_SAFE_INTEGER));

	const rankByName = new Map(ranked.map((item, index) => [item.name, index + 1]));

	return {
		brandRank: rankByName.get(brandMention.name) ?? null,
		competitors: competitorMentions.map((item) => ({
			...item,
			rankPosition: rankByName.get(item.name) ?? null,
		})),
	};
}

function normalizeDomain(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;

	try {
		const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
		return new URL(withScheme).hostname.replace(/^www\./, "");
	} catch {
		return trimmed.replace(/^www\./, "").replace(/\/$/, "");
	}
}

function domainFromUrl(url: string): string | null {
	try {
		return normalizeDomain(new URL(url).hostname);
	} catch {
		return null;
	}
}

function isOwnedDomain(sourceDomain: string, brandDomain: string | null): boolean {
	if (!brandDomain) return false;
	return sourceDomain === brandDomain || sourceDomain.endsWith(`.${brandDomain}`);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

export function measureVisibility(
	input: VisibilityMeasurementInput,
): VisibilityMeasurementResult {
	const response = input.response ?? "";
	const brandMention = mentionFor(response, input.brand);
	const propertyMentions = (input.properties ?? []).map((entity) => mentionFor(response, entity));
	const competitorMentions = (input.competitors ?? []).map((entity) => mentionFor(response, entity));
	const ranked = applyRankPositions(brandMention, competitorMentions);

	const citationUrls = unique(
		(input.sources ?? [])
			.map((source) => source.url?.trim())
			.filter((url): url is string => Boolean(url)),
	);
	const citationDomains = unique(
		(input.sources ?? [])
			.map((source) => normalizeDomain(source.domain) ?? domainFromUrl(source.url))
			.filter((domain): domain is string => Boolean(domain)),
	);
	const brandDomain = normalizeDomain(input.brand.domain);
	const ownedDomainCited = citationDomains.some((domain) => isOwnedDomain(domain, brandDomain));

	let status: VisibilityMeasurementResult["status"];
	if (input.captureStatus) {
		status = input.captureStatus;
	} else if (!response.trim()) {
		status = "no_answer";
	} else if (brandMention.count > 0) {
		status = "answered";
	} else {
		status = "no_brand";
	}

	return {
		schemaVersion: "izi.ai-visibility.observation.v1",
		analysisMode: "deterministic",
		status,
		prompt: input.prompt,
		brand: {
			name: input.brand.name,
			domain: brandDomain,
			mentioned: brandMention.count > 0,
			mentionCount: brandMention.count,
			firstIndex: brandMention.firstIndex,
			rankPosition: ranked.brandRank,
			top3Presence: ranked.brandRank !== null && ranked.brandRank <= 3,
			ownedDomainCited,
		},
		properties: propertyMentions,
		competitors: ranked.competitors,
		citations: {
			urls: citationUrls,
			domains: citationDomains,
		},
	};
}

function percentage(numerator: number, denominator: number): number {
	if (denominator === 0) return 0;
	return Math.round((numerator / denominator) * 10_000) / 100;
}

export function aggregateVisibility(
	observations: VisibilityMeasurementResult[],
): VisibilityAggregateResult {
	const eligible = observations.filter(
		(item) => item.status === "answered" || item.status === "no_brand",
	);
	const mentioned = eligible.filter((item) => item.brand.mentioned).length;
	const cited = eligible.filter((item) => item.brand.ownedDomainCited).length;
	const top3 = eligible.filter((item) => item.brand.top3Presence).length;

	let brandMentions = 0;
	let competitorMentions = 0;
	const domainCounts = new Map<string, number>();

	for (const item of eligible) {
		brandMentions += item.brand.mentionCount;
		competitorMentions += item.competitors.reduce((sum, competitor) => sum + competitor.count, 0);
		for (const domain of item.citations.domains) {
			domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
		}
	}

	return {
		schemaVersion: "izi.ai-visibility.aggregate.v1",
		eligibleObservations: eligible.length,
		mentionRate: percentage(mentioned, eligible.length),
		citationRate: percentage(cited, eligible.length),
		top3PresenceRate: percentage(top3, eligible.length),
		shareOfVoice: percentage(brandMentions, brandMentions + competitorMentions),
		sourceDistribution: [...domainCounts.entries()]
			.map(([domain, count]) => ({ domain, count }))
			.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)),
	};
}
