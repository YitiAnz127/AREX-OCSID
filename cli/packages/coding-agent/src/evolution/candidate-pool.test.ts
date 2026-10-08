import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listCandidateRuns, poolByFamily } from "./candidate-pool.ts";

function writeRun(quality: string, runId: string, kind: string, rate: number | null, digest: string | null, gradedBy: string): void {
	const dir = join(quality, "audit", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "summary.json"), JSON.stringify({ schema: "ocsid.audit-summary.v1", runId, kind, skillCount: 1, caseCount: 10, perDepth: { L0: 0, L1: 0, L2: 0, L3: 10 }, taskSuccessRate: rate, perSkill: {}, perSplit: {}, note: "x", ledgerRowCount: 10 }), "utf8");
	const row = { schema: "ocsid.quality-ledger.v1", runId, skillId: "chemprop", caseId: "c1", candidateSha256: digest, extractor: { path: "audit", jsonpath: "$.score" }, observed: [{ outcome: "pass", score: 0.5 }], score: 0.5, gradedBy, ts: "2026-01-01T00:00:00Z" };
	writeFileSync(join(dir, "ledger.jsonl"), JSON.stringify(row) + "\n", "utf8");
}

describe("candidate pooling", () => {
	it("lists candidate-agent-eval separately from baseline and text-proxy runs", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-agent-pool-"));
		try {
			writeRun(q, "agent-candidate", "candidate-agent-eval", 0.75, "abcdef1234567890", "human");
			writeRun(q, "baseline", "agent-eval", 0.5, null, "model_grader");
			const runs = listCandidateRuns(q);
			expect(runs).toHaveLength(1);
			expect(runs[0].kind).toBe("candidate-agent-eval");
			expect(runs[0].candidateSha256).toBe("abcdef1234567890");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
	it("lists only candidate-eval runs and reads their recorded digest/grader", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-pool-"));
		try {
			writeRun(q, "fam-a", "candidate-eval", 0.6, "d-a", "model_grader");
			writeRun(q, "fam-b", "candidate-eval", 0.4, "d-b", "human");
			writeRun(q, "base-1", "baseline-plumbing", 0.5, null, "token");
			const runs = listCandidateRuns(q);
			expect(runs).toHaveLength(2);
			expect(runs.every((r) => r.kind === "candidate-eval")).toBe(true);
			expect(runs.map((r) => r.candidateSha256)).toEqual(expect.arrayContaining(["d-a", "d-b"]));
			const human = runs.find((r) => r.gradedBy === "human");
			expect(human).toBeTruthy();
			expect(human.taskSuccessRate).toBe(0.4);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("pools by family run-id prefix", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-pool2-"));
		try {
			writeRun(q, "fam-a", "candidate-eval", 0.5, "d1", "model_grader");
			writeRun(q, "fam-a-x", "candidate-eval", 0.7, "d2", "model_grader");
			writeRun(q, "other-y", "candidate-eval", 0.3, "d3", "model_grader");
			const runs = listCandidateRuns(q);
			const famA = poolByFamily(runs, "fam");
			expect(famA.map((r) => r.runId).sort()).toEqual(["fam-a", "fam-a-x"]);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("returns empty when no candidate-eval runs exist", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-pool3-"));
		try {
			writeRun(q, "base-1", "baseline-plumbing", 0.5, null, "token");
			expect(listCandidateRuns(q)).toHaveLength(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("BUG-P1-12: aggregates provenance across ALL ledger rows, not just the first", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-pool4-"));
		try {
			const dir = join(q, "audit", "fam-x");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "summary.json"), JSON.stringify({ schema: "ocsid.audit-summary.v1", runId: "fam-x", kind: "candidate-eval", skillCount: 1, caseCount: 2, perDepth: { L3: 2 }, taskSuccessRate: 0.5, perSkill: {}, perSplit: {}, ledgerRowCount: 2 }), "utf8");
			// First row carries NO digest and grader A; second row carries the digest
			// and grader B. The old first-line-only reader would report digest=null
			// and gradedBy=A, losing the true provenance.
			const r = { schema: "ocsid.quality-ledger.v1", runId: "fam-x", skillId: "s", caseId: "c", extractor: { path: "audit", jsonpath: "$.score" }, observed: [], score: 0.5 };
			writeFileSync(join(dir, "ledger.jsonl"),
				JSON.stringify({ ...r, candidateSha256: null, gradedBy: "human", caseId: "c1" }) + "\n" +
				JSON.stringify({ ...r, candidateSha256: "dig-1234", gradedBy: "model_grader", caseId: "c2" }) + "\n", "utf8");

			const run = listCandidateRuns(q)[0];
			expect(run.candidateSha256).toBe("dig-1234");
			expect(run.gradedBy).toBe("human,model_grader");
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});

	it("BUG (integrity): a missing/corrupt caseCount surfaces as null, not 0", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-pool5-"));
		try {
			const dir = join(q, "audit", "fam-c");
			mkdirSync(dir, { recursive: true });
			// Older/corrupt summary omits caseCount but records a non-null rate.
			writeFileSync(join(dir, "summary.json"), JSON.stringify({ schema: "ocsid.audit-summary.v1", runId: "fam-c", kind: "candidate-eval", skillCount: 1, perDepth: { L3: 5 }, taskSuccessRate: 0.6, perSkill: {}, perSplit: {} }), "utf8");
			const row = { schema: "ocsid.quality-ledger.v1", runId: "fam-c", skillId: "s", caseId: "c", candidateSha256: "d", extractor: { path: "audit", jsonpath: "$.score" }, observed: [], score: 0.6, gradedBy: "model_grader", ts: "2026-01-01T00:00:00Z" };
			writeFileSync(join(dir, "ledger.jsonl"), JSON.stringify(row) + "\n", "utf8");

			const run = listCandidateRuns(q)[0];
			expect(run.taskSuccessRate).toBe(0.6);
			// caseCount is unknown, NOT "0 cases" — 0 would mislead a comparator.
			expect(run.caseCount).toBeNull();
		} finally {
			rmSync(q, { recursive: true, force: true });
		}
	});
});
