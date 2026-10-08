import { describe, expect, it } from "vitest";
import { gradeAssertionModel, modelGrader } from "./model-grader.ts";
import type { CaseRecord } from "./types.ts";

function mkCase(assertions: string[]): CaseRecord {
	return { skillId: "chemprop", caseId: "x", files: { userRequest: "u", assertionsText: JSON.stringify({ schema: "ocsid.usability-case.v1", target_skill_area: "x", target_capability: "y", difficulty: "basic", evidence_basis: [], expected_skill_files: [], assertions }) } };
}

describe("model-grader proxy", () => {
	it("awards full, partial, and fail deterministically", () => {
		expect(gradeAssertionModel("uses build_cli_command.py and smoke_model.py", "both build_cli_command.py and smoke_model.py present")).toEqual({ outcome: "pass", score: 1 });
		const partial = gradeAssertionModel("uses build_cli_command.py and smoke_model.py", "only build_cli_command.py present");
		expect(partial.outcome).toBe("partial");
		expect(partial.score).toBeGreaterThan(0);
		expect(partial.score).toBeLessThan(1);
		expect(gradeAssertionModel("uses gget.search", "nothing here")).toEqual({ outcome: "fail", score: 0 });
	});

	it("handles negated assertions inversely (presence of the negated token lowers the score)", () => {
		const withToken = gradeAssertionModel("does not claim routes-to-pharma", "it routes-to-pharma loudly");
		const without = gradeAssertionModel("does not claim routes-to-pharma", "no mention anywhere");
		// Absence of the negated token must score strictly better than its presence.
		expect(withToken.score).toBeLessThan(without.score);
		expect(without.outcome).toBe("pass");
	});

	it("BUG (negation): detects a leading-subject negation predicate ('The response does not …') as negation, not a positive requirement", () => {
		// The benchmark's dominant negation form starts with a subject noun-phrase
		// before the modal. The old ^-anchored regex missed it and demanded the
		// forbidden token be PRESENT (false-fail on correct avoidance, false-pass on
		// wrongful inclusion).
		const violated = gradeAssertionModel("The response does not expose custom-image credentials", "it exposes custom-image credentials");
		const clean = gradeAssertionModel("The response does not expose custom-image credentials", "the response is fully sanitized");
		expect(clean.outcome).toBe("pass");
		expect(clean.score).toBe(1);
		expect(violated.outcome).toBe("fail");
		expect(violated.score).toBeLessThan(clean.score);
	});

	it("is deterministic and idempotent across identical inputs", async () => {
		const g = modelGrader();
		const a = await g.grade(mkCase(["uses build_cli_command.py"]), "build_cli_command.py used");
		const b = await g.grade(mkCase(["uses build_cli_command.py"]), "build_cli_command.py used");
		expect(a).toEqual(b);
		expect(a.perAssertion[0].score).toBe(1);
	});
});
