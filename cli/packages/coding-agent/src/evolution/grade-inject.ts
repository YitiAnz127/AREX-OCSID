/**
 * Human / real-model grade injection.
 *
 * Candidate evaluation pipelines record an audit-run ledger per candidate. Real
 * human or downstream-model judgments can be baked into that ledger POST-HOC via
 * this module: it rewrites a single case row's score / gradedBy / timestamp and
 * recomputes the run summary task_success_rate from the actual injected scores.
 *
 * Honesty contract:
 *  - ONLY targets candidate-eval or candidate-agent-eval runs (it never edits a
 *    baseline-plumbing ledger into something that looks quality-backed).
 *  - It is an explicit, human-driven injection, recorded with the named grader, a
 *    timestamp, and an optional note. It is NOT a re-run and does not alter the
 *    runner's determinism.
 *  - Recomputing the summary rate uses the *current* ledger values, so a partial
 *    injection yields an honest partial rate (not a fabricated full run).
 *  - A grade is only written when the row already exists (no phantom rows).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { GradedBy } from "../benchmark/schema.ts";
import { gradeSourceCategory, isCandidateRunKind } from "../benchmark/schema.ts";
import { assertCanonicalId, assertCaseId, resolveRunDir } from "../audit/id.ts";
import { atomicWriteFileSync } from "../audit/atomic.ts";

/** A timestamp alone is not unique when a batch injects multiple grades. */
export function makeGradeId(at: string): string {
	return `grade-${at.replace(/[^0-9A-Za-z-]/g, "")}-${randomUUID()}`;
}

/** True when the run's append-only journal already carries a fully-applied `done` for this gradeId. */
function gradeIdAlreadyApplied(dir: string, gradeId: string): boolean {
	const journalPath = path.join(dir, "grades.jsonl");
	if (!existsSync(journalPath)) return false;
	let text: string;
	try {
		text = readFileSync(journalPath, "utf8");
	} catch {
		return false;
	}
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const rec = JSON.parse(line) as { phase?: unknown; gradeId?: unknown };
			if (rec.phase === "done" && rec.gradeId === gradeId) return true;
		} catch {
			// ignore malformed journal lines during the scan
		}
	}
	return false;
}

/** Count current ledger rows (for idempotent-retry reporting without mutation). */
function readLedgerRowCount(ledgerPath: string): number {
	try {
		if (!existsSync(ledgerPath)) return 0;
		return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

/**
 * B3 (P0-3): read the append-only grade journal for a run so an operator/recovery
 * routine can rebuild the authoritative view AND detect a crash left an `intent`
 * without a matching `done` (a half-applied transaction). Exposed for the fault
 * -injection acceptance test and reporting.
 */
export function readGradeJournal(dir: string): Array<{
	phase: "intent" | "done";
	gradeId?: unknown;
	at?: unknown;
	runId?: unknown;
	skillId?: unknown;
	caseId?: unknown;
	sourceCategory?: unknown;
}> {
	const journalPath = path.join(dir, "grades.jsonl");
	if (!existsSync(journalPath)) return [];
	const out: Array<{
		phase: "intent" | "done";
		gradeId?: unknown;
		at?: unknown;
		runId?: unknown;
		skillId?: unknown;
		caseId?: unknown;
		sourceCategory?: unknown;
	}> = [];
	for (const line of readFileSync(journalPath, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const rec = JSON.parse(line) as {
				phase?: unknown;
				gradeId?: unknown;
				at?: unknown;
				runId?: unknown;
				skillId?: unknown;
				caseId?: unknown;
				sourceCategory?: unknown;
			};
			if (rec.phase === "intent" || rec.phase === "done") {
				out.push(rec as typeof out[number]);
			}
		} catch {
			// skip malformed lines
		}
	}
	return out;
}

/**
 * B3: detect incomplete (crashed) grade transactions for a run — an `intent`
 * journal entry with NO matching `done` for the same gradeId. Returns the set of
 * dangling gradeIds. Recovery = replay the journal revision for that gradeId.
 */
export function detectIncompleteGrades(dir: string): string[] {
	const seenIntent = new Set<string>();
	const seenDone = new Set<string>();
	for (const rec of readGradeJournal(dir)) {
		if (rec.phase === "intent" && typeof rec.gradeId === "string") seenIntent.add(rec.gradeId);
		if (rec.phase === "done" && typeof rec.gradeId === "string") seenDone.add(rec.gradeId);
	}
	return [...seenIntent].filter((g) => !seenDone.has(g));
}

export interface InjectGradeRequest {
	qualityDir: string;
	runId: string;
	skillId: string;
	caseId: string;
	/** Score in [0,1]. */
	score: number;
	gradedBy: "human" | "model_grader";
	note?: string;
	/** ISO timestamp; caller-controlled. Defaults to a real UTC timestamp (BUG-P1-10). */
	at?: string;
	/** BUG-P1-11: explicit external-grade provenance so an override never leaves
	 *  an anonymous, untraceable grade behind. */
	gradeId?: string;
	/**
	 * B3 (P0-3): a HUMAN grade is only acceptable with an authenticated reviewer
	 * id AND a concrete evidence ref — identical to the `judgement` entry point.
	 * A missing reviewer/evidence for `gradedBy: "human"` is rejected outright so
	 * the `grade` CLI and `InjectGradeRequest` are CONSISTENT with `judgement`.
	 */
	reviewerId?: string;
	rubricVersion?: string;
	evidenceRef?: string;
}

export interface InjectGradeResult {
	applied: boolean;
	reason?: string;
	updatedScore: number | null;
	taskSuccessRate: number | null;
	ledgerRowCount: number;
}

interface SummaryLike {
	runId?: string;
	kind?: string;
	taskSuccessRate?: number | null;
	caseCount?: number;
	[k: string]: unknown;
}

function validateScore(score: number): void {
	if (!Number.isFinite(score)) throw new Error("score must be a finite number");
	if (score < 0 || score > 1) throw new Error("score must be within [0,1]");
}

export function injectGrade(req: InjectGradeRequest): InjectGradeResult {
	validateScore(req.score);
	// B3 (P0-3): a human grade must carry an authenticated reviewer + evidence,
	// consistent with the `judgement` entry point. Both CLI entry points now
	// reject a reviewer-less human grade identically.
	if (req.gradedBy === "human" && (!req.reviewerId || !req.reviewerId.trim())) {
		return { applied: false, reason: "human grade requires a reviewer id (and evidence ref)", updatedScore: null, taskSuccessRate: null, ledgerRowCount: 0 };
	}
	if (req.gradedBy === "human" && (!req.evidenceRef || !req.evidenceRef.trim())) {
		return { applied: false, reason: "human grade requires an evidence ref", updatedScore: null, taskSuccessRate: null, ledgerRowCount: 0 };
	}
	// BUG-P0-02: validate all user-supplied ids before touching the filesystem.
	assertCanonicalId(req.runId, "runId");
	assertCanonicalId(req.skillId, "skillId");
	assertCaseId(req.caseId);
	const dir = resolveRunDir(req.qualityDir, req.runId);
	const summaryPath = path.join(dir, "summary.json");
	const ledgerPath = path.join(dir, "ledger.jsonl");
	if (!existsSync(summaryPath) || !existsSync(ledgerPath)) {
		return { applied: false, reason: `run ${req.runId} not found under quality/audit`, updatedScore: null, taskSuccessRate: null, ledgerRowCount: 0 };
	}
	// The ledger is rewritten as a whole. Serialize all injections for this run,
	// including summary and revision updates, rather than relying on a racy
	// read-compare-write check. A contending caller can retry the injection.
	const release = lockfile.lockSync(dir, { realpath: false });
	try {
		return injectGradeLocked(req, dir, summaryPath, ledgerPath);
	} finally {
		release();
	}
}

function injectGradeLocked(req: InjectGradeRequest, dir: string, summaryPath: string, ledgerPath: string): InjectGradeResult {
	// B3 (P0-3): idempotent retry — when the caller supplies an explicit `gradeId`
	// that already exists in the append-only revision journal as an applied grade,
	// re-running is a NO-OP (same gradeId must never mint a second revision or
	// double-count). This makes a crashed/retried injection safe to replay.
	if (req.gradeId && gradeIdAlreadyApplied(dir, req.gradeId)) {
		return { applied: false, reason: `gradeId ${req.gradeId} already applied (idempotent retry ignored)`, updatedScore: null, taskSuccessRate: null, ledgerRowCount: readLedgerRowCount(ledgerPath) };
	}
	let summary: SummaryLike;
	try {
		summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryLike;
	} catch {
		return { applied: false, reason: `run ${req.runId} has an unreadable summary.json`, updatedScore: null, taskSuccessRate: null, ledgerRowCount: 0 };
	}
	if (!isCandidateRunKind(summary.kind)) {
		return { applied: false, reason: `run ${req.runId} has kind "${summary.kind}"; grade injection only applies to candidate-eval or candidate-agent-eval runs`, updatedScore: null, taskSuccessRate: null, ledgerRowCount: 0 };
	}

	const at = req.at ?? new Date().toISOString(); // BUG-P1-10: real UTC default
	const gradeId = req.gradeId ?? makeGradeId(at);
	const originalLedger = readFileSync(ledgerPath, "utf8");
	const lines = originalLedger.split("\n").filter(Boolean);
	const seenCases = new Set<string>();
	for (const line of lines) {
		// Guarded, like every other parse in this file (gradeIdAlreadyApplied,
		// readGradeJournal, the summary read). audit-consistency.ts also treats a
		// malformed ledger line as expected input, so a truncated/hand-edited line
		// must degrade to {applied:false}, not surface a raw SyntaxError.
		let row: { skillId?: unknown; caseId?: unknown };
		try {
			row = JSON.parse(line) as { skillId?: unknown; caseId?: unknown };
		} catch {
			return {
				applied: false,
				reason: `ledger for run ${req.runId} has a malformed line`,
				updatedScore: null,
				taskSuccessRate: null,
				ledgerRowCount: lines.length,
			};
		}
		if (typeof row.skillId !== "string" || typeof row.caseId !== "string") {
			throw new Error(`ledger for run ${req.runId} has a row without skillId or caseId`);
		}
		const key = JSON.stringify([row.skillId, row.caseId]);
		if (seenCases.has(key)) {
			throw new Error(`ledger for run ${req.runId} has a duplicate case row for ${row.skillId}:${row.caseId}`);
		}
		seenCases.add(key);
	}
	let matched = false;
	let updatedScore: number | null = null;
	// BUG-P1-11: append-only grade revision ledger. Before overwriting a row we
	// preserve its ORIGINAL content plus the override request, so the provenance
	// of both the proxy grade and the injected grade is auditably retained. We
	// never silently discard the original.
	const revisions: string[] = [];
	const out = lines.map((line) => {
		const row = JSON.parse(line) as { skillId?: string; caseId?: string; score?: number | null; gradedBy?: string; ts?: string; note?: string; observed?: unknown; extractor?: unknown; [k: string]: unknown };
		if (row.skillId === req.skillId && row.caseId === req.caseId) {
			if (!matched) {
				// Preserve the exact pre-injection row in the revision ledger.
				const before = JSON.parse(line) as Record<string, unknown>;
				revisions.push(
					JSON.stringify({
						schema: "disco.grade-revision.v1",
						gradeId,
						// B3: record the normative source category (separate from the
						// legacy gradedBy label) so a human_review / llm_judge override
						// is never conflated with a deterministic_proxy number.
						sourceCategory: gradeSourceCategory(req.gradedBy),
						reviewerId: req.reviewerId,
						rubricVersion: req.rubricVersion,
						evidenceRef: req.evidenceRef,
						at,
						before,
						after: { score: req.score, gradedBy: req.gradedBy, note: req.note },
					}),
				);
				matched = true;
				row.score = req.score;
				row.gradedBy = req.gradedBy;
				row.ts = at;
				row.gradeId = gradeId;
				if (req.note !== undefined) row.note = req.note;
				if (req.reviewerId !== undefined) row.reviewerId = req.reviewerId;
				if (req.rubricVersion !== undefined) row.rubricVersion = req.rubricVersion;
				if (req.evidenceRef !== undefined) row.evidenceRef = req.evidenceRef;
				// BUG-P1-11: clear the stale model-proxy provenance that old rows
				// carried, so a row cannot simultaneously claim "human score=1" and
				// "observed/extractor = old proxy result".
				delete row.observed;
				delete row.extractor;
				updatedScore = req.score;
			}
		}
		return JSON.stringify(row);
	});

	if (!matched) {
		return { applied: false, reason: `no ledger row for ${req.skillId}:${req.caseId} in run ${req.runId}`, updatedScore: null, taskSuccessRate: null, ledgerRowCount: lines.length };
	}

	// Record provenance before changing the ledger. If this append fails, refuse
	// the grade rather than silently creating an untraceable override.
	const journalPath = path.join(dir, "grades.jsonl");
	// B3 (P0-3): recovery marker. The authoritative grade is append-only in the
	// journal; the ledger and summary are REBUILDABLE projections of it. We write
	// an explicit `intent` before mutating and a `done` reactor after all three
	// writes complete blocks. A crash between the writes leaves an intent without
	// a matching done, which any recovery routine can detect and replay from the
	// journal rather than guessing at a half-merged ledger.
	if (revisions.length > 0) {
		appendFileSync(
			journalPath,
			JSON.stringify({ journal: "disco.grade-journal.v1", phase: "intent", gradeId, at, runId: req.runId, skillId: req.skillId, caseId: req.caseId, sourceCategory: gradeSourceCategory(req.gradedBy) }) + "\n",
			"utf8",
		);
		appendFileSync(journalPath, revisions.join("\n") + "\n", "utf8");
	}
	atomicWriteFileSync(ledgerPath, out.join("\n") + "\n", "utf8");

	// Recompute summary task_success_rate from current ledger rows.
	let sum = 0;
	let n = 0;
	for (const line of out) {
		const r = JSON.parse(line) as { score?: number | null };
		if (typeof r.score === "number") {
			sum += r.score;
			n += 1;
		}
	}
	const newRate = n ? sum / n : null;
	const noteLine = req.note
		? `grade injected: ${req.gradedBy} ${req.score} for ${req.skillId}:${req.caseId} (${req.note})`
		: `grade injected: ${req.gradedBy} ${req.score} for ${req.skillId}:${req.caseId}`;
	atomicWriteFileSync(
		summaryPath,
		JSON.stringify({ ...summary, taskSuccessRate: newRate, gradedBySummary: true, gradeNote: noteLine, gradeAt: at, gradeId }, null, 2) + "\n",
		"utf8",
	);

	// B3: mark the transaction as fully applied in the append-only journal. A
	// journal entry carrying `phase: "done"` is the commit marker for recovery.
	if (revisions.length > 0) {
		appendFileSync(path.join(dir, "grades.jsonl"), JSON.stringify({ journal: "disco.grade-journal.v1", phase: "done", gradeId, at }) + "\n", "utf8");
	}

	return { applied: true, updatedScore, taskSuccessRate: newRate, ledgerRowCount: out.length };
}

export interface BatchGradeResult {
	applied: number;
	skipped: number;
	failed: Array<{ key: string; reason: string }>;
	results: Array<InjectGradeResult & { key: string }>;
}

/**
 * Apply a batch of grade injections. Each request is a single-row injection
 * (recomputed against current ledger); results are aggregated so a reviewer or
 * downstream model can apply many judgments at once (same `at` batch) and see
 * exactly which applied and which failed.
 */
export function injectGrades(reqs: InjectGradeRequest[]): BatchGradeResult {
	const results: BatchGradeResult["results"] = [];
	const failed: BatchGradeResult["failed"] = [];
	let applied = 0;
	let skipped = 0;
	for (const req of reqs) {
		const key = `${req.runId}|${req.skillId}|${req.caseId}`;
		let res: InjectGradeResult;
		try {
			res = injectGrade(req);
		} catch (error) {
			// Score validation errors (and any other throw) -> recorded as failed.
			const reason = error instanceof Error ? error.message : String(error);
			failed.push({ key, reason });
			results.push({ ...{ applied: false, reason, updatedScore: null, taskSuccessRate: null, ledgerRowCount: 0 }, key });
			skipped += 1;
			continue;
		}
		results.push({ ...res, key });
		if (res.applied) applied += 1;
		else {
			skipped += 1;
			failed.push({ key, reason: res.reason ?? "unknown" });
		}
	}
	return { applied, skipped, failed, results };
}

export type { GradedBy };
