import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareBaselines, fnv1a, makeRandomEditExecutor } from "./baseline.ts";
import { makeProposal } from "./propose-only.ts";
import { structureGrader } from "../audit/structure-grader.ts";
import type { CaseRecord } from "../audit/types.ts";
import { OFFICIAL_BENCHMARK_DIR } from "../benchmark/freeze.ts";

const srcEvolution = path.dirname(fileURLToPath(import.meta.url));
// src/evolution -> repo root is 5 levels up.
const repoRoot = path.resolve(srcEvolution, "..", "..", "..", "..", "..");
const benchmarkRoot = path.join(repoRoot, "skills", "tests", OFFICIAL_BENCHMARK_DIR);

function sampleCase(skillId: string, caseId: string, assertions: string[]): CaseRecord {
	return { skillId, caseId, files: { userRequest: "do it", assertionsText: JSON.stringify({ schema: "ocsid.usability-case.v1", target_skill_area: "x", target_capability: "y", difficulty: "basic", evidence_basis: [], expected_skill_files: [], assertions }) } };
}

describe("equal-budget baselines (B0/B1/B2)", () => {
	it("runs all three arms over the real benchmark deterministically", async () => {
		const a = await compareBaselines(benchmarkRoot, "seed-1");
		const b = await compareBaselines(benchmarkRoot, "seed-1");
		expect(a).toEqual(b); // determinism
		expect(a.caseCount).toBeGreaterThanOrEqual(30);
		for (const arm of ["B0_retry", "B1_random_edit", "B2_propose"] as const) {
			expect(a.arms[arm]).toBeDefined();
			expect(typeof a.arms[arm].taskSuccessRate === "number" || a.arms[arm].taskSuccessRate === null).toBe(true);
		}
		expect(a.note).toContain("NOT a routing-quality result");
	});

	it("produces different summaries when the seed changes (arms vary)", async () => {
		const s1 = await compareBaselines(benchmarkRoot, "seed-1");
		const s2 = await compareBaselines(benchmarkRoot, "seed-2");
		// At minimum B1 (random-edit) should differ across seeds for some skill.
		expect(s1.arms.B1_random_edit).not.toEqual(s2.arms.B1_random_edit);
	});

	it("random-edit executor is deterministic per (seed, case)", async () => {
		const ex = makeRandomEditExecutor("s");
		const c = sampleCase("gget", "x/y", ["uses gget.search things", "does nothing else"]);
		const out1 = await ex.execute(c);
		const out2 = await ex.execute(c);
		expect(out1.artifact).toBe(out2.artifact);
		expect(out1.status).toBe("succeeded");
		expect(out1.artifactSha256).toBeDefined();
		expect(out1.artifact!.length).toBeGreaterThan(0);
		// The random edit is drawn from the case's own assertion tokens, so it
		// must be a superset of the deterministic sentinel.
		expect(out1.artifact).toContain("baseline-plumbing");
	});

	it("fnv1a is stable and produces the same output across identical calls", () => {
		expect(fnv1a("abc")).toBe(fnv1a("abc"));
		expect(fnv1a("abc")).toBe(fnv1a("abc"));
	});

	it("accepts an injected structure grader deterministically and labels it", async () => {
		const a = await compareBaselines(benchmarkRoot, "seed-x", undefined, structureGrader());
		const b = await compareBaselines(benchmarkRoot, "seed-x", undefined, structureGrader());
		expect(a).toEqual(b);
		expect(a.grader).toBe("injected");
		expect(a.note).toContain("injected grader");
	});
});

describe("genealogy on proposals", () => {
	it("carries parent generation and round lineage when set", () => {
		const p = makeProposal({ roundId: "r2", targetSkillId: "chemprop", hypothesis: "h", plan: ["p"], evidence: { source: "usage", finding: "f", empirical: false }, generatedAt: "T", parentRoundId: "r1", generation: 1 });
		expect(p.parentRoundId).toBe("r1");
		expect(p.generation).toBe(1);
		expect(p.appliedToLiveTree).toBe(false);
	});

	it("omits genealogy fields for a root proposal", () => {
		const p = makeProposal({ roundId: "r1", targetSkillId: "chemprop", hypothesis: "h", plan: ["p"], evidence: { source: "usage", finding: "f", empirical: false }, generatedAt: "T" });
		expect(p.parentRoundId).toBeUndefined();
		expect(p.generation).toBeUndefined();
	});
});
