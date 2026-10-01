/**
 * Candidate evaluation run-batch — the "non-baseline" audit path.
 *
 * Takes a candidate (e.g. an evolution proposal hypothesis, or any skill-text
 * artifact), computes a reproducible candidate digest, runs it over a benchmark
 * with the model-grader proxy, and persists the result as `kind: "candidate-eval"`.
 *
 * Honesty contract:
 *  - The grader here is a DETERMINISTIC PROXY (see model-grader.ts), NOT an LLM.
 *    The ledger/summary make this explicit so the number is never mistaken for a
 *    routing-quality claim. Swapping in a real model changes only the grader.
 *  - Every ledger row records the candidate's sha256 for provenance.
 *  - Repeated runs over identical (benchmark, candidate) are identical.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { runAudit } from "../audit/runner.ts";
import { modelGrader } from "../audit/model-grader.ts";
import { loadBenchmark } from "../audit/loader.ts";
import { persistAuditRun } from "../audit/records.ts";
import { proxyExecutor } from "../audit/types.ts";
import type { CaseRecord } from "../audit/types.ts";
import type { BenchmarkSplit } from "../benchmark/schema.ts";
import { listCandidateRuns } from "./candidate-pool.ts";

/**
 * The only splits a candidate-selection (ranking) path may ever score.
 * `heldout` is deliberately excluded at the type level so a held-out terminal
 * set cannot be searched/selected against — it is reachable ONLY through the
 * independent, post-freeze `runHeldoutFinalEval` entry (P1-4).
 */
export type RankingSplit = Exclude<BenchmarkSplit, "heldout">;

/** Deterministic sha256 hex digest of the candidate text. */
export function candidateDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Runtime double-guard (P1-4): candidate-ranking paths must never load
 * `heldout`. The type already forbids it; this defends against a caller that
 * bypasses TS (e.g. `["heldout" as any]`). `heldout` final evals flow through
 * `runHeldoutFinalEval`, not through these ranking entries.
 */
export function assertRankingSplits(scope: readonly BenchmarkSplit[]): void {
	for (const s of scope) {
		if (s === "heldout") {
			throw new Error(`candidate ranking must not load the held-out split (got "${s}"); use runHeldoutFinalEval for the independent post-freeze held-out eval.`);
		}
	}
}

export interface CandidateEvalOptions {
	benchmarkRoot: string;
	qualityDir: string;
	runId: string;
	candidateText: string;
	/** Optional short provenance note (e.g. the proposal hypothesis or source). */
	source?: string;
	runAt?: string;
	/**
	 * P1-4 held-out isolation: candidate ranking may only score train/dev.
	 * `split` is an ALLOWLIST scoped to RankingSplit (heldout is type-unreachable
	 * here). Defaults to train+dev so held-out is never read. To run the
	 * independent, post-freeze held-out final eval, use `runHeldoutFinalEval`.
	 */
	split?: readonly RankingSplit[];
}

/** Default candidate-scoring scope: train+dev. Held-out is excluded by default. */
export const CANDIDATE_EVAL_DEFAULT_SPLIT: readonly RankingSplit[] = ["train", "dev"];

export interface CandidateEvalResult {
	runId: string;
	candidateSha256: string;
	taskSuccessRate: number | null;
	caseCount: number;
	ledgerPath: string;
	note: string;
}

/**
 * Score a single candidate artifact over the whole benchmark using the
 * model-grader proxy, recording its digest in every ledger row, and persist
 * the run as candidate-eval.
 */
export async function runCandidateEval(opts: CandidateEvalOptions): Promise<CandidateEvalResult> {
	// BUG-P0-04/P1-4: candidate ranking is scoped to train+dev by default;
	// held-out must be requested ONLY through the independent, post-freeze
	// runHeldoutFinalEval entry — never through this ranking path.
	const scope = opts.split ?? CANDIDATE_EVAL_DEFAULT_SPLIT;
	assertRankingSplits(scope);
	const { cases, splitIndex } = loadBenchmark(opts.benchmarkRoot, scope);
	const digest = candidateDigest(opts.candidateText);

	if (cases.length === 0) throw new Error(`no cases found under ${opts.benchmarkRoot}`);

	const executor = proxyExecutor((_c: CaseRecord): string => opts.candidateText);

	// BUG-P1-10: production default runAt is a real UTC timestamp so multiple
	// runs never share the same ts. Callers that need determinism inject runAt.
	const run = await runAudit(cases, { runId: opts.runId, candidateSha256: digest, runAt: opts.runAt ?? new Date().toISOString() }, { executor, grader: modelGrader(), splitIndex });

	const source = opts.source ?? "candidate-eval (deterministic model-grader proxy)";
	const persisted = persistAuditRun(run, {
		qualityDir: opts.qualityDir,
		kind: "candidate-eval",
		note: `candidate-eval: deterministic model-grader proxy (sha256 ${digest.slice(0, 12)}…); splits=${scope.join("+")}; ${source}. NOT a routing-quality claim; real model/human grading required.`,
	});

	const ledgerRowCount = run.cases.filter((c) => c.row).length;
	return {
		runId: run.runId,
		candidateSha256: digest,
		taskSuccessRate: run.summary.taskSuccessRate,
		caseCount: run.summary.caseCount,
		ledgerPath: path.join(persisted.dir, "ledger.jsonl"),
		note: `candidate-eval persisted; ${ledgerRowCount} ledger rows; deterministic proxy grader (${source}).`,
	};
}

/** Run kind used by the independent, post-freeze held-out final eval (P1-4). */
export const HELDOUT_FINAL_EVAL_KIND = "heldout-final-eval";

export interface HeldoutFinalEvalOptions {
	benchmarkRoot: string;
	qualityDir: string;
	runId: string;
	candidateText: string;
	/** Optional short provenance note. */
	source?: string;
	runAt?: string;
}

export interface HeldoutFinalEvalResult {
	runId: string;
	candidateSha256: string;
	taskSuccessRate: number | null;
	caseCount: number;
	ledgerPath: string;
	note: string;
}

/**
 * Independent, post-freeze held-out final eval (P1-4).
 *
 * This is the ONLY sanctioned path that reads the `heldout` split. It differs
 * from `runCandidateEval` in two load-bearing ways:
 *  1. FREEZE requirement — the candidate must already be frozen as a recorded
 *     candidate-eval / candidate-agent-eval run in the quality dir whose
 *     candidateSha256 equals this candidate's digest. This reuses the existing
 *     pool record (candidateSha256 is pinned per candidate-eval ledger) as the
 *     freeze proof: you cannot run a held-out eval on a candidate that was never
 *     frozen via a train/dev ranking run.
 *  2. SEPARATE run kind (`heldout-final-eval`) so pool/evalreport present it
 *     apart from train/dev candidate runs and never mix it into the ranking
 *     aggregation.
 *
 * Runs the deterministic model-grader proxy over the held-out terminal set and
 * persists it under `kind: HELDOUT_FINAL_EVAL_KIND`.
 */
export async function runHeldoutFinalEval(opts: HeldoutFinalEvalOptions): Promise<HeldoutFinalEvalResult> {
	const digest = candidateDigest(opts.candidateText);
	// FREEZE verification: at least one recorded train/dev candidate run must pin
	// this exact digest before the held-out set may be touched.
	const frozen = listCandidateRuns(opts.qualityDir, { includeKind: ["candidate-eval", "candidate-agent-eval"] });
	if (!frozen.some((r) => r.candidateSha256 === digest)) {
		throw new Error(`candidate is NOT frozen: no recorded candidate-eval run has candidateSha256 ${digest.slice(0, 12)}…. Run candidate-eval (train/dev) and record a grade BEFORE held-out final eval.`);
	}

	// The held-out terminal set is loaded ONLY here, never through ranking.
	const { cases, splitIndex } = loadBenchmark(opts.benchmarkRoot, ["heldout"]);
	if (cases.length === 0) throw new Error(`no held-out cases found under ${opts.benchmarkRoot}`);

	const executor = proxyExecutor((_c: CaseRecord): string => opts.candidateText);
	const run = await runAudit(cases, { runId: opts.runId, candidateSha256: digest, runAt: opts.runAt ?? new Date().toISOString() }, { executor, grader: modelGrader(), splitIndex });

	const source = opts.source ?? "heldout-final-eval (deterministic model-grader proxy)";
	const persisted = persistAuditRun(run, {
		qualityDir: opts.qualityDir,
		kind: HELDOUT_FINAL_EVAL_KIND,
		note: `${HELDOUT_FINAL_EVAL_KIND}: independent POST-FREEZE final eval over the held-out terminal set (sha256 ${digest.slice(0, 12)}…); splits=heldout; ${source}. NOT a routing-quality claim; real model/human grading required.`,
	});

	const ledgerRowCount = run.cases.filter((c) => c.row).length;
	return {
		runId: run.runId,
		candidateSha256: digest,
		taskSuccessRate: run.summary.taskSuccessRate,
		caseCount: run.summary.caseCount,
		ledgerPath: path.join(persisted.dir, "ledger.jsonl"),
		note: `${HELDOUT_FINAL_EVAL_KIND} persisted; ${ledgerRowCount} ledger rows; deterministic proxy grader (${source}).`,
	};
}
