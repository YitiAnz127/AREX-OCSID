import { describe, expect, it } from "vitest";
import { requiredTokens, scoreAssertion, structureGrader } from "./structure-grader.ts";
import type { CaseRecord } from "./types.ts";

function mkCase(assertions: string[]): CaseRecord {
	return { skillId: "chemprop", caseId: "x", files: { userRequest: "u", assertionsText: JSON.stringify({ schema: "disco.usability-case.v1", target_skill_area: "x", target_capability: "y", difficulty: "basic", evidence_basis: [], expected_skill_files: [], assertions }) } };
}

describe("structure grader", () => {
	it("extracts distinctive structured tokens and drops stopwords", () => {
		const tokens = requiredTokens("the response routes to cli-serving and uses build_cli_command.py");
		expect(tokens).toContain("cli-serving");
		expect(tokens).toContain("build_cli_command.py");
		expect(tokens).not.toContain("the");
		expect(tokens).not.toContain("routes");
	});

	it("awards full pass, partial, and fail deterministically", () => {
		expect(scoreAssertion("uses build_cli_command.py", "build_cli_command.py is used")).toEqual({ outcome: "pass", score: 1 });
		const partial = scoreAssertion("uses build_cli_command.py and smoke_model.py", "only build_cli_command.py appears");
		expect(partial.outcome).toBe("partial");
		expect(partial.score).toBeGreaterThan(0);
		expect(partial.score).toBeLessThan(1);
		expect(scoreAssertion("uses gget.search", "nothing relevant")).toEqual({ outcome: "fail", score: 0 });
	});

	it("passes through the runner pipeline with partial credit", async () => {
		const g = structureGrader();
		const spec = await g.grade(mkCase(["uses build_cli_command.py and smoke_model.py"]), "build_cli_command.py only");
		expect(spec.perAssertion[0].outcome).toBe("partial");
	});
});
