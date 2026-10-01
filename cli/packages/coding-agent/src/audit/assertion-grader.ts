/**
 * A deterministic assertion-level grader as a `CaseGrader` (P0-3 step 2, route A).
 *
 * Where the word-overlap proxy and even a model judge can be gamed by a fluent
 * but hollow artifact, this grader is deliberately strict and rule-based:
 *
 *   - An EMPTY / whitespace-only artifact satisfies NO assertion → case score 0.
 *   - An artifact with ZERO required-token relevance to any assertion is treated
 *     as unrelated → every assertion fails (score 0). This is the defense that
 *     stops a confident, off-topic blob from collecting ~0.5 "attempt credit".
 *   - Structured assertions (file-exists / command-output / numeric-range) are
 *     checked deterministically against the artifact text.
 *   - Free-form string assertions fall back to required-token coverage.
 *
 * It self-declares `gradedBy: "assertion"` (the schema's
 * `programmatic_assertion` source), which is the truthful attribution for a
 * deterministic, assertion-driven checker. It is fully offline and bit-for-bit
 * reproducible: the same `(case, artifact)` always yields the same grade.
 */

import type { CaseGrader, CaseRecord, GradeOutcome, GradeSpec } from "./types.ts";

/** Structured assertion kinds this grader can check deterministically. */
export type StructuredAssertionType =
	| "file-exists"
	| "command-output"
	| "numeric-range";

export interface StructuredAssertion {
	readonly type: StructuredAssertionType;
	/** For file-exists: the path(s) that must appear in the artifact. */
	readonly path?: string | string[];
	/** For command-output: a substring/regexp the artifact must contain. */
	readonly expect?: string;
	readonly pattern?: string;
	/** For numeric-range: inclusive numeric bounds and the value to check. */
	readonly value?: number;
	readonly min?: number;
	readonly max?: number;
	/** For numeric-range: label to find in the artifact, plus the value to check. */
	readonly label?: string;
}

/** Empty / whitespace-only artifact ⇒ every assertion fails (score 0). */
export function isEmptyArtifact(artifact: string): boolean {
	return artifact.trim().length === 0;
}

/** A path is "present" when its basename (or full path) appears in the artifact. */
function pathMentioned(pathSpec: string | string[] | undefined, artifact: string): boolean {
	if (!pathSpec) return false;
	const paths = Array.isArray(pathSpec) ? pathSpec : [pathSpec];
	return paths.some((p) => {
		if (!p) return false;
		if (artifact.includes(p)) return true;
		const base = p.split(/[\\/]/).pop() ?? p;
		return artifact.includes(base);
	});
}

/** Extract the first number that looks like the value the assertion cares about. */
function extractNumber(artifact: string, label?: string): number | undefined {
	if (label && label.length > 0) {
		const re = new RegExp(`(?:${label}\\s*[:=]?\\s*)(-?\\d+(?:\\.\\d+)?)`, "i");
		const m = artifact.match(re);
		if (m) return Number(m[1]);
	}
	const m = artifact.match(/-?\d+(?:\.\d+)?/);
	return m ? Number(m[0]) : undefined;
}

/**
 * Deterministically check ONE structured assertion against the artifact text.
 * Returns `{ pass: boolean, reason: string }`.
 */
export function checkStructured(assertion: StructuredAssertion, artifact: string): { pass: boolean; reason: string } {
	switch (assertion.type) {
		case "file-exists": {
			const ok = pathMentioned(assertion.path, artifact);
			return { pass: ok, reason: ok ? "artifact mentions expected file" : "artifact does not mention expected file" };
		}
		case "command-output": {
			const wanted = assertion.expect ?? assertion.pattern;
			if (!wanted) return { pass: false, reason: "command-output assertion missing expect/pattern" };
			const ok = artifact.includes(wanted);
			return { pass: ok, reason: ok ? "artifact contains expected output" : "artifact lacks expected output" };
		}
		case "numeric-range": {
			const value = assertion.value ?? extractNumber(artifact, assertion.label);
			if (value === undefined) return { pass: false, reason: "no numeric value found in artifact" };
			const min = assertion.min;
			const max = assertion.max;
			const ok = (min === undefined || value >= min) && (max === undefined || value <= max);
			return {
				pass: ok,
				reason: ok ? `value ${value} satisfies range` : `value ${value} outside expected range`,
			};
		}
		default:
			return { pass: false, reason: "unsupported assertion type" };
	}
}

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "it",
	"is", "are", "be", "should", "must", "that", "this", "output", "file", "return",
]);

/** Distinct required tokens of a free-form assertion: identifiers and path-ish tokens. */
export function requiredTokens(assertion: string): string[] {
	const matches = assertion.match(/[A-Za-z_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*/g) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of matches) {
		const lower = m.toLowerCase();
		if (STOPWORDS.has(lower) || seen.has(lower)) continue;
		seen.add(lower);
		out.push(m);
	}
	return out;
}

/** Coverage of an assertion's required tokens inside the artifact (0..1). */
export function tokenCoverage(assertion: string, artifact: string): number {
	const tokens = requiredTokens(assertion);
	if (tokens.length === 0) return 0;
	let hit = 0;
	const lower = artifact.toLowerCase();
	for (const t of tokens) {
		if (lower.includes(t.toLowerCase())) hit += 1;
	}
	return hit / tokens.length;
}

/** A free-form assertion passes deterministically when its coverage is complete. */
function freeFormOutcome(assertion: string, artifact: string): GradeOutcome {
	const cov = tokenCoverage(assertion, artifact);
	return {
		assertion,
		outcome: cov >= 1 ? "pass" : cov > 0 ? "partial" : "fail",
		score: cov,
	};
}

/** Try to interpret an assertion entry as a structured assertion (JSON object). */
export function tryParseStructured(entry: unknown): StructuredAssertion | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Record<string, unknown>;
	const type = e.type;
	if (type !== "file-exists" && type !== "command-output" && type !== "numeric-range") return null;
	return {
		type,
		path: e.path as string | string[] | undefined,
		expect: typeof e.expect === "string" ? e.expect : undefined,
		pattern: typeof e.pattern === "string" ? e.pattern : undefined,
		value: typeof e.value === "number" ? e.value : undefined,
		min: typeof e.min === "number" ? e.min : undefined,
		max: typeof e.max === "number" ? e.max : undefined,
		label: typeof e.label === "string" ? e.label : undefined,
	};
}

/**
 * A deterministic, assertion-driven grader. It reads structured assertions
 * (file-exists / command-output / numeric-range) and grades them for real;
 * free-form string assertions are graded by required-token coverage. An empty or
 * unrelated artifact is always failed, never given partial "attempt" credit.
 */
export function assertionGrader(): CaseGrader {
	return {
		gradedBy: "assertion",
		async grade(caseRecord: CaseRecord, artifact: string): Promise<GradeSpec> {
			const entries: unknown[] = (() => {
				try {
					const parsed = JSON.parse(caseRecord.files.assertionsText) as { assertions?: unknown };
					return Array.isArray(parsed.assertions) ? parsed.assertions : [];
				} catch {
					return [];
				}
			})();

			// Acceptance #5: a hollow artifact must score 0, not ~0.5.
			if (isEmptyArtifact(artifact)) {
				return {
					perAssertion: entries.map((entry, i) => ({
						assertion: stringifyEntry(entry, i),
						outcome: "fail",
						score: 0,
					})),
				};
			}

			const outcomes: GradeOutcome[] = [];
			for (const entry of entries) {
				const structured = tryParseStructured(entry);
				if (structured) {
					const r = checkStructured(structured, artifact);
					outcomes.push({ assertion: stringifyEntry(entry, outcomes.length), outcome: r.pass ? "pass" : "fail", score: r.pass ? 1 : 0 });
					continue;
				}
				const text = typeof entry === "string" ? entry : JSON.stringify(entry);
				outcomes.push(freeFormOutcome(text, artifact));
			}

			// Unrelated-artifact guard: if NO assertion shows any token overlap with
			// the artifact, the artifact is off-topic — fail every assertion. This is
			// what prevents a confident but irrelevant blob from collecting ~0.5.
			const anyRelevant = outcomes.some((o) => (o.score ?? 0) > 0);
			if (!anyRelevant && outcomes.length > 0) {
				return {
					perAssertion: outcomes.map((o) => ({ assertion: o.assertion, outcome: "fail", score: 0 })),
				};
			}

			return { perAssertion: outcomes };
		},
	};
}

function stringifyEntry(entry: unknown, index: number): string {
	if (typeof entry === "string") return entry;
	try {
		return JSON.stringify(entry);
	} catch {
		return `assertion[${index}]`;
	}
}
