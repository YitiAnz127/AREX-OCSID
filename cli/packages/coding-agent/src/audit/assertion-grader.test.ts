import { describe, expect, it } from "vitest";
import { assertionGrader, checkStructured, isEmptyArtifact, requiredTokens, tokenCoverage, tryParseStructured } from "./assertion-grader.ts";
import type { CaseRecord } from "./types.ts";

function mkCase(assertions: unknown[]): CaseRecord {
	return { skillId: "chemprop", caseId: "x", files: { userRequest: "u", assertionsText: JSON.stringify({ schema: "ocsid.usability-case.v1", target_skill_area: "x", target_capability: "y", difficulty: "basic", evidence_basis: [], expected_skill_files: [], assertions }) } };
}

describe("assertion-grader (route A, deterministic)", () => {
	it("declares gradedBy 'assertion'", () => {
		expect(assertionGrader().gradedBy).toBe("assertion");
	});

	it("P0-3 ACCEPTANCE #5: an EMPTY artifact scores 0, never ~0.5", async () => {
		const g = assertionGrader();
		const grade = await g.grade(mkCase(["produces a temperature forecast", "outputs numeric temperatures"]), "");
		expect(grade.perAssertion.length).toBe(2);
		for (const o of grade.perAssertion) {
			expect(o.outcome).toBe("fail");
			expect(o.score).toBe(0);
		}
	});

	it("P0-3 ACCEPTANCE #5: a whitespace-only artifact scores 0", async () => {
		const grade = await assertionGrader().grade(mkCase(["lists all detected isotopes"]), "   \n\t  ");
		expect(grade.perAssertion[0].outcome).toBe("fail");
		expect(grade.perAssertion[0].score).toBe(0);
	});

	it("P0-3 ACCEPTANCE #5: an UNRELATED artifact (no token overlap) scores 0, never ~0.5", async () => {
		const g = assertionGrader();
		// The artifact is fluent and confident but entirely about an unrelated topic.
		const grade = await g.grade(
			mkCase(["uses build_cli_command.py and smoke_model.py to validate", "reports cross-validation AUC"]),
			"The delightful autumn weather brought crisp air and golden leaves across the park.",
		);
		expect(grade.perAssertion.length).toBe(2);
		for (const o of grade.perAssertion) {
			expect(o.outcome).toBe("fail");
			expect(o.score).toBe(0);
		}
	});

	it("a relevant full-coverage artifact passes", async () => {
		const grade = await assertionGrader().grade(mkCase(["uses build_cli_command.py"]), "uses build_cli_command.py and smoke_model.py");
		expect(grade.perAssertion[0].outcome).toBe("pass");
		expect(grade.perAssertion[0].score).toBe(1);
	});

	it("deterministic structured file-exists assertion", () => {
		expect(checkStructured({ type: "file-exists", path: "scripts/predict.py" }, "wrote scripts/predict.py")).toEqual({ pass: true, reason: "artifact mentions expected file" });
		expect(checkStructured({ type: "file-exists", path: "scripts/predict.py" }, "nothing about files")).toEqual({ pass: false, reason: "artifact does not mention expected file" });
	});

	it("deterministic structured command-output assertion", () => {
		expect(checkStructured({ type: "command-output", expect: "model saved" }, "training done, model saved successfully")).toEqual({ pass: true, reason: "artifact contains expected output" });
		expect(checkStructured({ type: "command-output", expect: "model saved" }, "training done")).toEqual({ pass: false, reason: "artifact lacks expected output" });
	});

	it("deterministic structured numeric-range assertion", () => {
		expect(checkStructured({ type: "numeric-range", label: "AUC", min: 0.5, max: 1 }, "AUC: 0.91")).toEqual({ pass: true, reason: "value 0.91 satisfies range" });
		expect(checkStructured({ type: "numeric-range", value: 0.9, min: 0.95, max: 1 }, "whatever")).toEqual({ pass: false, reason: "value 0.9 outside expected range" });
	});

	it("parses structured assertion objects and falls back for plain strings", () => {
		expect(tryParseStructured({ type: "file-exists", path: "x.py" })).not.toBeNull();
		expect(tryParseStructured({ type: "command-output", expect: "ok" })).not.toBeNull();
		expect(tryParseStructured({ type: "numeric-range", min: 0, max: 1 })).not.toBeNull();
		expect(tryParseStructured({ type: "unknown" })).toBeNull();
		expect(tryParseStructured("plain string")).toBeNull();
	});

	it("scores structured assertions through the CaseGrader", async () => {
		const g = assertionGrader();
		const grade = await g.grade(
			mkCase([
				{ type: "file-exists", path: "predict.py" },
				{ type: "numeric-range", label: "AUC", min: 0.5, max: 1 },
			]),
			"predict.py written, AUC: 0.88",
		);
		expect(grade.perAssertion[0].outcome).toBe("pass");
		expect(grade.perAssertion[1].outcome).toBe("pass");
	});

	it("helper invariants", () => {
		expect(isEmptyArtifact("")).toBe(true);
		expect(isEmptyArtifact("\n  ")).toBe(true);
		expect(isEmptyArtifact("x")).toBe(false);
		expect(requiredTokens("uses build_cli_command.py")).toContain("build_cli_command.py");
		expect(tokenCoverage("uses build_cli_command.py", "nothing here")).toBe(0);
	});
});
