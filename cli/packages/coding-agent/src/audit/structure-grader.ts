/**
 * Structure grader — a deterministic, auditable grader with partial credit.
 *
 * Unlike the binary token grader, this scores each assertion by *required-token
 * coverage*: it extracts the assertion's distinctive tokens (file/API/path
 * identifiers, skipping stopwords) and awards partial credit proportional to how
 * many of them appear in the artifact. Full pass (1.0) only when every required
 * token is present; partial when ≥1; fail (0) when none. Deterministic for a
 * given (assertion, artifact) pair.
 *
 * This is a *richer baseline* for the B0/B1/B2 harness and an audit prober — it
 * is NOT a substitute for a human/model semantic judgment. It stays
 * deterministic so the runner's repeatability guarantees hold.
 */

import type { CaseRecord, CaseGrader, GradeSpec } from "./types.ts";
import { parseCaseAssertions } from "./parse.ts";

/** Extract distinctive required tokens from an assertion string. */
export function requiredTokens(assertion: string): string[] {
	const stop = new Set(["uses", "does", "is", "are", "the", "a", "an", "and", "or", "of", "to", "when", "for", "with", "that", "this", "should", "must", "routes", "response"]);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of assertion.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*/g)) {
		const token = m[0];
		if (stop.has(token.toLowerCase())) continue;
		// keep structured tokens (path/dot-api) always; short bare words only if not trivial
		if (!/[_/\\.]/.test(token) && token.length < 4) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
}

/**
 * Per-assertion partial-credit score = matched required tokens / total required
 * tokens, mapped to outcome pass(1.0)/partial(0< s <1)/fail(0).
 */
export function scoreAssertion(assertion: string, artifact: string): { outcome: GradeSpec["perAssertion"][number]["outcome"]; score: number } {
	const tokens = requiredTokens(assertion);
	if (tokens.length === 0) return { outcome: "fail", score: 0 };
	let matched = 0;
	for (const t of tokens) if (artifact.includes(t)) matched += 1;
	const ratio = matched / tokens.length;
	if (ratio >= 1) return { outcome: "pass", score: 1 };
	if (ratio > 0) return { outcome: "partial", score: ratio };
	return { outcome: "fail", score: 0 };
}

/** A deterministic structure grader over a case's assertions. */
export function structureGrader(): CaseGrader {
	return {
		// BUG-P1-13: this grader self-declares its coarse attribution category.
		// The structure grader is a mechanical model-proxy grade, so it declares
		// "model_grader" (a valid GradedBy) rather than a free-form string.
		gradedBy: "model_grader",
		async grade(caseRecord: CaseRecord, artifact: string): Promise<GradeSpec> {
			const assertions = parseCaseAssertions(caseRecord);
			const perAssertion = assertions.map((a) => {
				const { outcome, score } = scoreAssertion(a, artifact);
				return { assertion: a, outcome, score };
			});
			return { perAssertion };
		},
	};
}
