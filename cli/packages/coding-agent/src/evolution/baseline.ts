/**
 * Step 4 收口 — equal-budget baselines B0/B1/B2 + genealogy.
 *
 * Set up the RQ2 comparison HARNESS: three *deterministic* candidate executors
 * (retry / random-edit / propose), run over the SAME real 43-case benchmark with
 * the SAME deterministic grader and SAME budget (one artifact per case). This is
 * measurement infrastructure, not a claim: every produced number is a
 * baseline-plumbing demonstration of the harness, never a routing-quality result.
 *
 * Determinism: same seeds → identical candidate artifacts → identical arm
 * summaries. Retry/random-edit/propose all share the same case set + grader so
 * the comparison is apples-to-apples.
 */

import type { CaseRecord, CaseExecutor, CaseGrader } from "../audit/types.ts";
import { proxyExecutor } from "../audit/types.ts";
import { runAudit } from "../audit/runner.ts";
import { tokenGrader } from "../audit/grader.ts";
import { defaultRequiredFragment, parseCaseAssertions } from "../audit/parse.ts";
import { loadBenchmark } from "../audit/loader.ts";
import type { SplitIndex } from "../audit/runner.ts";
import { assertRankingSplits, type RankingSplit } from "./candidate-eval.ts";

export type CompareArm = "B0_retry" | "B1_random_edit" | "B2_propose";

/** Deterministic FNV-1a 32-bit hash (stable, no crypto dependency). */
export function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** A tiny deterministic LCG so "random" edits are reproducible across runs. */
function lcg(value: number): number {
	return (Math.imul(value, 1664525) + 1013904223) >>> 0;
}

const SENTINEL = "<baseline-plumbing artifact: no agent executed>";

/** B0 — retry: candidate is identical repeated retries of the baseline. */
export function makeRetryExecutor(): CaseExecutor {
	return proxyExecutor((_c: CaseRecord): string => SENTINEL);
}

/**
 * B1 — random-edit: a seeded pseudo-random token drawn from the case's own
 * assertions is appended to the artifact, so repeated-run behavior is
 * reproducible but the "edit" varies by case/seed/arm.
 */
export function makeRandomEditExecutor(seed: string): CaseExecutor {
	return proxyExecutor((c: CaseRecord): string => {
		const assertions = parseCaseAssertions(c);
		const tokenPool = assertions.map(defaultRequiredFragment).filter((t): t is string => t !== null);
		const base = fnv1a(`${seed}|${c.skillId}|${c.caseId}|random`);
		let pick = base;
		if (tokenPool.length === 0) return `${SENTINEL} (no assertions to edit)`;
		const token = tokenPool[pick % tokenPool.length];
		pick = lcg(pick);
		return `${SENTINEL} ${token} #edit${pick % 100000}`;
	});
}

/**
 * B2 — propose: the propose-only hypothesis text is the candidate artifact,
 * deterministically derived from the arm + skill.
 */
export function makeProposeExecutor(seed: string, hypothesisFor?: (skillId: string) => string): CaseExecutor {
	return proxyExecutor((c: CaseRecord): string => {
		const hypothesis = hypothesisFor
			? hypothesisFor(c.skillId)
			: `propose candidate for ${c.skillId} (seed ${seed})`;
		return `HYPOTHESIS: ${hypothesis}`;
	});
}

export interface BaselineComparison {
	arms: Record<CompareArm, { taskSuccessRate: number | null; perSkill: Record<string, number | null> }>;
	caseCount: number;
	grader?: "token" | "structure" | "injected";
	// Non-claim guardrail: this comparison exercises the harness only.
	note: string;
}

/**
 * Run the three arms over the SAME real benchmark with the SAME grader.
 * Budget is identical (one artifact per case per arm). Results are harness
 * demonstration only — always non-empirical until a real grader is injected.
 */
export async function compareBaselines(
	benchmarkRoot: string,
	seed: string,
	hypothesisFor?: (skillId: string) => string,
	grader?: CaseGrader,
	split?: readonly RankingSplit[],
): Promise<BaselineComparison> {
	// BUG-P0-04/P1-4: harness arms (incl. random-edit/propose executors) must not
	// read held-out; default scope is train+dev. A held-out baseline is only ever
	// run as an explicit, independent post-freeze terminal comparison via
	// `runHeldoutFinalEval`, never through this ranking path.
	const scope = split ?? ["train", "dev"];
	assertRankingSplits(scope);
	const { cases, splitIndex } = loadBenchmark(benchmarkRoot, scope);
	const effectiveGrader: CaseGrader = grader ?? tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
	const graderName = grader ? "injected" : "token";

	const arms: Record<CompareArm, { taskSuccessRate: number | null; perSkill: Record<string, number | null> }> = {
		B0_retry: await armSummary(cases, effectiveGrader, splitIndex, makeRetryExecutor(), "B0_retry", seed),
		B1_random_edit: await armSummary(cases, effectiveGrader, splitIndex, makeRandomEditExecutor(seed), "B1_random_edit", seed),
		B2_propose: await armSummary(cases, effectiveGrader, splitIndex, makeProposeExecutor(seed, hypothesisFor), "B2_propose", seed),
	};

	return {
		arms,
		caseCount: cases.length,
		grader: graderName as BaselineComparison["grader"],
		note: `Equal-budget baseline HARNESS demonstration (B0/B1/B2) with ${graderName} grader. NOT a routing-quality result. Real agent/human grading + real candidate executors required before any arm comparison is meaningful.`,
	};
}

async function armSummary(
	cases: CaseRecord[],
	grader: CaseGrader,
	splitIndex: SplitIndex,
	executor: CaseExecutor,
	arm: CompareArm,
	seed: string,
): Promise<{ taskSuccessRate: number | null; perSkill: Record<string, number | null> }> {
	// BUG-P1-10: real UTC timestamp so baseline arms carry distinct, honest ts.
	const run = await runAudit(cases, { runId: `arm-${arm}-${seed}`, runAt: new Date().toISOString() }, { executor, grader, splitIndex });
	return { taskSuccessRate: run.summary.taskSuccessRate, perSkill: run.summary.perSkill };
}
