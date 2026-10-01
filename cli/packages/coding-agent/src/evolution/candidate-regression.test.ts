import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runCandidateRegression } from "./candidate-regression.ts";

const srcEvol = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(srcEvol, "..", "..", "..", "..", "..");
const benchmarkRoot = path.join(repoRoot, "skills", "tests", "benchmark-v1");

const candidates = [
	{ candidateId: "a", text: "candidate A with build_cli_command.py", generation: 0 },
	{ candidateId: "b", text: "candidate B with gget.search and build_cli_command.py", generation: 1, parentRoundId: "round-0" },
	{ candidateId: "c", text: "candidate C nothing matching any claim here", generation: 1, parentRoundId: "round-0" },
];

describe("candidate-family regression", () => {
	it("evaluates every candidate on the same benchmark and aggregates by generation", async () => {
		const q = mkdtempSync(path.join(tmpdir(), "arex-fam-"));
		try {
			const res = await runCandidateRegression({ benchmarkRoot, qualityDir: q, runId: "fam-1", candidates });
			expect(res.perCandidate).toHaveLength(3);
			expect(res.caseCount).toBeGreaterThanOrEqual(30);
			for (const pc of res.perCandidate) {
				expect(pc.candidateSha256).toBeTruthy();
				expect(typeof pc.taskSuccessRate === "number" || pc.taskSuccessRate === null).toBe(true);
			}
			// generation 1 has two candidates → count 2
			const gen1 = res.byGeneration.find((g) => g.generation === 1);
			expect(gen1).toBeTruthy();
			expect(gen1.count).toBe(2);
			// best is one of the candidate ids
			expect(["a", "b", "c"]).toContain(res.best?.candidateId);
			expect(res.note).toContain("NOT a routing-quality");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("is deterministic for identical candidate families", async () => {
		const q1 = mkdtempSync(path.join(tmpdir(), "arex-f1-"));
		const q2 = mkdtempSync(path.join(tmpdir(), "arex-f2-"));
		try {
			const a = await runCandidateRegression({ benchmarkRoot, qualityDir: q1, runId: "fam", candidates });
			const b = await runCandidateRegression({ benchmarkRoot, qualityDir: q2, runId: "fam", candidates });
			expect(a.perCandidate).toEqual(b.perCandidate);
			expect(a.byGeneration).toEqual(b.byGeneration);
			expect(a.best).toEqual(b.best);
		} finally {
			rmSync(q1, { recursive: true, force: true });
			rmSync(q2, { recursive: true, force: true });
		}
	});

	it("rejects an empty candidate list", async () => {
		const q = mkdtempSync(path.join(tmpdir(), "arex-fe-"));
		try {
			await expect(runCandidateRegression({ benchmarkRoot, qualityDir: q, runId: "e", candidates: [] })).rejects.toThrow("no candidates");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
});
