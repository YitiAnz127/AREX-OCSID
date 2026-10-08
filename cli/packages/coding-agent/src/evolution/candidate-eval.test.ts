import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runCandidateEval, candidateDigest, runHeldoutFinalEval, HELDOUT_FINAL_EVAL_KIND } from "./candidate-eval.ts";
import { OFFICIAL_BENCHMARK_DIR } from "../benchmark/freeze.ts";

const srcEvol = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(srcEvol, "..", "..", "..", "..", "..");
const benchmarkRoot = path.join(repoRoot, "skills", "tests", OFFICIAL_BENCHMARK_DIR);

describe("candidate evaluation run-batch", () => {
	it("persists candidate-eval ledger with candidateSha256 and deterministic summary", async () => {
		const qualityDir = mkdtempSync(path.join(tmpdir(), "arex-q-"));
		try {
			// NOTE: B1 contract — a runId is single-write (persistAuditRun refuses
			// to overwrite an existing run). To compare deterministic summaries we
			// re-run with a distinct runId in the same qualityDir.
			const a = await runCandidateEval({ benchmarkRoot, qualityDir, runId: "cand-1", candidateText: "a candidate artifact with build_cli_command.py", source: "proposal/hypothesis-test" });
			const b = await runCandidateEval({ benchmarkRoot, qualityDir, runId: "cand-1b", candidateText: "a candidate artifact with build_cli_command.py", source: "proposal/hypothesis-test" });
			expect(a.candidateSha256).toBe(candidateDigest("a candidate artifact with build_cli_command.py"));
			expect(a.taskSuccessRate).toBe(b.taskSuccessRate);
			expect(a.ledgerPath).toBeTruthy();

			const summary = JSON.parse(readFileSync(path.join(qualityDir, "audit", "cand-1", "summary.json"), "utf8"));
			expect(summary.kind).toBe("candidate-eval");
			expect(summary.note).toContain("NOT a routing-quality claim");
			expect(summary.runId).toBe("cand-1");

			const ledgerText = readFileSync(path.join(qualityDir, "audit", "cand-1", "ledger.jsonl"), "utf8");
			expect(ledgerText.split("\n").filter(Boolean).length).toBe(a.caseCount);
			// every row carries the candidate digest
			const first = JSON.parse(ledgerText.split("\n")[0]);
			expect(first.candidateSha256).toBe(a.candidateSha256);
			expect(first.gradedBy).toBe("model_grader");
		} finally {
			rmSync(qualityDir, { recursive: true, force: true });
		}
	});

	it("produces reproducible identical persistence for identical candidate", async () => {
		const q1 = mkdtempSync(path.join(tmpdir(), "arex-q1-"));
		const q2 = mkdtempSync(path.join(tmpdir(), "arex-q2-"));
		try {
			// BUG-P1-10: determinism is achieved by injecting an explicit runAt
			// (the production default is now a real UTC timestamp).
			const shared = { benchmarkRoot, runId: "r", candidateText: "same candidate text", source: "s", runAt: "2026-01-01T00:00:00Z" } as const;
			const r1 = await runCandidateEval({ qualityDir: q1, ...shared });
			const r2 = await runCandidateEval({ qualityDir: q2, ...shared });
			const l1 = readFileSync(r1.ledgerPath, "utf8");
			const l2 = readFileSync(r2.ledgerPath, "utf8");
			expect(l1).toBe(l2);
			expect(r1.taskSuccessRate).toBe(r2.taskSuccessRate);
		} finally {
			rmSync(q1, { recursive: true, force: true });
			rmSync(q2, { recursive: true, force: true });
		}
	});

	it("BUG-P0-04: candidate ranking excludes held-out by default", async () => {
		const qualityDir = mkdtempSync(path.join(tmpdir(), "arex-p004-"));
		try {
			const res = await runCandidateEval({ benchmarkRoot, qualityDir, runId: "p004", candidateText: "x build_cli_command.py", source: "p004" });
			// Default scope is train+dev: the held-out skills below must NOT appear.
			const ledgerText = readFileSync(res.ledgerPath, "utf8");
			const ledgerCases = ledgerText
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const r = JSON.parse(l);
					return `${r.skillId}:${r.caseId}`;
				});
			for (const heldSkill of ["pdb-structure", "protein-campaign-manager", "pycirclize"]) {
				expect(ledgerCases.some((k) => k.startsWith(`${heldSkill}:`))).toBe(false);
			}
			// scale sanity: full pilot is 43 cases; train+dev alone is still large.
			expect(res.caseCount).toBeGreaterThanOrEqual(30);
			expect(res.caseCount).toBeLessThan(43);
		} finally {
			rmSync(qualityDir, { recursive: true, force: true });
		}
	});

	it("BUG-P0-04/P1-4: candidate ranking REJECTS a held-out split (type + runtime)", async () => {
		const q1 = mkdtempSync(path.join(tmpdir(), "arex-p004-"));
		try {
			// P1-4: a ranking path must never load the held-out terminal set — even
			// if a caller bypasses the RankingSplit type (runtime double-guard).
			await expect(runCandidateEval({
				benchmarkRoot,
				qualityDir: q1,
				runId: "p004he",
				candidateText: "y build_cli_command.py",
				runAt: "2026-01-01T00:00:00Z",
				split: ["heldout"] as unknown as readonly ("train" | "dev")[],
			})).rejects.toThrow(/must not load the held-out split/);
		} finally {
			rmSync(q1, { recursive: true, force: true });
		}
	});

	it("P1-4: held-out final eval requires the candidate to be frozen and is written as a separate kind", async () => {
		const q = mkdtempSync(path.join(tmpdir(), "arex-p004-"));
		try {
			const text = "y build_cli_command.py";
			// FREEZE: first record a train/dev candidate-eval run pinning the digest.
			await runCandidateEval({ benchmarkRoot, qualityDir: q, runId: "frozen-1", candidateText: text, runAt: "2026-01-01T00:00:00Z" });

			// NOT frozen → held-out eval must fail before reading held-out.
			await expect(runHeldoutFinalEval({ benchmarkRoot, qualityDir: q, runId: "ho-0", candidateText: "an unfrozen candidate", runAt: "2026-01-01T00:00:00Z" })).rejects.toThrow(/NOT frozen/);

			// Frozen → held-out final eval succeeds, only reads held-out, separate kind.
			const held = await runHeldoutFinalEval({ benchmarkRoot, qualityDir: q, runId: "ho-1", candidateText: text, runAt: "2026-01-01T00:00:00Z" });
			expect(held.candidateSha256).toBe(candidateDigest(text));
			expect(held.caseCount).toBeGreaterThan(0);

			const summary = JSON.parse(readFileSync(path.join(q, "audit", "ho-1", "summary.json"), "utf8"));
			expect(summary.kind).toBe(HELDOUT_FINAL_EVAL_KIND);
			expect(summary.note).toContain("heldout");

			// Only the held-out skills appear in this run.
			const heldLedger = readFileSync(held.ledgerPath, "utf8");
			const heldCases = heldLedger
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const r = JSON.parse(l);
					return `${r.skillId}:${r.caseId}`;
				});
			for (const heldSkill of ["pdb-structure", "protein-campaign-manager", "pycirclize"]) {
				expect(heldCases.some((k) => k.startsWith(`${heldSkill}:`))).toBe(true);
			}
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
});
