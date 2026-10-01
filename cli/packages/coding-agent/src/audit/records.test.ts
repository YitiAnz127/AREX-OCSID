import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { runAudit } from "./runner.ts";
import { persistAuditRun, readArtifacts, resolveAuditRunDir, ARTIFACT_MAX_BYTES } from "./records.ts";
import { uniqueTmpPath } from "./atomic.ts";
import { tokenGrader } from "./grader.ts";
import { defaultRequiredFragment, parseCaseAssertions } from "./parse.ts";
import { proxyExecutor } from "./types.ts";
import type { CaseRecord, CaseGrader } from "./types.ts";

function mkCases(): CaseRecord[] {
	const withAssertions = (skillId: string, caseId: string, assertions: string[]): CaseRecord => ({
		skillId,
		caseId,
		files: {
			userRequest: `do ${caseId}`,
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
	});
	return [
		withAssertions("chemprop", "train/case-a", ["calls chemprop_train_command_builder.py"]),
		withAssertions("gget", "dev/case-c", ["calls gget.search"]),
	];
}

const splitIndex = { "chemprop:train/case-a": "train", "gget:dev/case-c": "dev" };

describe("audit records persistence", () => {
	it("persists a plumbing baseline ledger + summary that round-trips deterministically", async () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-records-"));
		try {
			const cases = mkCases();
			const executor = proxyExecutor(() => "<baseline-plumbing artifact: no agent executed>");
			const grader: CaseGrader = tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
			const run = await runAudit(cases, { runId: "plumb-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
			const persisted = persistAuditRun(run, { qualityDir: tmp, kind: "baseline-plumbing" });

			expect(path.basename(persisted.dir)).toBe("plumb-1");
			expect(readFileSync(persisted.ledgerPath, "utf8").trim().split("\n")).toHaveLength(2); // both cases reach L3
			const summary = JSON.parse(readFileSync(persisted.summaryPath, "utf8"));
			expect(summary.kind).toBe("baseline-plumbing");
			expect(summary.ledgerRowCount).toBe(2);
			expect(summary.note).toContain("NOT a routing quality result");

			// Deterministic re-run reproduces identical ledger bytes.
			const run2 = await runAudit(cases, { runId: "plumb-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
			const tmp2 = mkdtempSync(path.join(tmpdir(), "audit-records-2-"));
			try {
				const p2 = persistAuditRun(run2, { qualityDir: tmp2, kind: "baseline-plumbing" });
				expect(readFileSync(p2.ledgerPath, "utf8")).toBe(readFileSync(persisted.ledgerPath, "utf8"));
			} finally {
				rmSync(tmp2, { recursive: true, force: true });
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("writes ledger + summary atomically with a unique tmp name (no leftover .tmp remnant)", async () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-records-atomic-"));
		try {
			const cases = mkCases();
			const executor = proxyExecutor(() => "<baseline-plumbing artifact: no agent executed>");
			const grader: CaseGrader = tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
			const run = await runAudit(cases, { runId: "atomic-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
			const persisted = persistAuditRun(run, { qualityDir: tmp, kind: "baseline-plumbing" });

			// Both files exist and are valid, and NO orphaned tmp fragments remain.
			expect(readFileSync(persisted.ledgerPath, "utf8")).toContain("chemprop");
			expect(readFileSync(persisted.summaryPath, "utf8")).toContain("atomic-1");
			const leftovers = readdirSync(persisted.dir).filter((n) => n.includes(".tmp"));
			expect(leftovers).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("uniqueTmpPath yields distinct paths for the same target (no cross-writer clobber)", () => {
		const target = path.join("C:", "some", "dir", "ledger.jsonl");
		const a = uniqueTmpPath(target);
		const b = uniqueTmpPath(target);
		expect(a).not.toBe(b);
		// Same directory as the target, so the rename stays on one filesystem.
		expect(path.dirname(a)).toBe(path.dirname(target));
		expect(a.startsWith(`${target}.tmp-`)).toBe(true);
	});

	it("does not overwrite an existing run or write while its run lock is held", async () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-records-lock-"));
		try {
			const cases = mkCases();
			const executor = proxyExecutor(() => "<baseline-plumbing artifact: no agent executed>");
			const grader: CaseGrader = tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
			const run = await runAudit(cases, { runId: "locked-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
			const persisted = persistAuditRun(run, { qualityDir: tmp });
			const before = readFileSync(persisted.ledgerPath, "utf8");
			expect(() => persistAuditRun(run, { qualityDir: tmp })).toThrow(/already exists/i);
			const release = lockfile.lockSync(persisted.dir, { realpath: false });
			try {
				expect(() => persistAuditRun(run, { qualityDir: tmp })).toThrow();
			} finally {
				release();
			}
			expect(readFileSync(persisted.ledgerPath, "utf8")).toBe(before);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("P0-1: persists artifacts.jsonl whose artifact sha256 matches the ledger row artifactSha256", async () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-records-artifact-"));
		try {
			const cases = mkCases();
			// Non-empty artifact → the executor yields a succeeded L3 row with a
			// real artifact that must be persisted and stay sha256-consistent with
			// the ledger row.
			const executor = proxyExecutor(() => "artifact-body-for-checksum\n");
			const grader: CaseGrader = tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
			const run = await runAudit(cases, { runId: "art-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
			const persisted = persistAuditRun(run, { qualityDir: tmp, kind: "baseline-plumbing" });

			const artifactText = readFileSync(persisted.artifactsPath, "utf8");
			const rows = artifactText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
			// Both cases reached L3 with a non-empty artifact → both rows persisted.
			expect(rows).toHaveLength(2);

			// For each row the recorded sha256 must equal the actual artifact body's
			// sha256, and must match the corresponding ledger row's artifactSha256.
			const ledger = readFileSync(persisted.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			for (const row of rows) {
				const digest = createHash("sha256").update(row.artifact, "utf8").digest("hex");
				expect(row.artifactSha256).toBe(digest);
				const ledgerRow = ledger.find((l) => l.skillId === row.skillId && l.caseId === row.caseId);
				expect(ledgerRow?.artifactSha256).toBe(digest);
				expect(row.bytes).toBe(Buffer.byteLength(row.artifact, "utf8"));
			}
			expect(persisted.artifactsPath).toContain("artifacts.jsonl");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("P0-1 backward-compat: readArtifacts returns [] for a legacy run dir without artifacts.jsonl (no error)", () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-records-legacy-"));
		try {
			// Simulate a legacy run: the run dir + ledger exist but no artifacts.jsonl.
			const runDir = resolveAuditRunDir(tmp, "legacy-run");
			require("node:fs").mkdirSync(runDir, { recursive: true });
			require("node:fs").writeFileSync(path.join(runDir, "ledger.jsonl"), "{}");
			expect(() => readArtifacts(runDir)).not.toThrow();
			expect(readArtifacts(runDir)).toEqual([]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("P0-1: oversized artifacts are truncated and flagged (bytes=<truncated actual>, truncated=true, sha256 of truncated body)", async () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-records-oversize-"));
		try {
			const cases = mkCases();
			const big = "x".repeat(ARTIFACT_MAX_BYTES + 5000) + "TAIL";
			const executor = proxyExecutor(() => big);
			const grader: CaseGrader = tokenGrader({ requiredFragment: defaultRequiredFragment, parsedAssertions: parseCaseAssertions });
			const run = await runAudit(cases, { runId: "oversize-1", runAt: "2026-01-01T00:00:00Z" }, { executor, grader, splitIndex });
			const persisted = persistAuditRun(run, { qualityDir: tmp, kind: "baseline-plumbing" });

			const rows = readFileSync(persisted.artifactsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
			expect(rows).toHaveLength(2);
			for (const row of rows) {
				expect(row.truncated).toBe(true);
				expect(row.artifact.length).toBe(ARTIFACT_MAX_BYTES);
				expect(row.bytes).toBe(ARTIFACT_MAX_BYTES);
				expect(row.artifactSha256).toBe(createHash("sha256").update(row.artifact, "utf8").digest("hex"));
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

