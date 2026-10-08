import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScoreReport, readBaselineRate, readBaselineByCase, aggregateSkillDeltaFromCases, coverageGap, readDigestCaseScores, aggregateSkillDeltaByDigest, validateDigestPrefix } from "./score-report.ts";

function writeCandidateRun(quality: string, runId: string, rows: Array<Record<string, unknown>>, summary?: Record<string, unknown>): void {
	const dir = join(quality, "audit", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "summary.json"), JSON.stringify({ runId, kind: "candidate-eval", caseCount: rows.length, ledgerRowCount: rows.length, taskSuccessRate: 0.5, ...(summary ?? {}) }), "utf8");
	writeFileSync(join(dir, "ledger.jsonl"), rows.map((r) => JSON.stringify({ runId, schema: "ocsid.quality-ledger.v1", candidateSha256: "d1", score: 0.5, gradedBy: "model_grader", ts: "2026-01-01T00:00:00Z", ...r })).join("\n") + "\n", "utf8");
}

describe("score report", () => {
	it("includes candidate-agent-eval runs in per-case and digest reports", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-agent-report-"));
		try {
			writeCandidateRun(q, "agent-r", [{ skillId: "skill-a", caseId: "c1", score: 0.75, candidateSha256: "abcdef1234567890" }], { kind: "candidate-agent-eval" });
			const report = buildScoreReport(q);
			expect(report.runs.map((r) => r.runId)).toContain("agent-r");
			expect(report.byCase[0].entries[0].score).toBe(0.75);
			const digest = readDigestCaseScores(q, "abcdef12");
			expect(digest.matchedRuns).toBe(1);
			expect(digest.byCase.get("skill-a::c1")?.mean).toBe(0.75);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
	it("aggregates valid candidate-eval runs by case and reports gradedBy sources", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr-"));
		try {
			writeCandidateRun(q, "r1", [
				{ skillId: "chemprop", caseId: "c1", score: 1.0, gradedBy: "human" },
				{ skillId: "chemprop", caseId: "c2", score: 0.5, gradedBy: "human" },
			]);
			writeCandidateRun(q, "r2", [{ skillId: "chemprop", caseId: "c1", score: 0.8, gradedBy: "model_grader" }]);
			const rep = buildScoreReport(q);
			expect(rep.runs).toHaveLength(2);
			expect(rep.issues).toHaveLength(0);
			const c1 = rep.byCase.find((c) => c.caseId === "c1");
			expect(c1).toBeTruthy();
			if (c1) {
				expect(c1.entries).toHaveLength(2);
				expect(c1.entries.map((e) => e.runId).sort()).toEqual(["r1", "r2"]);
			}
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("aggregates per-candidate means across runs with per-skill breakdown", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr4-"));
		try {
			// candidate d1 scored in r1 (c1=1.0) and r2 (c1=0.8) -> mean over the
			// SINGLE unique case c1 = (1.0+0.8)/2 = 0.9. caseCount counts unique
			// cases, so c1 appearing in both runs counts once.
			writeCandidateRun(q, "r1", [{ skillId: "chemprop", caseId: "c1", score: 1.0, gradedBy: "human", candidateSha256: "d1" }]);
			writeCandidateRun(q, "r2", [{ skillId: "chemprop", caseId: "c1", score: 0.8, gradedBy: "model_grader", candidateSha256: "d1" }]);
			const rep = buildScoreReport(q);
			expect(rep.byCandidate).toHaveLength(1);
			const c = rep.byCandidate[0];
			expect(c.candidateSha256).toBe("d1");
			expect(c.mean).toBe(0.9);
			expect(c.caseCount).toBe(1);
			expect(c.scoredCount).toBe(1);
			expect(c.gradedBySources.sort()).toEqual(["human", "model_grader"]);
			expect(c.perSkill).toHaveLength(1);
			expect(c.perSkill[0].mean).toBe(0.9);
			expect(c.perSkill[0].caseCount).toBe(1);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("BUG (case normalization): a case scored in multiple runs counts once, so a run with more rows cannot dominate the digest mean", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr5-"));
		try {
			// d1: r1 covers c1@0.0 PLUS 9 other unique cases (all score 0.0) = 10 unique
			// cases; r2 rescored c1@1.0 (same caseId). Old buggy behavior pooled all 11
			// rows: mean = (10*0.0 + 1.0)/11 ≈ 0.0909 and caseCount = 11 — r1's larger
			// row count dominated and c1 was double-counted.
			// Correct: 10 unique cases; c1 is averaged (0.0+1.0)/2 = 0.5, each counts once
			// -> mean = (0.5 + 9*0.0)/10 = 0.05.
			const r1 = [
				{ skillId: "chemprop", caseId: "c1", score: 0.0, gradedBy: "model_grader", candidateSha256: "d1" },
				...Array.from({ length: 9 }, (_, i) => ({ skillId: "chemprop", caseId: `c2-${i}`, score: 0.0, gradedBy: "model_grader", candidateSha256: "d1" })),
			];
			const r2 = [{ skillId: "chemprop", caseId: "c1", score: 1.0, gradedBy: "model_grader", candidateSha256: "d1" }];
			writeCandidateRun(q, "r1", r1);
			writeCandidateRun(q, "r2", r2);
			const rep = buildScoreReport(q);
			const c = rep.byCandidate[0];
			expect(c.caseCount).toBe(10);
			expect(c.scoredCount).toBe(10);
			// (9*0.0 + 0.5)/10
			expect(c.mean).toBeCloseTo(0.05, 10);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("detects structural issues: score range, duplicate case, row count, runId mismatch, mixed digest", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr2-"));
		try {
			// r1: out-of-range score + duplicate case + runId mismatch + wrong ledgerRowCount + mixed digest
			writeCandidateRun(
				q,
				"r1",
				[
					{ skillId: "s", caseId: "c1", score: 2.0, gradedBy: "human" },
					{ skillId: "s", caseId: "c1", score: 0.5, gradedBy: "human" }, // duplicate case
					{ skillId: "s", caseId: "c2", score: 0.5, gradedBy: "human", runId: "WRONG" }, // runId mismatch
				],
				{ ledgerRowCount: 5 }, // mismatch -> ROW_TOO_FEW
			);
			// r2: only some rows carry a digest (fields override default d1) -> MIXED_DIGEST when mixed
			writeCandidateRun(q, "r2", [{ skillId: "s", caseId: "c9", score: 0.5, gradedBy: "human", candidateSha256: null }]);
			const rep = buildScoreReport(q);
			const kinds = rep.issues.map((i) => i.kind);
			expect(kinds).toContain("SCORE_RANGE");
			expect(kinds).toContain("DUPLICATE_CASE");
			expect(kinds).toContain("RUN_ID_MISMATCH");
			expect(kinds).toContain("ROW_TOO_FEW");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("honors a run filter and ignores non-candidate-eval runs", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr3-"));
		try {
			writeCandidateRun(q, "r1", [{ skillId: "s", caseId: "c1", score: 0.5, gradedBy: "human" }]);
			writeCandidateRun(q, "r2", [{ skillId: "s", caseId: "c2", score: 0.5, gradedBy: "model_grader" }]);
			const base = join(q, "audit", "base-1");
			mkdirSync(base, { recursive: true });
			writeFileSync(join(base, "summary.json"), JSON.stringify({ runId: "base-1", kind: "baseline-plumbing", caseCount: 1 }), "utf8");
			writeFileSync(join(base, "ledger.jsonl"), JSON.stringify({ runId: "base-1", skillId: "s", caseId: "c", score: 0.5, gradedBy: "assertion" }) + "\n", "utf8");

			const filtered = buildScoreReport(q, { filterRunId: "r1" });
			expect(filtered.runs.map((r) => r.runId)).toEqual(["r1"]);

			const all = buildScoreReport(q);
			expect(all.runs.map((r) => r.runId)).toEqual(["r1", "r2"]); // baseline-plumbing excluded
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("BUG-P1-14: out-of-range scores are flagged but excluded from the mean", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr14-"));
		try {
			// One valid score and one out-of-range (2.0) for the same candidate digest.
			writeCandidateRun(q, "r1", [{ skillId: "s", caseId: "c1", score: 0.5, gradedBy: "human", candidateSha256: "d1" }]);
			writeCandidateRun(q, "r2", [{ skillId: "s", caseId: "c2", score: 2.0, gradedBy: "model_grader", candidateSha256: "d1" }]);
			const rep = buildScoreReport(q);
			expect(rep.issues.some((i) => i.kind === "SCORE_RANGE")).toBe(true);
			const cand = rep.byCandidate.find((c) => c.candidateSha256 === "d1");
			// The bad 2.0 must NOT count toward the mean. Only c1 (0.5) is aggregated,
			// so the candidate mean is 0.5 — not 1.25.
			expect(cand!.caseCount).toBe(1);
			expect(cand!.mean! * 100).toBeCloseTo(50);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("aggregates per-skill deltas only over cases both sides scored", () => {
		// byCase: candidate run "cr" scores c1 (0.9) and c2 (0.6); baseline covers c1 only.
		const byCase = [
			{ skillId: "s1", caseId: "c1", entries: [{ runId: "cr", score: 0.9, gradedBy: "human", ts: "t" }] },
			{ skillId: "s1", caseId: "c2", entries: [{ runId: "cr", score: 0.6, gradedBy: "human", ts: "t" }] },
			{ skillId: "s2", caseId: "c9", entries: [{ runId: "cr", score: 0.5, gradedBy: "human", ts: "t" }] },
		];
		const base = new Map<string, { score: number | null; gradedBy: string; ts: string }>();
		base.set("s1::c1", { score: 0.5, gradedBy: "assertion", ts: "b" });
		base.set("s1::c2", { score: 0.4, gradedBy: "assertion", ts: "b" }); // c2 baseline present -> included
		const deltas = aggregateSkillDeltaFromCases(byCase, "cr", base);
		// s1: c1 +0.4, c2 +0.2 -> mean +0.3 over 2 cases; s2 has no baseline overlap -> absent
		expect(deltas).toHaveLength(1);
		expect(deltas[0].skillId).toBe("s1");
		expect(deltas[0].comparedCases).toBe(2);
		expect(deltas[0].meanDelta).toBeCloseTo(0.3);
		expect(deltas[0].baselineGradedBy).toBe("assertion");
	});

	it("reports coverage gaps explicitly rather than silently omitting", () => {
		const byCase = [
			{ skillId: "s1", caseId: "c1", entries: [{ runId: "cr", score: 0.9, gradedBy: "human", ts: "t" }] },
			{ skillId: "s1", caseId: "c2", entries: [{ runId: "cr", score: 0.6, gradedBy: "human", ts: "t" }] },
			{ skillId: "s2", caseId: "c9", entries: [{ runId: "cr", score: 0.5, gradedBy: "human", ts: "t" }] },
		];
		const base = new Map<string, { score: number | null; gradedBy: string; ts: string }>();
		base.set("s1::c1", { score: 0.5, gradedBy: "assertion", ts: "b" });
		base.set("s2::cX", { score: 0.8, gradedBy: "assertion", ts: "b" }); // baseline-only
		const gap = coverageGap(byCase, "cr", base);
		expect(gap.candidateCovered).toBe(3);
		expect(gap.overlapped).toBe(1); // only s1::c1 overlaps
		expect(gap.candidateOnly).toBe(2);
		expect(gap.baselineOnly).toBe(1);
		expect(gap.candidateOnlyCases).toContain("s1::c2");
		expect(gap.candidateOnlyCases).toContain("s2::c9");
	});

	it("merges a candidate digest across runs and computes skill delta vs baseline", async () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr6-"));
		try {
			// same digest "abcd1234" across two runs, same case c1: scores 1.0 and 0.8 -> mean 0.9
			writeCandidateRun(q, "r1", [{ skillId: "chemprop", caseId: "c1", score: 1.0, gradedBy: "human", candidateSha256: "abcd1234" }]);
			writeCandidateRun(q, "r2", [{ skillId: "chemprop", caseId: "c1", score: 0.8, gradedBy: "model_grader", candidateSha256: "abcd1234" }]);
			// baseline covers c1 at 0.5
			writeCandidateRun(q, "base-1", [{ skillId: "chemprop", caseId: "c1", score: 0.5, gradedBy: "assertion", candidateSha256: null }], { kind: "baseline-plumbing" });
			const base = readBaselineByCase(q, "base-1");
			expect(base.byCase.get("chemprop::c1")).toBeTruthy();
			const ds = readDigestCaseScores(q, "abcd1234");
			expect(ds.candidateCovered).toBe(1); // one distinct case
			expect(ds.matchedRuns).toBe(2);
			expect(ds.byCase.get("chemprop::c1")!.mean).toBeCloseTo(0.9);
			expect([...ds.byCase.get("chemprop::c1")!.gradedBy].sort()).toEqual(["human", "model_grader"]);
			const deltas = aggregateSkillDeltaByDigest(ds, base.byCase);
			expect(deltas).toHaveLength(1);
			expect(deltas[0].skillId).toBe("chemprop");
			expect(deltas[0].comparedCases).toBe(1);
			expect(deltas[0].meanDelta).toBeCloseTo(0.4); // 0.9 - 0.5
			expect(deltas[0].candidateGradedBy).toContain("human");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("supports latest merge (newest ts wins) and validates digest prefixes", () => {
		expect(validateDigestPrefix("abcd1234")).toBeNull();
		expect(validateDigestPrefix("abc")).not.toBeNull();
		expect(validateDigestPrefix("zzzzzzzz")).not.toBeNull(); // non-hex
		const q = mkdtempSync(join(tmpdir(), "arex-sr7-"));
		try {
			// same digest, same case c1: older ts (0.7) and newer ts (0.9)
			writeCandidateRun(q, "r1", [{ skillId: "s", caseId: "c1", score: 0.7, gradedBy: "human", candidateSha256: "feed0001", ts: "2026-01-01T00:00:00Z" }]);
			writeCandidateRun(q, "r2", [{ skillId: "s", caseId: "c1", score: 0.9, gradedBy: "model_grader", candidateSha256: "feed0001", ts: "2026-02-01T00:00:00Z" }]);
			const mean = readDigestCaseScores(q, "feed0001", { merge: "mean" });
			expect(mean.byCase.get("s::c1")!.mean).toBeCloseTo(0.8);
			expect(mean.byCase.get("s::c1")!.strategy).toBe("mean");
			const latest = readDigestCaseScores(q, "feed0001", { merge: "latest" });
			expect(latest.byCase.get("s::c1")!.mean).toBeCloseTo(0.9);
			expect(latest.byCase.get("s::c1")!.latestTs).toBe("2026-02-01T00:00:00Z");
			expect(latest.byCase.get("s::c1")!.strategy).toBe("latest");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("reads a baseline task_success_rate from any run kind and reports missing/null", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-sr5-"));
		try {
			writeCandidateRun(q, "base-1", [{ skillId: "s", caseId: "c1", score: 0.5, gradedBy: "assertion", candidateSha256: null }], { kind: "baseline-plumbing", taskSuccessRate: 0.5 });
			const b = readBaselineRate(q, "base-1");
			expect(b.found).toBe(true);
			expect(b.rate).toBe(0.5);
			expect(b.kind).toBe("baseline-plumbing");
			const missing = readBaselineRate(q, "NOPE");
			expect(missing.found).toBe(false);
			// a run with null rate
			mkdirSync(join(q, "audit", "no-rate"), { recursive: true });
			writeFileSync(join(q, "audit", "no-rate", "summary.json"), JSON.stringify({ runId: "no-rate", kind: "candidate-eval", taskSuccessRate: null }), "utf8");
			const nr = readBaselineRate(q, "no-rate");
			expect(nr.found).toBe(true);
			expect(nr.rate).toBeNull();

			// readBaselineByCase: baseline-plumbing ledger per-case
			const bc = readBaselineByCase(q, "base-1");
			expect(bc.found).toBe(true);
			expect(bc.byCase.get("s::c1")).toEqual({ score: 0.5, gradedBy: "assertion", ts: "2026-01-01T00:00:00Z" });
			expect(bc.caseCount).toBe(1);
			const missingBc = readBaselineByCase(q, "NOPE");
			expect(missingBc.found).toBe(false);
			expect(missingBc.byCase.size).toBe(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("BUG (determinism): candidate ranking ties break by digest, not insertion order", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-srdet-"));
		try {
			// Two candidates with EQUAL mean (both 0.5). The tie must resolve the
			// same way on every run; before the fix it fell through to the stable
			// sort's insertion order (derived from readdirSync + row order).
			writeCandidateRun(q, "run-aaa", [{ skillId: "s", caseId: "c1", score: 0.5, gradedBy: "human", candidateSha256: "aaa11111" }]);
			writeCandidateRun(q, "run-zzz", [{ skillId: "s", caseId: "c1", score: 0.5, gradedBy: "human", candidateSha256: "zzz99999" }]);
			const rep = buildScoreReport(q);
			expect(rep.byCandidate).toHaveLength(2);
			// Ascending digest wins the tie -> "aaa11111" ranks first.
			expect(rep.byCandidate[0].candidateSha256).toBe("aaa11111");
			expect(rep.byCandidate[1].candidateSha256).toBe("zzz99999");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("BUG (determinism): latest-merge tie on equal ts resolves by run dir order, not fs order", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-srlst-"));
		try {
			// Two runs for the same digest+case with IDENTICAL timestamps. The
			// "latest" strategy must pick deterministically via sorted run-dir
			// order (rr-aaa's 0.3 < rr-zzz's 0.7 would win if fs order decided, so
			// assert the SORTED-dir winner: later dir lexicographically wins).
			writeCandidateRun(q, "rr-aaa", [{ skillId: "s", caseId: "c1", score: 0.3, gradedBy: "human", candidateSha256: "cafe0001", ts: "2026-01-01T00:00:00Z" }]);
			writeCandidateRun(q, "rr-zzz", [{ skillId: "s", caseId: "c1", score: 0.7, gradedBy: "human", candidateSha256: "cafe0001", ts: "2026-01-01T00:00:00Z" }]);
			const latest = readDigestCaseScores(q, "cafe0001", { merge: "latest" });
			// Sorted dir order: rr-aaa then rr-zzz -> zzz's row is the "later" one
			// and wins the seq tie, giving 0.7 deterministically.
			expect(latest.byCase.get("s::c1")!.mean).toBeCloseTo(0.7);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("P1-4: held-out final-eval runs are presented separately and NOT folded into train/dev candidate aggregation", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-heldout-"));
		try {
			writeCandidateRun(q, "tr1", [{ skillId: "skill-a", caseId: "c1", score: 0.5, gradedBy: "human", candidateSha256: "d1" }]);
			// A held-out final eval runs on a DIFFERENT terminal set; it must not
			// be mixed into the candidate-eval aggregation (isCandidateRunKind excludes it).
			writeCandidateRun(
				q,
				"ho1",
				[{ skillId: "held-skill", caseId: "hc1", score: 0.9, gradedBy: "human", candidateSha256: "d1" }],
				{ kind: "heldout-final-eval" },
			);
			const rep = buildScoreReport(q);
			expect(rep.runs.map((r) => r.runId)).toEqual(["tr1"]);
			expect(rep.runs.some((r) => r.kind === "heldout-final-eval")).toBe(false);
			// The held skill/case is absent from the per-case report.
			expect(rep.byCase.some((c) => c.skillId === "held-skill")).toBe(false);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
});
