/**
 * Model-grader PROXY — a deterministic semantic grader for candidate eval.
 *
 * This is NOT an LLM. It is a deterministic proxy for a model grader, so the
 * candidate-evaluation pipeline is reproducible and testable. It grades each
 * assertion by required-token coverage with negation awareness: an assertion
 * introduced by "does NOT claim"/"should NOT"/"does not" is scored on how well
 * the artifact AVOIDS that token (inverse coverage). Everything is a pure
 * function of (assertion, artifact), so identical inputs → identical scores.
 *
 * It implements CaseGrader, so it can be injected wherever a real model grader
 * will later sit. Swapping this proxy for an actual model changes only the
 * grading function, not the runner, ledger, or persistence.
 */

import type { CaseRecord, CaseGrader, GradeSpec } from "./types.ts";
import { parseCaseAssertions } from "./parse.ts";
import { requiredTokens } from "./structure-grader.ts";

// Dark-defect fix: the negation marker is commonly written in the benchmark as a
// leading-subject predicate ("The response does not ...", "The system should not ..."),
// which the old anchored `^(should not|does not|...)\b` regex missed entirely — those
// assertions were silently graded as POSITIVE (forbidden content was rewarded, absence
// was failed). Allow one optional leading subject noun-phrase ("<the|a|an> <noun>")
// before the negation keyword so the dominant real-world form is detected as negation.
// Compound "X and does not Y" assertions (negation mid-sentence) are intentionally NOT
// flipped: the proxy's single-negation model cannot represent mixed positive+negative
// clauses, and flipping them would mis-grade the positive half.
//
// The keyword list and the subject prefix are both load-bearing. A negation form
// that is missing here is not merely "unrecognized" — it is graded as a POSITIVE
// assertion, so the forbidden token becomes required-present and its absence is
// failed. That inverts the grade. Hence the copula forms ("is not", "cannot",
// "will not") alongside the modal ones, and a subject prefix that tolerates up to
// three words ("The output file is not truncated").
const NEGATED =
	/^(?:(?:the|a|an)\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,2}\s+)?(?:should not|shouldn't|does not|doesn't|do not|don't|must not|mustn't|shall not|shan't|is not|isn't|are not|aren't|was not|wasn't|were not|weren't|cannot|can not|can't|will not|won't|would not|wouldn't|could not|couldn't|may not|might not|never|not)\b/i;

/** Grade a single assertion against an artifact with negation awareness. */
export function gradeAssertionModel(assertion: string, artifact: string): { outcome: GradeSpec["perAssertion"][number]["outcome"]; score: number } {
	const tokens = requiredTokens(assertion);
	const negated = NEGATED.test(assertion.trim());
	if (tokens.length === 0) return { outcome: "fail", score: 0 };

	let present = 0;
	for (const t of tokens) if (artifact.includes(t)) present += 1;

	// Negated assertion: good = token ABSENT; strong absence = full credit.
	let coverage: number;
	if (negated) {
		coverage = (tokens.length - present) / tokens.length;
	} else {
		coverage = present / tokens.length;
	}

	if (coverage >= 1) return { outcome: "pass", score: 1 };
	if (coverage > 0) return { outcome: "partial", score: coverage };
	return { outcome: "fail", score: 0 };
}

/** Deterministic model-grader proxy over a case's assertions. */
export function modelGrader(): CaseGrader {
	return {
		// BUG-P1-13: this grader self-declares its coarse attribution category.
		gradedBy: "model_grader",
		async grade(caseRecord: CaseRecord, artifact: string): Promise<GradeSpec> {
			const assertions = parseCaseAssertions(caseRecord);
			const perAssertion = assertions.map((a) => {
				const { outcome, score } = gradeAssertionModel(a, artifact);
				return { assertion: a, outcome, score };
			});
			return { perAssertion };
		},
	};
}
