/**
 * Fast, deterministic parsing helpers for audit cases and the baseline token
 * grader. Kept side-effect-free so the runner's reproducibility holds.
 */

import type { CaseRecord } from "./types.ts";

/** Parse the `assertions` list out of a case's assertions.json text. */
export function parseCaseAssertions(caseRecord: CaseRecord): string[] {
	try {
		const parsed = JSON.parse(caseRecord.files.assertionsText) as { assertions?: unknown };
		if (Array.isArray(parsed.assertions)) {
			return parsed.assertions.filter((a): a is string => typeof a === "string");
		}
	} catch {
		// fall through
	}
	return [];
}

/**
 * Baseline required-fragment strategy: from an assertion string, pick the most
 * *distinctive* token as the must-appear fragment — preferring an identifier
 * that carries structure (underscore, dot, slash: a file/API/path token) over a
 * bare common verb. Returns null when nothing distinctive is found. This is a
 * strict, repeatable baseline; it intentionally under-credits natural-language
 * assertions.
 */
export function defaultRequiredFragment(assertion: string): string | null {
	const tokens = /[A-Za-z_][A-Za-z0-9_.]*(?:\/[A-Za-z0-9_.-]+)*/g;
	const matches = [...assertion.matchAll(tokens)].map((m) => m[0]);
	if (matches.length === 0) return null;
	// Prefer a structured token (file path / dot-API / snake_case).
	const structured = matches.find((t) => /[_/\\.]/.test(t));
	if (structured) return structured;
	// Fall back to the longest bare identifier, skipping the most common verbs.
	const stop = new Set(["uses", "does", "is", "are", "the", "a", "an", "and", "or", "of", "to", "when", "for"]);
	const candidate = matches.filter((t) => !stop.has(t.toLowerCase())).sort((a, b) => b.length - a.length)[0];
	return candidate ?? matches[0];
}
