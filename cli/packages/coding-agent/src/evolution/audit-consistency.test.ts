import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditConsistency, checkNoLiveApply } from "./audit-consistency.ts";

function writeCandidateRun(quality: string, runId: string, rows: Array<Record<string, unknown>>, summaryFields: Record<string, unknown> = {}): void {
	const dir = join(quality, "audit", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "summary.json"), JSON.stringify({ runId, kind: "candidate-eval", ledgerRowCount: rows.length, ...summaryFields }), "utf8");
	writeFileSync(join(dir, "ledger.jsonl"), rows.map((r) => JSON.stringify({ runId, skillId: "s", caseId: "c1", score: 0.5, gradedBy: "human", ts: "t", candidateSha256: "abcd1234", ...r })).join("\n") + "\n", "utf8");
}

describe("audit consistency", () => {
	it("rejects a candidate-agent-eval ledger with no candidate digest", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-agent-consistency-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-agent-docs-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			writeCandidateRun(q, "agent-candidate", [{ candidateSha256: null }], { kind: "candidate-agent-eval" });
			const result = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const byName = Object.fromEntries(result.checks.map((check) => [check.name, check.pass]));
			expect(byName["summary-ledger-consistency"]).toBe(false);
			expect(byName["run-single-digest"]).toBe(false);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});
	it("BUG-P1-18: no audit dir yields NO_DATA skip (not a PASS), counted in skipped, not failed", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-nodata-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-nodatad-"));
		try {
			// empty quality dir => no audit/ subdir => audit-based checks have nothing to inspect
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const auditChecks = res.checks.filter((c) => c.name !== "proposal-no-live-apply" && c.name !== "routing-honesty-label" && c.name !== "archives-present");
			// every audit-based check reports skip/NO_DATA rather than a false PASS
			for (const c of auditChecks) {
				expect(c.status).toBe("skip");
				expect(c.pass).toBe(false);
				expect(c.detail).toContain("NO_DATA");
			}
			expect(res.skipped).toBe(auditChecks.length);
			// skipped checks are neither passed nor failed
			expect(res.failed).toBe(0);
			expect(res.passed + res.skipped + res.failed).toBe(res.checks.length);
			// archives-present still inspects docs and passes (independent of audit dir)
			expect(Object.fromEntries(res.checks.map((c) => [c.name, c.pass]))["archives-present"]).toBe(true);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("reports pass for self-consistent quality dir and present archives", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd-"));
		try {
			writeCandidateRun(q, "r1", [{ score: 0.5 }]);
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			writeFileSync(join(docs, "archive-v2.md"), "# v2\n", "utf8");
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			// source-based checks run against this repo's real files (must pass)
			const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.pass]));
			expect(byName["proposal-no-live-apply"]).toBe(true);
			expect(byName["routing-honesty-label"]).toBe(true);
			expect(byName["ledger-self-consistent"]).toBe(true);
			expect(byName["archives-present"]).toBe(true);
			expect(res.failed).toBe(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("flags ledger row-count mismatch, out-of-range score, and non-empty archive rule", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac2-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd2-"));
		try {
			// summary says 5 rows but only 1 written; score out of range
			writeCandidateRun(q, "r1", [{ score: 0.5 }, { score: 1.5 }], { ledgerRowCount: 5 });
			writeFileSync(join(docs, "archive-v1.md"), "  \n", "utf8"); // whitespace-only -> counted empty
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.pass]));
			expect(byName["ledger-self-consistent"]).toBe(false);
			expect(byName["archives-present"]).toBe(false);
			expect(res.failed).toBeGreaterThan(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("flags a run mixing two candidate digests and a malformed digest value", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac3-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd3-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			// one candidate-eval run with two distinct digests -> run-single-digest FAIL
			writeCandidateRun(q, "mix", [{ candidateSha256: "abcd1234" }, { candidateSha256: "efef1234" }]);
			// a row with a malformed (non-hex / too-short) digest -> digest-wellformed FAIL
			writeCandidateRun(q, "bad", [{ candidateSha256: "zz!!!nothex" }]);
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.pass]));
			expect(byName["run-single-digest"]).toBe(false);
			expect(byName["digest-wellformed"]).toBe(false);
			expect(res.failed).toBeGreaterThan(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("flags kind/ledger mismatch: candidate-eval with no digest and baseline with a digest", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac4-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd4-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			// candidate-eval claiming a candidate but its ledger has only null digests -> FAIL
			writeCandidateRun(q, "cand-empty", [{ candidateSha256: null }]);
			// baseline-plumbing claiming no candidate but a ledger row carries a digest -> FAIL
			writeCandidateRun(q, "base-leaky", [{ candidateSha256: "abcd1234" }], { kind: "baseline-plumbing" });
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.pass]));
			expect(byName["summary-ledger-consistency"]).toBe(false);
			expect(res.failed).toBeGreaterThan(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("reports rate-vs-ledger mismatch as an informational warning, not a failure", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac5-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd5-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			// ledger mean = 0.9 (two 0.9 rows) but summary claims 0.5 -> warning, still pass
			writeCandidateRun(q, "r1", [{ score: 0.9 }, { score: 0.9 }], { taskSuccessRate: 0.5 });
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const rv = res.checks.find((c) => c.name === "summary-rate-vs-ledger-mean")!;
			expect(rv.pass).toBe(true);
			expect(rv.level).toBe("warning");
			expect(res.failed).toBe(0);
			expect(res.warnings).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("regroups issues per run via byRun", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac6-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd6-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			// rate warning on r1 (ledger mean 0.9 vs summary 0.5)
			writeCandidateRun(q, "r1", [{ score: 0.9 }], { taskSuccessRate: 0.5 });
			// two digests in one run -> run-single-digest error on "mix"
			writeCandidateRun(q, "mix", [{ candidateSha256: "abcd1234" }, { candidateSha256: "efef1234" }]);
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			expect(res.byRun["r1"]).toBeTruthy();
			expect(res.byRun["r1"].warnings.length).toBeGreaterThanOrEqual(1);
			expect(res.byRun["mix"]).toBeTruthy();
			expect(res.byRun["mix"].errors.length).toBeGreaterThanOrEqual(1);
			expect(res.byRun["mix"].checks).toContain("run-single-digest");
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("flags missing summary runId/kind and a ledger with no summary", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac7-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd7-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			// summary without kind
			writeCandidateRun(q, "no-kind", [], { runId: "no-kind", kind: undefined });
			// ledger without a summary at all
			const dir = join(q, "audit", "orphan");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "ledger.jsonl"), JSON.stringify({ runId: "orphan", score: 0.5, candidateSha256: "abcd1234" }) + "\n", "utf8");
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.pass]));
			expect(byName["summary-fields-present"]).toBe(false);
			expect(res.failed).toBeGreaterThan(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("flags a runId that does not match its directory name", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-ac8-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-acd8-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			// dir "copied" but summary.runId says "original-run" -> run-dir-matches-runid FAIL
			writeCandidateRun(q, "copied", [{ score: 0.5 }], { runId: "original-run" });
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.pass]));
			expect(byName["run-dir-matches-runid"]).toBe(false);
			expect(res.failed).toBeGreaterThan(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("passes a production-shaped dataset (real skill names, ISO ts, long sha-like runIds, 12-hex digests)", () => {
		const q = mkdtempSync(join(tmpdir(), "arex-prod-"));
		const docs = mkdtempSync(join(tmpdir(), "arex-prodd-"));
		try {
			writeFileSync(join(docs, "archive-v1.md"), "# v1\n", "utf8");
			writeFileSync(join(docs, "archive-v31-prod-shape-validation.md"), "# v31\n", "utf8");
			// candidate-eval across two runs under the same digest (legitimate for digest merge)
			writeCandidateRun(q, "cand-3a2f1c9e2026-01-01", [{ skillId: "chemprop", caseId: "drug-molecular-property", score: 0.9, candidateSha256: "3a2f1c9e20ab", ts: "2026-01-01T12:00:00Z" }], { taskSuccessRate: 0.9 });
			writeCandidateRun(q, "cand-3a2f1c9e2026-02-01", [{ skillId: "chemprop", caseId: "drug-molecular-property", score: 0.7, candidateSha256: "3a2f1c9e20ab", ts: "2026-02-01T12:00:00Z" }], { taskSuccessRate: 0.8 });
			// separate digest, another skill — use a full 64-hex sha256 (real ledger shape)
			writeCandidateRun(q, "cand-2026-03-01", [{ skillId: "alphafold3-pytorch", caseId: "pdb-structure", score: 0.6, candidateSha256: "beefff000001c58f774391cdd44f2c3c88b89e35841399fdacb3ca0eefb6ab", ts: "2026-03-01T12:00:00Z" }], { taskSuccessRate: 0.5 });
			// a baseline-plumbing run (no candidate digest)
			writeCandidateRun(q, "baseline-plumbing-2026-04-01", [{ skillId: "chemprop", caseId: "drug-molecular-property", score: 0.5, candidateSha256: null, ts: "2026-04-01T12:00:00Z" }], { kind: "baseline-plumbing", taskSuccessRate: 0.5 });
			const res = auditConsistency({ qualityDir: q, docsRsiDir: docs });
			// full 64-hex digest must be well-formed (a 12-hex short digest is also valid)
			expect(Object.fromEntries(res.checks.map((c) => [c.name, c.pass]))["digest-wellformed"]).toBe(true);
			expect(res.failed).toBe(0);
			// byRun should surface the digest wellformed + rate warnings for the two-rate row without crashing on long runIds
			expect(Object.keys(res.byRun).length).toBeGreaterThan(0);
		} finally {
			rmSync(q, { recursive: true, force: true });
			rmSync(docs, { recursive: true, force: true });
		}
	});

	it("no-live-apply check FAILS on a missing source instead of reporting a clean pass", () => {
		// The invariant cannot be verified when the file it lives in is gone (rename,
		// build-layout change, partial publish). Skipping it made an error-level
		// safety check report PASS while having read nothing.
		const dir = mkdtempSync(join(tmpdir(), "arex-ac-"));
		try {
			const present = join(dir, "present.ts");
			writeFileSync(present, "const x = { appliedToLiveTree: false };\n", "utf8");
			const missing = join(dir, "gone.ts");

			// All sources present and clean -> pass.
			expect(checkNoLiveApply("no-live-apply", [present]).pass).toBe(true);
			// A source that cannot be read -> fail, and the detail says so.
			const res = checkNoLiveApply("no-live-apply", [present, missing]);
			expect(res.pass).toBe(false);
			expect(res.detail).toContain("MISSING");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
