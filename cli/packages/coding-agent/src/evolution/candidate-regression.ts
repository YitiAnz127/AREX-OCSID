/**
 * Candidate-family regression — compare a batch of evolution candidates on the
 * SAME frozen benchmark with the SAME deterministic grader, aggregating by
 * genealogy (generation / parent) so the harness can surface "which class of
 * candidate scores higher/reproducibly" for a round of proposals.
 *
 * Honesty contract:
 *  - Reuses candidate-eval's deterministic model-grader PROXY, so any ranking
 *    here is a HARNESS DEMONSTRATION, not a routing-quality or causal claim.
 *  - Swapping in a real grader later changes only the grading function; this
 *    aggregation harness is shape-identical to what a real-model comparison uses.
 *  - All candidates share the same benchmark + grader + run window; ordering and
 *    digests are deterministic.
 */

import { runCandidateEval, CANDIDATE_EVAL_DEFAULT_SPLIT, assertRankingSplits, type RankingSplit } from "./candidate-eval.ts";
import { assertCanonicalId, validateId } from "../audit/id.ts";

export interface CandidateFamilyMember {
	candidateId: string;
	text: string;
	hypothesis?: string;
	parentRoundId?: string;
	generation?: number;
}

export interface CandidateRegressionOptions {
	benchmarkRoot: string;
	qualityDir: string;
	/** Base run id; each candidate persists under `${runId}-${candidateId}`. */
	runId: string;
	candidates: CandidateFamilyMember[];
	/**
	 * P1-4 held-out isolation: split allowlist for candidate ranking. Ranking
	 * must only ever score train/dev (`heldout` is type-unreachable here); the
	 * held-out terminal set is never post-hoc selected against. Use
	 * `runHeldoutFinalEval` for the independent post-freeze held-out eval.
	 */
	split?: readonly RankingSplit[];
}

export interface CandidateRegressionResult {
	runId: string;
	caseCount: number;
	perCandidate: Array<{
		candidateId: string;
		candidateSha256: string;
		taskSuccessRate: number | null;
		generation?: number;
		parentRoundId?: string;
		hypothesis?: string;
	}>;
	/** Mean task_success_rate per generation (no causal claim). */
	byGeneration: Array<{ generation: number; mean: number | null; count: number }>;
	/** Best candidate by score (null-safe). */
	best: { candidateId: string; taskSuccessRate: number | null } | null;
	note: string;
}

export async function runCandidateRegression(opts: CandidateRegressionOptions): Promise<CandidateRegressionResult> {
	if (opts.candidates.length === 0) throw new Error("no candidates to evaluate");
	// BUG-P0-02: validate ids before they enter path.join via candidate-eval.
	assertCanonicalId(opts.runId, "runId");
	for (const c of opts.candidates) {
		const err = validateId(c.candidateId, "candidateId");
		if (err !== null) throw new Error(`invalid candidate "${c.candidateId}": ${err}`);
		// The COMPOSED id is what actually reaches the filesystem (see the
		// runId below). Both halves are individually ≤128 chars, so the
		// concatenation can exceed the limit and would otherwise be rejected only
		// inside persistAuditRun — after the entire candidate loop had already run
		// and written runs. Fail before any work happens.
		const composedErr = validateId(`${opts.runId}-${c.candidateId}`, "candidate runId");
		if (composedErr !== null) {
			throw new Error(`candidate "${c.candidateId}": ${composedErr}; shorten --run or the candidate id`);
		}
	}

	const perCandidate: CandidateRegressionResult["perCandidate"] = [];
	const genMap = new Map<number, { sum: number; count: number }>();
	let caseCount = 0;
	const scope = opts.split ?? CANDIDATE_EVAL_DEFAULT_SPLIT;
	// P1-4: defensive runtime guard — ranking may never touch heldout.
	assertRankingSplits(scope);

	for (const c of opts.candidates) {
		const res = await runCandidateEval({
			benchmarkRoot: opts.benchmarkRoot,
			qualityDir: opts.qualityDir,
			runId: `${opts.runId}-${c.candidateId}`,
			candidateText: c.text,
			source: c.hypothesis ? `candidate-family:${c.candidateId} (${c.hypothesis})` : `candidate-family:${c.candidateId}`,
			split: scope,
		});
		if (caseCount === 0) caseCount = res.caseCount;
		perCandidate.push({
			candidateId: c.candidateId,
			candidateSha256: res.candidateSha256,
			taskSuccessRate: res.taskSuccessRate,
			generation: c.generation,
			parentRoundId: c.parentRoundId,
			hypothesis: c.hypothesis,
		});
		if (c.generation !== undefined && res.taskSuccessRate !== null) {
			const e = genMap.get(c.generation) ?? { sum: 0, count: 0 };
			e.sum += res.taskSuccessRate;
			e.count += 1;
			genMap.set(c.generation, e);
		}
	}

	const byGeneration = [...genMap.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([generation, { sum, count }]) => ({ generation, mean: count ? sum / count : null, count }));

	// Stable ranking: tie-break by candidateId so ordering is deterministic.
	const ranked = [...perCandidate].sort((a, b) => {
		const ra = a.taskSuccessRate ?? -1;
		const rb = b.taskSuccessRate ?? -1;
		if (rb !== ra) return rb - ra;
		return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
	});
	const best = ranked.length > 0 ? { candidateId: ranked[0].candidateId, taskSuccessRate: ranked[0].taskSuccessRate } : null;

	return {
		runId: opts.runId,
		caseCount,
		perCandidate: ranked,
		byGeneration,
		best,
		note: `candidate-family regression (${perCandidate.length} candidates, deterministic model-grader PROXY, splits=${scope.join("+")}). Ranking is a HARNESS DEMONSTRATION, NOT a routing-quality or causal claim; real model/human grading required.`,
	};
}
