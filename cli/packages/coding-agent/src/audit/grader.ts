/**
 * Deterministic baseline grader for the audit runner.
 *
 * This is a *deterministic, no-LLM* grader used for reproducibility tests and as
 * a strict baseline. It scores each assertion purely by string matching: an
 * assertion counts as `pass` (score 1.0) only when the artifact contains a
 * required-fragment token; otherwise it is `fail` (score 0.0). It never emits
 * `partial`, so its mean is exactly the pass ratio and is fully repeatable.
 *
 * This is intentionally NOT a high-quality semantic grader — it exists to make
 * the runner's determinism provable and to sanity-check piping. Real grading
 * (assertion / human / model_grader) plugs in via `CaseGrader` without changing
 * the runner.
 */

import type { CaseRecord, CaseGrader, GradeSpec } from "./types.ts";

export interface TokenGraderDeps {
	/** Map an assertion string to a required fragment. */
	requiredFragment(assertion: string): string | null;
	/** Expose the parsed assertions list for a case. */
	parsedAssertions(caseRecord: CaseRecord): string[];
}

/**
 * Build a deterministic token grader: every assertion passes iff its required
 * fragment is present in the artifact. Missing/empty fragment ⇒ auto-fail.
 */
export function tokenGrader(deps: TokenGraderDeps): CaseGrader {
	return {
		// P0-3 step 1: this grader is a deterministic token-overlap proxy, so it
		// honestly declares `token_overlap` (NOT model_grader, which never applied
		// to this pure string-matcher). The runner records this category instead of
		// hardcoding one (BUG-P1-13).
		gradedBy: "token_overlap",
		async grade(caseRecord: CaseRecord, artifact: string): Promise<GradeSpec> {
			const assertions = deps.parsedAssertions(caseRecord);
			const perAssertion = assertions.map((assertion) => {
				const fragment = deps.requiredFragment(assertion);
				const pass = fragment !== null && fragment.length > 0 && artifact.includes(fragment);
				return { assertion, outcome: (pass ? "pass" : "fail") as GradeSpec["perAssertion"][number]["outcome"], score: pass ? 1 : 0 };
			});
			return { perAssertion };
		},
	};
}
