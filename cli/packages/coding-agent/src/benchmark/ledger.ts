/**
 * Observer -> quality ledger projection (Step 2).
 *
 * Bridges the observation layer (`repo-skill-observer`) and the benchmark
 * quality ledger (`ocsid.quality-ledger.v1`). The observer emits *facts*: a
 * `task_judgement` row already carries a `judgementSource` (assertion / human /
 * model_grader) and an optional 0..1 `taskScore`. This module projects those
 * into a durable benchmark ledger row WITHOUT re-deriving anything from
 * artifacts — the observer, by privacy design, never stores response content,
 * so observer-sourced rows omit `artifactSha256`.
 *
 * Honesty: a judgement row is only projected when it actually carries a grade
 * (`judgementSource !== "none"` and a numeric score). Everything else yields
 * `null`, so an empty/quiet ledger is never mistaken for success.
 */

import type { RepoSkillEvent } from "../extensions/repo-skill-observer/events.ts";
import { QUALITY_LEDGER_SCHEMA, type QualityLedgerRow } from "./schema.ts";

export interface LedgerProjectionOptions {
	/** Stable run id; defaults to the event's session id. */
	runId?: string;
}

/**
 * Project a `task_judgement` observation row into a quality ledger row, or
 * return `null` when the event does not carry a real grade.
 */
export function judgementEventToLedgerRow(
	event: RepoSkillEvent,
	options?: LedgerProjectionOptions,
): QualityLedgerRow | null {
	if (event.eventType !== "task_judgement") return null;
	if (event.judgementSource === undefined || event.judgementSource === "none") return null;
	// The isFinite check is load-bearing on top of typeof: `typeof NaN === "number"`
	// and both range comparisons are false for NaN, so a NaN taskScore used to pass
	// this gate and reach the ledger, where it poisoned ledgerTaskSuccessRate into NaN.
	const score = event.taskScore;
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return null;
	if (!event.skillId) return null;

	return {
		schema: QUALITY_LEDGER_SCHEMA,
		runId: options?.runId ?? event.runId ?? event.sessionId,
		skillId: event.skillId,
		caseId: event.caseId ?? event.turnId ?? "unknown",
		candidateSha256: null, // baseline skill unless a candidate run supplies one
		extractor: { path: "observer", jsonpath: "$.taskScore" },
		observed: score,
		score: score,
		gradedBy: event.judgementSource,
		ts: event.ts,
	};
}

/** Project a list of observation rows; only real grades survive. */
export function observerJudgementsToLedger(
	events: RepoSkillEvent[],
	options?: LedgerProjectionOptions,
): QualityLedgerRow[] {
	const rows: QualityLedgerRow[] = [];
	for (const event of events) {
		const row = judgementEventToLedgerRow(event, options);
		if (row) rows.push(row);
	}
	return rows;
}

/**
 * Task success rate over a ledger. Mirrors the observer metrics contract:
 * returns `null` when there are no scored rows, so a caller can never mistake
 * an empty ledger for failure.
 */
export function ledgerTaskSuccessRate(rows: Pick<QualityLedgerRow, "score">[]): number | null {
	let count = 0;
	let sum = 0;
	for (const row of rows) {
		// isFinite, not typeof — a NaN score would make the whole mean NaN.
		const score = row.score;
		if (typeof score === "number" && Number.isFinite(score)) {
			count += 1;
			sum += score;
		}
	}
	return count > 0 ? sum / count : null;
}
