import { describe, expect, it } from "vitest";
import { parseCaseAssertions, defaultRequiredFragment } from "./parse.ts";
import { tokenGrader } from "./grader.ts";
import { runAudit } from "./runner.ts";
import type { CaseExecutor, CaseRecord, CaseGrader, ExecutionResult } from "./types.ts";

const splitIndex: Record<string, string> = { "gget:case-c": "dev" };

function caseRecord(skillId: string, caseId: string, assertions: string[]): CaseRecord {
	return {
		skillId,
		caseId,
		files: {
			userRequest: `please help with ${caseId}`,
			assertionsText: JSON.stringify({
				schema: "disco.usability-case.v1",
				target_skill_area: "x",
				target_capability: "y",
				difficulty: "basic",
				evidence_basis: [],
				expected_skill_files: [],
				assertions,
			}),
		},
	};
}

function gradeFor(): CaseGrader {
	return tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
}

/** Build an executor that returns a fixed ExecutionResult for every case. */
function fixedResult(result: ExecutionResult): CaseExecutor {
	return { execute: () => Promise.resolve(result) };
}

function succeeded(artifact: string): ExecutionResult {
	return {
		schema: "disco.execution-result.v1",
		status: "succeeded",
		artifact,
		artifactSha256: artifact.length ? artifact : null,
	};
}

describe("B1 execution-fault states (6 distinct outcomes)", () => {
	it("1) not-attempted: L0 file-check failure never invokes the executor", async () => {
		const c = { skillId: "gget", caseId: "case-c", files: { userRequest: "x", assertionsText: "" } } as CaseRecord;
		let invoked = false;
		const executor: CaseExecutor = { execute: () => { invoked = true; return Promise.resolve(succeeded("never")); } };
		const run = await runAudit([c], { runId: "r", runAt: "T" }, { executor, grader: gradeFor(), splitIndex });
		expect(invoked).toBe(false);
		expect(run.cases[0].execStatus).toBe("not-attempted");
		// not-attempted is NOT counted in attempted/completed/failed/graded/missing-denominator…
		expect(run.summary.attempted).toBe(0);
	});

	it("2) succeeded: gradable artifact reaches L3 and is graded", async () => {
		const cases = [caseRecord("gget", "case-c", ["uses gget.search"])];
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: fixedResult(succeeded("gget.search helper")), grader: gradeFor(), splitIndex });
		expect(run.cases[0].depth).toBe("L3");
		expect(run.cases[0].execStatus).toBe("succeeded");
		expect(run.summary.completed).toBe(1);
		expect(run.summary.graded).toBe(1);
		expect(run.summary.failed).toBe(0);
		expect(run.summary.attempted).toBe(1);
	});

	it("3) succeeded-but-empty-artifact: stops at L1, not counted graded", async () => {
		const cases = [caseRecord("gget", "case-c", ["uses gget.search"])];
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: fixedResult(succeeded("   ")), grader: gradeFor(), splitIndex });
		expect(run.cases[0].depth).toBe("L1");
		expect(run.cases[0].execStatus).toBe("succeeded");
		expect(run.summary.completed).toBe(1);
		expect(run.summary.graded).toBe(0);
		expect(run.summary.missing).toBe(1);
	});

	it("4) timed-out: distinct status, depth L1, errorKind=timeout", async () => {
		const cases = [caseRecord("gget", "case-c", ["uses gget.search"])];
		const timedOut: ExecutionResult = {
			schema: "disco.execution-result.v1", status: "timed-out", artifact: null, artifactSha256: null,
			errorKind: "timeout", error: "wall-clock budget exceeded", usage: { wallMs: 120_000 },
		};
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: fixedResult(timedOut), grader: gradeFor(), splitIndex });
		expect(run.cases[0].depth).toBe("L1");
		expect(run.cases[0].execStatus).toBe("timed-out");
		expect(run.cases[0].errorKind).toBe("timeout");
		expect(run.summary.failed).toBe(1);
		expect(run.summary.graded).toBe(0);
		expect(run.summary.attempted).toBe(1);
	});

	it("5) tool-failure / failed execution: distinct status, errorKind=tool-failure", async () => {
		const cases = [caseRecord("gget", "case-c", ["uses gget.search"])];
		const failedTool: ExecutionResult = {
			schema: "disco.execution-result.v1", status: "failed", artifact: null, artifactSha256: null,
			errorKind: "tool-failure", error: "grep tool exited non-zero", usage: { toolCalls: 3 },
		};
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: fixedResult(failedTool), grader: gradeFor(), splitIndex });
		expect(run.cases[0].execStatus).toBe("failed");
		expect(run.cases[0].errorKind).toBe("tool-failure");
		expect(run.summary.failed).toBe(1);
		expect(run.summary.completed).toBe(0);
	});

	it("6) grader error: executed successfully but grading throws → L1, not graded", async () => {
		const cases = [caseRecord("gget", "case-c", ["uses gget.search"])];
		const throwingGrader: CaseGrader = { grade: () => Promise.reject(new Error("grader exploded")) };
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: fixedResult(succeeded("gget.search")), grader: throwingGrader, splitIndex });
		expect(run.cases[0].depth).toBe("L1");
		expect(run.cases[0].execStatus).toBe("succeeded");
		expect(run.cases[0].blocker).toContain("grader exploded");
		expect(run.summary.completed).toBe(1);
		expect(run.summary.graded).toBe(0);
		expect(run.summary.missing).toBe(1);
	});
});
