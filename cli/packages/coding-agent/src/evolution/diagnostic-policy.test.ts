import { describe, expect, it } from "vitest";
import { diagnoseWithU0, type DiagnosticEvidence } from "./diagnostic-policy.ts";

const base: DiagnosticEvidence = {
	schema: "ocsid.diagnostic-evidence.v1",
	runId: "run-1",
	caseId: "c1",
	skillId: "skill-a",
	skillDigest: "a".repeat(64),
	score: 0,
	executionStatus: "succeeded",
	evidenceRefs: ["audit/run-1/ledger.jsonl"],
	probeBudgetAvailable: true,
};

describe("frozen U0 diagnostic policy", () => {
	it("asks for a probe instead of patching after one failed task", () => {
		const result = diagnoseWithU0(base);
		expect([result.diagnosis, result.decision, result.probeKind]).toEqual(["uncertain", "probe", "reference-addition"]);
		expect(result.policySha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("abstains on missing grades and execution failures", () => {
		expect(diagnoseWithU0({ ...base, score: null }).decision).toBe("abstain");
		expect(diagnoseWithU0({ ...base, executionStatus: "timed-out" }).diagnosis).toBe("non_skill");
	});

	it("allows a local patch only after repeated controlled reference probes improve", () => {
		const result = diagnoseWithU0({ ...base, probe: {
			kind: "reference-addition", controlled: true, evidenceRef: "probe-1", before: [0, 0.2], after: [0.5, 0.6],
		} });
		expect([result.diagnosis, result.decision]).toEqual(["skill_defect", "patch"]);
		expect(result.observedProbeGain).toBeCloseTo(0.45);
		expect(result.evidenceRefs).toContain("probe-1");
		expect(diagnoseWithU0({ ...base, probe: {
			kind: "reference-addition", controlled: true, evidenceRef: "probe-2", before: [0], after: [1],
		} }).decision).toBe("abstain");
	});

	it("does not mistake routing or retry gains for a skill defect", () => {
		for (const kind of ["correct-skill-replay", "same-environment-retry"] as const) {
			const result = diagnoseWithU0({ ...base, probe: {
				kind, controlled: true, evidenceRef: "probe-3", before: [0, 0], after: [1, 1],
			} });
			expect(result.decision).toBe("abstain");
		}
	});
});
