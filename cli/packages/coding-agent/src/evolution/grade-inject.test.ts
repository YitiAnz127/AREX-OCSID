import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { injectGrade, injectGrades, makeGradeId, detectIncompleteGrades, readGradeJournal } from "./grade-inject.ts";
import { gradeSourceCategory } from "../benchmark/schema.ts";

function seedCandidateRun(quality: string, runId: string, rows: Array<{ skillId: string; caseId: string; score: number }>, kind = "candidate-eval"): void {
	const dir = join(quality, "audit", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "summary.json"), JSON.stringify({ runId, kind, taskSuccessRate: 0.5, caseCount: rows.length }), "utf8");
	const ledger = rows
		.map((r) => JSON.stringify({ schema: "disco.quality-ledger.v1", runId, skillId: r.skillId, caseId: r.caseId, candidateSha256: "d1", score: r.score, gradedBy: "model_grader", ts: "2026-01-01T00:00:00Z" }))
		.join("\n");
	writeFileSync(join(dir, "ledger.jsonl"), ledger + "\n", "utf8");
}

describe("grade injection", () => {
	it("accepts human review of a candidate-agent-eval run", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-agent-grade-"));
		try {
			seedCandidateRun(q, "agent-candidate", [{ skillId: "skill-a", caseId: "c1", score: 0.25 }], "candidate-agent-eval");
			const result = injectGrade({ qualityDir: q, runId: "agent-candidate", skillId: "skill-a", caseId: "c1", score: 1,
				gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "evidence/1" });
			expect(result.applied).toBe(true);
			expect(result.taskSuccessRate).toBe(1);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
	it("does not rewrite a run while another writer holds its lock", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-glock-"));
		try {
			seedCandidateRun(q, "locked-1", [{ skillId: "s", caseId: "c", score: 0.5 }]);
			const dir = join(q, "audit", "locked-1");
			const ledgerPath = join(dir, "ledger.jsonl");
			const before = readFileSync(ledgerPath, "utf8");
			const release = lockfile.lockSync(dir, { realpath: false });
			try {
				expect(() => injectGrade({ qualityDir: q, runId: "locked-1", skillId: "s", caseId: "c", score: 1, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" })).toThrow();
				expect(readFileSync(ledgerPath, "utf8")).toBe(before);
			} finally {
				release();
			}
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("generates distinct grade ids for the same timestamp", () => {
		const at = "2026-01-01T00:00:00.000Z";
		expect(makeGradeId(at)).not.toBe(makeGradeId(at));
	});

	it("grades a real benchmark case id containing path separators", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-gpath-"));
		try {
			const caseId = "sub-skills/cli-serving/multimolecule-command-preflight";
			seedCandidateRun(q, "fam-path", [{ skillId: "alphafold3-pytorch", caseId, score: 0.25 }]);
			const result = injectGrade({ qualityDir: q, runId: "fam-path", skillId: "alphafold3-pytorch", caseId, score: 1, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" });
			expect(result.applied).toBe(true);
			expect(result.taskSuccessRate).toBe(1);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
	it("injects a human grade into a candidate-eval row and recomputes the summary rate", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-g-"));
		try {
			seedCandidateRun(q, "fam-a", [
				{ skillId: "chemprop", caseId: "c1", score: 0.5 },
				{ skillId: "chemprop", caseId: "c2", score: 0.5 },
			]);
			const res = injectGrade({ qualityDir: q, runId: "fam-a", skillId: "chemprop", caseId: "c1", score: 1.0, gradedBy: "human", note: "looks correct", reviewerId: "reviewer-1", evidenceRef: "ev/1" });
			expect(res.applied).toBe(true);
			expect(res.updatedScore).toBe(1.0);
			expect(res.taskSuccessRate).toBe(0.75); // (1.0 + 0.5) / 2
			expect(res.ledgerRowCount).toBe(2);
			const row = JSON.parse(readFileSync(join(q, "audit", "fam-a", "ledger.jsonl"), "utf8").split("\n")[0]);
			expect(row.gradedBy).toBe("human");
			expect(row.score).toBe(1.0);
			expect(row.note).toBe("looks correct");
			const summary = JSON.parse(readFileSync(join(q, "audit", "fam-a", "summary.json"), "utf8"));
			expect(summary.taskSuccessRate).toBe(0.75);
			expect(summary.gradedBySummary).toBe(true);
			const revision = JSON.parse(readFileSync(join(q, "audit", "fam-a", "grades.jsonl"), "utf8").split("\n").filter((l) => l && !l.includes('"journal"'))[0]);
			expect(row.gradeId).toBe(summary.gradeId);
			expect(revision.gradeId).toBe(row.gradeId);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("refuses non-candidate-eval runs and unknown rows", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-g2-"));
		try {
			const base = join(q, "audit", "base-1");
			mkdirSync(base, { recursive: true });
			writeFileSync(join(base, "summary.json"), JSON.stringify({ runId: "base-1", kind: "baseline-plumbing", taskSuccessRate: 0.5 }), "utf8");
			writeFileSync(join(base, "ledger.jsonl"), JSON.stringify({ runId: "base-1", skillId: "s", caseId: "c", score: 0.5, gradedBy: "assertion" }) + "\n", "utf8");
			const denied = injectGrade({ qualityDir: q, runId: "base-1", skillId: "s", caseId: "c", score: 0.9, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" });
			expect(denied.applied).toBe(false);
			if (!denied.applied) expect(denied.reason).toContain("candidate-eval");

			seedCandidateRun(q, "fam-b", [{ skillId: "s", caseId: "c", score: 0.5 }]);
			const missing = injectGrade({ qualityDir: q, runId: "fam-b", skillId: "s", caseId: "NOPE", score: 0.9, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" });
			expect(missing.applied).toBe(false);
			if (!missing.applied) expect(missing.reason).toContain("no ledger row");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("rejects out-of-range scores", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-g3-"));
		try {
			seedCandidateRun(q, "fam-c", [{ skillId: "s", caseId: "c", score: 0.5 }]);
			expect(() => injectGrade({ qualityDir: q, runId: "fam-c", skillId: "s", caseId: "c", score: 1.5, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" })).toThrow("[0,1]");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("applies a batch and reports applied/skipped/failed per row", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-gb-"));
		try {
			seedCandidateRun(q, "fam-r", [
				{ skillId: "s", caseId: "c1", score: 0.5 },
				{ skillId: "s", caseId: "c2", score: 0.5 },
			]);
			const batch = injectGrades([
				{ qualityDir: q, runId: "fam-r", skillId: "s", caseId: "c1", score: 0.8, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" },
				{ qualityDir: q, runId: "fam-r", skillId: "s", caseId: "MISSING", score: 0.9, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" },
				{ qualityDir: q, runId: "fam-r", skillId: "s", caseId: "c2", score: 3.0, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" },
			]);
			expect(batch.applied).toBe(1);
			expect(batch.skipped).toBe(2);
			expect(batch.failed).toHaveLength(2);
			// applied row reflects the human grade
			const row = JSON.parse(readFileSync(join(q, "audit", "fam-r", "ledger.jsonl"), "utf8").split("\n")[0]);
			expect(row.gradedBy).toBe("human");
			expect(row.score).toBe(0.8);
			} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("refuses duplicate case rows instead of reporting a biased success rate", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-gdup-"));
		try {
			// A corrupted ledger with two rows for the same skill:case.
			const dir = join(q, "audit", "dup-1");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "summary.json"), JSON.stringify({ runId: "dup-1", kind: "candidate-eval", taskSuccessRate: 0.5, caseCount: 1 }), "utf8");
			const mk = (score: number) => JSON.stringify({ schema: "disco.quality-ledger.v1", runId: "dup-1", skillId: "s", caseId: "c", candidateSha256: "d1", score, gradedBy: "model_grader", ts: "2026-01-01T00:00:00Z" });
			writeFileSync(join(dir, "ledger.jsonl"), mk(0.3) + "\n" + mk(0.3) + "\n", "utf8");

			const before = readFileSync(join(dir, "ledger.jsonl"), "utf8");
			expect(() => injectGrade({ qualityDir: q, runId: "dup-1", skillId: "s", caseId: "c", score: 1.0, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1" })).toThrow(/duplicate case/i);
			expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).toBe(before);
			const led = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(led).toHaveLength(2);
			expect(led[0].gradedBy).toBe("model_grader");
			expect(led[1].gradedBy).toBe("model_grader");
			expect(existsSync(join(dir, "grades.jsonl"))).toBe(false);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("BUG-P1-11: injection clears stale proxy provenance and appends an audit revision", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-g11-"));
		try {
			const dir = join(q, "audit", "prov-1");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "summary.json"), JSON.stringify({ runId: "prov-1", kind: "candidate-eval", taskSuccessRate: 0.5, caseCount: 1 }), "utf8");
			// A proxy row that ALSO carries observed/extractor claims (the old
			// provenance contradiction: human score next to proxy evidence).
			const proxyRow = {
				schema: "disco.quality-ledger.v1",
				runId: "prov-1",
				skillId: "s",
				caseId: "c",
				candidateSha256: "d1",
				score: 0.4,
				gradedBy: "model_grader",
				ts: "2026-01-01T00:00:00Z",
				observed: [{ outcome: "pass", score: 0.4 }],
				extractor: { path: "audit", jsonpath: "$.score" },
			};
			writeFileSync(join(dir, "ledger.jsonl"), JSON.stringify(proxyRow) + "\n", "utf8");

			const res = injectGrade({
				qualityDir: q, runId: "prov-1", skillId: "s", caseId: "c", score: 1.0, gradedBy: "human",
				gradeId: "g-abc", reviewerId: "reviewer-1", rubricVersion: "v1", evidenceRef: "ev/1",
			});
			expect(res.applied).toBe(true);

			// The overwritten row must carry the human grade AND explicit
			// provenance, and must NO LONGER claim proxy evidence.
			const row = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n")[0]) as Record<string, unknown>;
			expect(row.gradedBy).toBe("human");
			expect(row.score).toBe(1.0);
			expect(row.gradeId).toBe("g-abc");
			expect(row.reviewerId).toBe("reviewer-1");
			expect(row.rubricVersion).toBe("v1");
			expect(row.evidenceRef).toBe("ev/1");
			// BUG-P1-11: stale proxy provenance is cleared, not left contradictory.
			expect(row.observed).toBeUndefined();
			expect(row.extractor).toBeUndefined();

			// The original grade is preserved in the append-only revision ledger.
			const revPath = join(dir, "grades.jsonl");
			expect(existsSync(revPath)).toBe(true);
			const rev = JSON.parse(readFileSync(revPath, "utf8").split("\n").filter((l) => l && !l.includes('"journal"'))[0]) as Record<string, unknown>;
			expect(rev.schema).toBe("disco.grade-revision.v1");
			expect(rev.gradeId).toBe("g-abc");
			expect((rev.before as Record<string, unknown>).score).toBe(0.4);
			expect((rev.after as Record<string, unknown>).score).toBe(1.0);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("B3: rejects a human grade without a reviewer id (consistency with judgement)", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-b3rev-"));
		try {
			seedCandidateRun(q, "b3-rev", [{ skillId: "s", caseId: "c", score: 0.5 }]);
			const res = injectGrade({ qualityDir: q, runId: "b3-rev", skillId: "s", caseId: "c", score: 0.9, gradedBy: "human", evidenceRef: "ev/1" });
			expect(res.applied).toBe(false);
			expect(res.reason).toContain("reviewer");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("B3: rejects a human grade without an evidence ref", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-b3ev-"));
		try {
			seedCandidateRun(q, "b3-ev", [{ skillId: "s", caseId: "c", score: 0.5 }]);
			const res = injectGrade({ qualityDir: q, runId: "b3-ev", skillId: "s", caseId: "c", score: 0.9, gradedBy: "human", reviewerId: "reviewer-1" });
			expect(res.applied).toBe(false);
			expect(res.reason).toContain("evidence");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("B3: a repeated grade with the same gradeId is an idempotent no-op", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-b3idem-"));
		try {
			seedCandidateRun(q, "b3-idem", [{ skillId: "s", caseId: "c", score: 0.5 }]);
			const first = injectGrade({ qualityDir: q, runId: "b3-idem", skillId: "s", caseId: "c", score: 0.9, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1", gradeId: "g-fixed" });
			expect(first.applied).toBe(true);
			expect(first.updatedScore).toBe(0.9);

			const retry = injectGrade({ qualityDir: q, runId: "b3-idem", skillId: "s", caseId: "c", score: 0.2, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1", gradeId: "g-fixed" });
			// The same gradeId must NOT mint a second revision / double-apply.
			expect(retry.applied).toBe(false);
			expect(retry.reason).toContain("idempotent");
			const dir = join(q, "audit", "b3-idem");
			const row = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8").split("\n")[0]);
			expect(row.score).toBe(0.9); // unchanged by the retry
			const revisions = readFileSync(join(dir, "grades.jsonl"), "utf8").split("\n").filter((l) => l && !l.includes('"journal"'));
			expect(revisions).toHaveLength(1);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("B3: recoverable writes — journal carries intent+done, and a dangling intent is detected", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-b3rec-"));
		try {
			seedCandidateRun(q, "b3-rec", [{ skillId: "s", caseId: "c", score: 0.5 }]);
			const res = injectGrade({ qualityDir: q, runId: "b3-rec", skillId: "s", caseId: "c", score: 0.9, gradedBy: "human", reviewerId: "reviewer-1", evidenceRef: "ev/1", gradeId: "g-rec" });
			expect(res.applied).toBe(true);

			// Journal has an intent + a done for the committed gradeId.
			const dir = join(q, "audit", "b3-rec");
			const journal = readGradeJournal(dir);
			const done = journal.filter((r) => r.phase === "done" && r.gradeId === "g-rec");
			expect(done).toHaveLength(1);
			expect(detectIncompleteGrades(dir)).toEqual([]);

			// Simulate a crash: intent without a matching done is detected.
			writeFileSync(join(dir, "grades.jsonl"), readFileSync(join(dir, "grades.jsonl"), "utf8") + JSON.stringify({ journal: "disco.grade-journal.v1", phase: "intent", gradeId: "g-crashed", at: "2026-01-01T00:00:00Z" }) + "\n", "utf8");
			const dangling = detectIncompleteGrades(dir);
			expect(dangling).toContain("g-crashed");
			expect(dangling).not.toContain("g-rec");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("B3: source-category mapping separates human/assertion/llm/proxy", () => {
		expect(gradeSourceCategory("human")).toBe("human_review");
		expect(gradeSourceCategory("assertion")).toBe("programmatic_assertion");
		expect(gradeSourceCategory("model_grader")).toBe("deterministic_proxy");
		expect(gradeSourceCategory("model_grader", "llm")).toBe("llm_judge");
		// P0-3 step 1: token_overlap is the same deterministic proxy source as
		// legacy model_grader, so both map identically at projection boundaries.
		expect(gradeSourceCategory("token_overlap")).toBe("deterministic_proxy");
	});
});
