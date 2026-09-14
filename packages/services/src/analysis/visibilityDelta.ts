import type {
	AnalysisRecord,
	VisibilityAggregateResult,
	VisibilityDeltaBreakdown,
	VisibilityDeltaDimension,
	VisibilityDeltaPercentagePoints,
	VisibilityDeltaResult,
	VisibilityMeasurementResult,
} from "@oneglanse/types";
import { aggregateVisibility } from "./deterministicVisibility.js";

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function deltaPercentagePoints(
	before: VisibilityAggregateResult,
	after: VisibilityAggregateResult,
): VisibilityDeltaPercentagePoints {
	return {
		mentionRate: round2(after.mentionRate - before.mentionRate),
		citationRate: round2(after.citationRate - before.citationRate),
		top3PresenceRate: round2(after.top3PresenceRate - before.top3PresenceRate),
		shareOfVoice: round2(after.shareOfVoice - before.shareOfVoice),
	};
}

function measurementFor(record: AnalysisRecord): VisibilityMeasurementResult | null {
	return record.brand_analysis?.measurement ?? null;
}

function measurements(records: AnalysisRecord[]): VisibilityMeasurementResult[] {
	return records
		.map(measurementFor)
		.filter((item): item is VisibilityMeasurementResult => item !== null);
}

function aggregateRecords(records: AnalysisRecord[]): VisibilityAggregateResult {
	return aggregateVisibility(measurements(records));
}

function promptSetSignatures(records: AnalysisRecord[]): Set<string> {
	return new Set(
		records
			.map((record) => record.visibility_metadata)
			.filter((meta): meta is NonNullable<AnalysisRecord["visibility_metadata"]> => Boolean(meta))
			.map((meta) => `${meta.promptSetId}@${meta.promptSetVersion}`),
	);
}

function executionKeys(records: AnalysisRecord[]): Set<string> {
	return new Set(
		records
			.map((record) => {
				const meta = record.visibility_metadata;
				if (!meta) return null;
				return [
					record.model_provider,
					meta.promptDefinitionId,
					meta.promptVersion,
					meta.language,
					meta.lens,
					meta.intent,
					`r${meta.repeatIndex}`,
				].join("|");
			})
			.filter((value): value is string => Boolean(value)),
	);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) {
		if (!b.has(value)) return false;
	}
	return true;
}

function dimensionKey(
	record: AnalysisRecord,
	dimension: VisibilityDeltaDimension,
): string | null {
	const meta = record.visibility_metadata;
	if (dimension === "provider") return record.model_provider || null;
	if (!meta) return null;
	if (dimension === "language") return meta.language;
	if (dimension === "lens") return meta.lens;
	if (dimension === "intent") return meta.intent;
	return meta.promptDefinitionId;
}

function buildBreakdowns(
	beforeRecords: AnalysisRecord[],
	afterRecords: AnalysisRecord[],
): VisibilityDeltaBreakdown[] {
	const dimensions: VisibilityDeltaDimension[] = [
		"provider",
		"language",
		"lens",
		"intent",
		"prompt",
	];
	const rows: VisibilityDeltaBreakdown[] = [];

	for (const dimension of dimensions) {
		const keys = new Set<string>();
		for (const record of [...beforeRecords, ...afterRecords]) {
			const key = dimensionKey(record, dimension);
			if (key) keys.add(key);
		}

		for (const key of [...keys].sort()) {
			const before = aggregateRecords(
				beforeRecords.filter((record) => dimensionKey(record, dimension) === key),
			);
			const after = aggregateRecords(
				afterRecords.filter((record) => dimensionKey(record, dimension) === key),
			);
			rows.push({
				dimension,
				key,
				before,
				after,
				deltaPercentagePoints: deltaPercentagePoints(before, after),
			});
		}
	}

	return rows;
}

/**
 * Compares two labeled runs from the same stored analysis-record pool. The result
 * remains available when cohorts are not like-for-like, but `comparable` is false
 * and warnings explain why so the UI cannot present a misleading T0/T1 delta.
 */
export function compareVisibilityCohorts(
	records: AnalysisRecord[],
	beforeLabel: string,
	afterLabel: string,
): VisibilityDeltaResult {
	const beforeRecords = records.filter(
		(record) => record.visibility_metadata?.runLabel === beforeLabel,
	);
	const afterRecords = records.filter(
		(record) => record.visibility_metadata?.runLabel === afterLabel,
	);
	const warnings: string[] = [];

	if (beforeRecords.length === 0) warnings.push(`No observations found for ${beforeLabel}.`);
	if (afterRecords.length === 0) warnings.push(`No observations found for ${afterLabel}.`);

	const beforeMeasurements = measurements(beforeRecords);
	const afterMeasurements = measurements(afterRecords);
	if (beforeMeasurements.length !== beforeRecords.length) {
		warnings.push(`${beforeLabel} contains observations without deterministic measurements.`);
	}
	if (afterMeasurements.length !== afterRecords.length) {
		warnings.push(`${afterLabel} contains observations without deterministic measurements.`);
	}

	const beforePromptSets = promptSetSignatures(beforeRecords);
	const afterPromptSets = promptSetSignatures(afterRecords);
	if (!setsEqual(beforePromptSets, afterPromptSets)) {
		warnings.push("Prompt-set id/version differs between cohorts.");
	}

	const beforeExecutions = executionKeys(beforeRecords);
	const afterExecutions = executionKeys(afterRecords);
	if (!setsEqual(beforeExecutions, afterExecutions)) {
		warnings.push("Provider/prompt/repeat execution matrix differs between cohorts.");
	}

	const before = aggregateVisibility(beforeMeasurements);
	const after = aggregateVisibility(afterMeasurements);

	return {
		schemaVersion: "izi.ai-visibility.delta.v1",
		beforeLabel,
		afterLabel,
		comparable: warnings.length === 0,
		warnings,
		before,
		after,
		deltaPercentagePoints: deltaPercentagePoints(before, after),
		breakdowns: buildBreakdowns(beforeRecords, afterRecords),
	};
}
