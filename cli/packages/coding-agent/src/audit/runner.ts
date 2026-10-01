/**
 * Step 3 — Audit runner.
 *
 * A repeatable orchestrator that turns benchmark cases into quality-ledger rows.
 * The runner NEVER does an agent run itself; it takes an injected `CaseExecutor`
 * (which produces an artifact for a case) and an injected `CaseGrader` (which
 * scores that artifact against the case's assertions). This keeps the runner
 * deterministic and testable, while real agent invocation is supplied later by
 * a caller with budget/environment.
 *
 * Honesty contract:
 *  - The ledger rows and summary are fully derived from the injected grades; the
 *    runner manufactures no result.
 *  - `candidateSha256` is null unless a caller supplies a candidate digest → a
 *    null candidate means "baseline skill", never "no skill".
 *  - Repeated runs over identical inputs + grades produce byte-identical ledger
 *    lines and summary (no Date.now() in row content; ordering is stable).
 */

import type { CaseExecutor, CaseFile, CaseGrader, CaseRecord, CaseScore, ExecutionErrorKind, ExecutionResult, ExecutionStatus, ExecutionUsage, GradeJudgeMeta, GradeOutcome, GradeSpec } from "./types.ts";
import { QUALITY_LEDGER_SCHEMA, type GradedBy, type QualityLedgerRow } from "../benchmark/schema.ts";

/** L0..L3 audit depth a case attains. */
export type AuditDepth = "L0" | "L1" | "L2" | "L3";

const DEPTH_ORDER: Record<AuditDepth, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/**
 * Result of auditing a single case.
 */
export interface AuditedCase {
	case: CaseRecord;
	/** Highest audit depth reached. */
	depth: AuditDepth;
	/** What failed the next depth, when depth < L3. */
	blocker?: string;
	/** The graded score (mean of assertion grades), when L2+. */
	score: CaseScore;
	/** The ledger row written for this case, when L3. */
	row?: QualityLedgerRow;
	/**
	 * Execution machinery (B1): the status of the case's execution, plus the
	 * error kind when execution did not succeed. Present for every case so a
	 * summary can distinguish not-executed / failed / executed-but-ungraded.
	 */
	execStatus: ExecutionStatus;
	errorKind?: ExecutionErrorKind;
	/** sha256 of the produced artifact, when an artifact exists. */
	artifactSha256?: string | null;
	/**
	 * The produced artifact text (P0-1): the executor's artifact for every case
	 * that reached an execution, null when no artifact was produced. This is what
	 * persistence writes into artifacts.jsonl (with its ledger-consistent sha256),
	 * so downstream consumers can re-inspect the exact bytes a score was earned
	 * on — NOT just its digest. Null when the executor never ran (e.g. L0 file
	 * failure) or produced nothing.
	 */
	artifact?: string | null;
	/**
	 * The execution's usage/cost block (P0-2), when the executor reported one.
	 * Carried onto the audited case so persistence can write the tool trajectory
	 * (`usage.toolTrace`) into traces.jsonl for score attribution. Undefined when
	 * the executor never ran or reported no usage.
	 */
	usage?: ExecutionUsage;
}

export interface AuditRunOptions {
	/** Stable run id (e.g. "baseline-1"); surfaced in every ledger row. */
	runId: string;
	/** Candidate content digest; null = baseline skill. */
	candidateSha256?: string | null;
	/** Fixed run timestamp (ISO) so repeated runs are byte-identical. */
	runAt: string;
}

export interface AuditRunResult {
	runId: string;
	cases: AuditedCase[];
	summary: AuditRunSummary;
}

export interface AuditRunSummary {
	skillCount: number;
	caseCount: number;
	perDepth: Record<AuditDepth, number>;
	/** task_success_rate over L3 rows with a numeric score, else null. */
	taskSuccessRate: number | null;
	perSkill: Record<string, number | null>;
	perSplit: Record<string, number | null>;
	/**
	 * Execution bookkeeping (B1).
	 *  - attempted: cases where an execution was started (executor invoked).
	 *  - completed: executions that returned a succeeded status.
	 *  - graded: L3 rows written (completed AND successfully graded).
	 *  - failed: executions that returned failed/timed-out/cancelled.
	 *  - missing: cases that never reached a graded row (graded is the only
	 *    number a reader may treat as a real "success" denominator).
	 */
	attempted: number;
	completed: number;
	graded: number;
	failed: number;
	missing: number;
}

/** Map a case id to the benchmark split it belongs to (from a manifest). */
export type SplitIndex = Record<string, string>;

/**
 * Audit a list of cases. `executor` and `grader` are injected; a case that the
 * grader cannot grade (e.g. missing assertions) simply stops at a lower depth.
 */
export async function runAudit(
	cases: CaseRecord[],
	options: AuditRunOptions,
	deps: { executor: CaseExecutor; grader: CaseGrader; splitIndex: SplitIndex },
): Promise<AuditRunResult> {
	const audited: AuditedCase[] = [];
	for (const caseRecord of cases) {
		audited.push(await auditCase(caseRecord, options, deps));
	}
	return {
		runId: options.runId,
		cases: audited,
		summary: summarize(audited, deps.splitIndex),
	};
}

async function auditCase(
	c: CaseRecord,
	options: AuditRunOptions,
	deps: { executor: CaseExecutor; grader: CaseGrader },
): Promise<AuditedCase> {
	// L0 — basic case files present + assertions parseable.
	const fileCheck = checkCaseFiles(c.files);
	if (!fileCheck.ok) return { case: c, depth: "L0", blocker: fileCheck.reason, score: null, execStatus: "not-attempted", artifactSha256: null, artifact: null };

	// L1 — executor produced a non-empty artifact.
	let result: ExecutionResult;
	try {
		result = await deps.executor.execute(c);
	} catch (error) {
		return {
			case: c,
			depth: "L0",
			blocker: `executor failed: ${error instanceof Error ? error.message : String(error)}`,
			score: null,
			execStatus: "failed",
			errorKind: "other",
			artifactSha256: null,
			artifact: null,
		};
	}

	// Execution did not succeed → distinct, machine-readable status. A timed-out,
	// cancelled, or failed execution is NOT the same as "produced no artifact".
	if (result.status !== "succeeded") {
		return {
			case: c,
			depth: "L1",
			blocker: result.error ?? `execution ${result.status}`,
			score: null,
			execStatus: result.status,
			errorKind: result.errorKind,
			artifactSha256: result.artifactSha256 ?? null,
			artifact: result.artifact ?? null,
			usage: result.usage,
		};
	}

	const artifact = result.artifact;
	if (!artifact || !artifact.trim()) {
		return {
			case: c,
			depth: "L1",
			blocker: "executor produced no artifact",
			score: null,
			execStatus: "succeeded",
			artifactSha256: result.artifactSha256 ?? null,
			artifact: result.artifact ?? null,
			usage: result.usage,
		};
	}

	// L2 — grade the artifact against the case's assertions.
	let grade: GradeSpec;
	try {
		grade = await deps.grader.grade(c, artifact);
	} catch (error) {
		return {
			case: c,
			depth: "L1",
			blocker: `grading failed: ${error instanceof Error ? error.message : String(error)}`,
			score: null,
			execStatus: "succeeded",
			artifactSha256: result.artifactSha256 ?? null,
			artifact: result.artifact ?? null,
			usage: result.usage,
		};
	}
	const perAssertion = Array.isArray(grade.perAssertion) ? grade.perAssertion : [];
	if (perAssertion.length === 0) {
		return {
			case: c,
			depth: "L2",
			blocker: "no assertion-grade produced",
			score: null,
			execStatus: "succeeded",
			artifactSha256: result.artifactSha256 ?? null,
			artifact: result.artifact ?? null,
			usage: result.usage,
		};
	}
	const score = meanScore(perAssertion);

	// L3 — write a fully provenance-backed ledger row.
	const row = makeLedgerRow(c, score, perAssertion, options, deps.grader.gradedBy, result, grade.judge);
	return { case: c, depth: "L3", score, row, execStatus: "succeeded", artifactSha256: result.artifactSha256 ?? null, artifact: result.artifact ?? null, usage: result.usage };
}

export function checkCaseFiles(files: CaseFile): { ok: true } | { ok: false; reason: string } {
	if (!files.userRequest || !files.userRequest.trim()) return { ok: false, reason: "missing user_request.txt" };
	if (!files.assertionsText) return { ok: false, reason: "missing assertions.json text" };
	try {
		const parsed = JSON.parse(files.assertionsText) as { assertions?: unknown; schema?: unknown };
		if (parsed.schema !== "disco.usability-case.v1") return { ok: false, reason: "assertions schema != disco.usability-case.v1" };
		if (!Array.isArray(parsed.assertions) || parsed.assertions.length === 0) return { ok: false, reason: "no non-empty assertions list" };
	} catch {
		return { ok: false, reason: "assertions.json is not valid JSON" };
	}
	return { ok: true };
}

function meanScore(grades: GradeOutcome[]): CaseScore {
	let sum = 0;
	let count = 0;
	for (const g of grades) {
		if (typeof g.score === "number") {
			sum += g.score;
			count += 1;
		}
	}
	return count > 0 ? sum / count : null;
}

function makeLedgerRow(c: CaseRecord, score: CaseScore, perAssertion: GradeOutcome[], options: AuditRunOptions, gradedBy: GradedBy | undefined, result: ExecutionResult, judge?: GradeJudgeMeta): QualityLedgerRow {
	return {
		schema: QUALITY_LEDGER_SCHEMA,
		runId: options.runId,
		skillId: c.skillId,
		caseId: c.caseId,
		candidateSha256: options.candidateSha256 ?? null,
		artifactSha256: result.artifactSha256 ?? undefined,
		extractor: { path: "audit", jsonpath: "$.score" },
		observed: perAssertion.map((g) => ({ outcome: g.outcome, score: g.score ?? null })),
		score,
		// BUG-P1-13: attribute the row to the grader's declared category,
		// never a hardcoded source. Ad-hoc graders without a declaration fall back.
		gradedBy: gradedBy ?? "model_grader",
		// P0-3 step 2: a real judge's model id + rubric version ride on the row so
		// the number is traceable to the exact judge implementation. Absent for a
		// deterministic proxy (which is identical for every input and needs no stamp).
		...(judge && (judge.modelVersion || judge.rubricVersion) ? { judge } : {}),
		ts: options.runAt,
	};
}

function summarize(audited: AuditedCase[], splitIndex: SplitIndex): AuditRunSummary {
	const perDepth: Record<AuditDepth, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
	const scored: QualityLedgerRow[] = [];
	const skills = new Set<string>();
	let attempted = 0;
	let completed = 0;
	let failed = 0;
	for (const a of audited) {
		perDepth[a.depth] += 1;
		skills.add(a.case.skillId);
		if (a.execStatus === "failed" || a.execStatus === "timed-out" || a.execStatus === "cancelled") failed += 1;
		if (a.execStatus !== "not-attempted") attempted += 1;
		if (a.execStatus === "succeeded") completed += 1;
		if (a.row && typeof a.row.score === "number") scored.push(a.row);
	}

	const rate = scored.length > 0 ? scored.reduce((s, r) => s + (r.score as number), 0) / scored.length : null;
	const graded = scored.length;
	const missing = audited.length - graded;

	const perSkill: Record<string, number | null> = {};
	const perSplit: Record<string, number | null> = {};
	for (const skill of [...skills].sort()) {
		perSkill[skill] = meanRows(scored.filter((r) => r.skillId === skill));
		const splits = new Set<string>();
		for (const r of scored) {
			if (r.skillId === skill && splitIndex[`${r.skillId}:${r.caseId}`]) splits.add(splitIndex[`${r.skillId}:${r.caseId}`]);
		}
		for (const split of [...splits].sort()) {
			const rows = scored.filter((r) => r.skillId === skill && splitIndex[`${r.skillId}:${r.caseId}`] === split);
			perSplit[`${skill}:${split}`] = meanRows(rows);
		}
	}

	return {
		skillCount: skills.size,
		caseCount: audited.length,
		perDepth,
		taskSuccessRate: rate,
		perSkill,
		perSplit,
		attempted,
		completed,
		graded,
		failed,
		missing,
	};
}

function meanRows(rows: QualityLedgerRow[]): number | null {
	if (rows.length === 0) return null;
	return rows.reduce((s, r) => s + (r.score as number), 0) / rows.length;
}

/**
 * Emit ledger lines as stable, deterministic JSONL. Ordering follows the input
 * order; rows are the same bytes on every identical re-run.
 */
export function serializeLedgerRows(rows: QualityLedgerRow[]): string {
	return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}
