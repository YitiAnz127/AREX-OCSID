import { describe, expect, it } from "vitest";
import { parseCaseAssertions, defaultRequiredFragment } from "./parse.ts";
import { tokenGrader } from "./grader.ts";
import { runAudit, serializeLedgerRows } from "./runner.ts";
import { proxyExecutor } from "./types.ts";
import type { CaseExecutor, CaseRecord, CaseGrader, GradeSpec } from "./types.ts";

const splitIndex: Record<string, string> = {
	"chemprop:case-a": "train",
	"chemprop:case-b": "train",
	"gget:case-c": "dev",
};

function caseRecord(skillId: string, caseId: string, assertions: string[]): CaseRecord {
	return {
		skillId,
		caseId,
		files: {
			userRequest: `please help with ${caseId}`,
			assertionsText: JSON.stringify({
				schema: "ocsid.usability-case.v1",
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

function exprExecutor(artifact: (c: CaseRecord) => string): CaseExecutor {
	// A legacy string executor is only a proxy adapter now: it always yields a
	// "succeeded" ExecutionResult with a computed artifactSha256 and no usage.
	return proxyExecutor((c) => artifact(c));
}

function gradeFor(c: CaseRecord, artifact: string): Promise<GradeSpec> {
	return tokenGrader({
		requiredFragment: defaultRequiredFragment,
		parsedAssertions: (cr) => parseCaseAssertions(cr),
	}).grade(c, artifact);
}

describe("audit runner", () => {
	it("reaches L3 and writes a deterministic ledger for gradable cases", async () => {
		const cases = [
			caseRecord("chemprop", "case-a", ["uses chemprop_train_command_builder.py", "does something else"]),
			caseRecord("chemprop", "case-b", ["uses validate_chemprop_tabular_inputs.py"]),
		];
		const executor = exprExecutor(() => "chemprop_train_command_builder.py is the helper; also validate_chemprop_tabular_inputs.py");
		const grader: CaseGrader = { grade: gradeFor };
		const runA = await runAudit(cases, { runId: "baseline-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
		const runB = await runAudit(cases, { runId: "baseline-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });

		// Determinism exit criterion: identical bytes on same-version re-run.
		const rowsA = runA.cases.filter((c) => c.row).map((c) => c.row!);
		const rowsB = runB.cases.filter((c) => c.row).map((c) => c.row!);
		expect(serializeLedgerRows(rowsA)).toBe(serializeLedgerRows(rowsB));
		expect(runA.summary).toEqual(runB.summary);

		// Both cases reach L3.
		expect(runA.cases.every((c) => c.depth === "L3")).toBe(true);
		expect(runA.summary.caseCount).toBe(2);
		expect(runA.summary.skillCount).toBe(1);
		// case-a: assertion1 (pass,1) + assertion2 (fail,0) = 0.5; case-b: 1 assertion pass = 1.0; mean = 0.75
		expect(runA.summary.taskSuccessRate).toBeCloseTo(0.75);
	});

	it("BUG-P1-13: records the grader's declared category, not a hardcoded one", async () => {
		const cases = [caseRecord("chemprop", "case-a", ["uses chemprop_train_command_builder.py"])];
		const executor = exprExecutor(() => "chemprop_train_command_builder.py");
		// A grader may self-declare a distinct attribution category; the runner
		// must forward it instead of forcing "model_grader".
		const named: CaseGrader = { gradedBy: "human", grade: gradeFor };
		const run = await runAudit(cases, { runId: "provenance-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader: named, splitIndex });
		expect(run.cases[0].row!.gradedBy).toBe("human");

		// And an ad-hoc grader without a declaration still gets recorded (fallback default),
		// never crashing the runner.
		const anon: CaseGrader = { grade: gradeFor };
		const run2 = await runAudit(cases, { runId: "provenance-2", runAt: "2026-01-01T00:00:00Z" }, { executor, grader: anon, splitIndex });
		expect(run2.cases[0].row!.gradedBy).toBe("model_grader");
	});

	it("stops at L0 for a case with no assertions text", async () => {
		const c = { skillId: "mosaic", caseId: "c1", files: { userRequest: "x", assertionsText: "" } } as CaseRecord;
		const grader: CaseGrader = { grade: gradeFor };
		const run = await runAudit([c], { runId: "r", runAt: "T" }, { executor: exprExecutor(() => "art"), grader, splitIndex });
		expect(run.cases[0].depth).toBe("L0");
		expect(run.cases[0].blocker).toMatch(/missing|schema/);
		expect(run.cases[0].row).toBeUndefined();
	});

	it("stops at L1 when the executor produces an empty artifact", async () => {
		const cases = [caseRecord("gget", "case-c", ["uses gget.search"])];
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: exprExecutor(() => "  "), grader: { grade: gradeFor }, splitIndex });
		expect(run.cases[0].depth).toBe("L1");
		expect(run.cases[0].score).toBeNull();
	});

	it("stops at L0 when the executor throws", async () => {
		const cases = [caseRecord("gget", "case-c", ["uses gget.search"])];
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: { execute: () => Promise.reject(new Error("boom")) }, grader: { grade: gradeFor }, splitIndex });
		expect(run.cases[0].depth).toBe("L0");
		expect(run.cases[0].blocker).toContain("boom");
	});

	it("returns null task_success_rate when nothing is graded", async () => {
		const cases = [caseRecord("mosaic", "c1", ["uses simplex_APGM"])];
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: exprExecutor(() => ""), grader: { grade: gradeFor }, splitIndex });
		expect(run.summary.taskSuccessRate).toBeNull();
	});

	it("summarizes per-skill and per-split", async () => {
		const cases = [
			caseRecord("chemprop", "case-a", ["a"]),
			caseRecord("gget", "case-c", ["b"]),
		];
		const grader: CaseGrader = { grade: gradeFor };
		const run = await runAudit(cases, { runId: "r", runAt: "T" }, { executor: exprExecutor((c) => (c.caseId === "case-a" ? "a" : "b")), grader, splitIndex });
		expect(run.summary.perSkill.chemprop).toBeCloseTo(1);
		expect(run.summary.perSkill.gget).toBeCloseTo(1);
		expect(run.summary.perSplit["chemprop:train"]).toBeCloseTo(1);
		expect(run.summary.perSplit["gget:dev"]).toBeCloseTo(1);
	});
});
