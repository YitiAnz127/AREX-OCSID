import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { auditPreflight, buildBaselineDeps, computeBenchmarkContentDigest, loadBenchmark } from "./loader.ts";
import { runAudit } from "./runner.ts";
import { persistAuditRun } from "./records.ts";
import { OFFICIAL_BENCHMARK_DIR, OFFICIAL_BENCHMARK_NAME } from "../benchmark/freeze.ts";

const srcAudit = path.dirname(fileURLToPath(import.meta.url));
// src/audit -> repo root is 5 levels up.
const repoRoot = path.resolve(srcAudit, "..", "..", "..", "..", "..");
const benchmarkRoot = path.join(repoRoot, "skills", "tests", OFFICIAL_BENCHMARK_DIR);

describe("audit loader over the frozen pilot benchmark", () => {
	it("loads the real frozen pilot manifest", () => {
		const loaded = loadBenchmark(benchmarkRoot);
		expect(loaded.manifest.name).toBe(OFFICIAL_BENCHMARK_NAME);
		expect(loaded.manifest.splits.train.length).toBe(4);
		expect(loaded.manifest.splits.dev.length).toBe(3);
		expect(loaded.manifest.splits.heldout.length).toBe(3);
	});

	it("enumerates >= 3 evidence-anchored cases per pilot skill with split index", () => {
		const loaded = loadBenchmark(benchmarkRoot);
		const perSkill = new Map<string, number>();
		for (const c of loaded.cases) perSkill.set(c.skillId, (perSkill.get(c.skillId) ?? 0) + 1);
		expect(loaded.cases.length).toBeGreaterThanOrEqual(30);
		for (const [skill, count] of perSkill) {
			expect(count).toBeGreaterThanOrEqual(3);
		}
		expect(loaded.splitIndex).toBeTruthy();
		// every case maps to a frozen split
		const { manifest, cases, splitIndex } = loaded;
		void manifest;
		for (const c of cases) {
			expect(splitIndex[`${c.skillId}:${c.caseId}`]).toBeTruthy();
		}
	});

	it("preflight is fully L0-valid (schema + real files) with no invalid cases", () => {
		const preflight = auditPreflight(benchmarkRoot);
		expect(preflight.l0Valid).toBe(preflight.caseCount);
		expect(preflight.l0Invalid).toEqual([]);
		expect(preflight.skillCount).toBe(10);
	});

	it("BUG-P2-01: preflight exposes a stable 64-hex content digest over every case's content", () => {
		const a = auditPreflight(benchmarkRoot);
		const b = auditPreflight(benchmarkRoot);
		expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect(a.contentHash).toBe(b.contentHash); // deterministic
		expect(a.contentHash).not.toBe(a.splitHash); // different from membership hash
	});

	it("BUG-P2-01: editing a case's user_request or assertions changes the content digest", () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-contentdigest-"));
		try {
			// Layout mirrors the loader's expectation: <root>/<skillId>/test-cases/<caseId>/
			const caseDir = path.join(tmp, "skill-a", "test-cases", "c1");
			mkdirSync(caseDir, { recursive: true });
			writeFileSync(path.join(caseDir, "user_request.txt"), "Do thing X\n", "utf8");
			writeFileSync(path.join(caseDir, "assertions.json"), JSON.stringify({ schema: "ocsid.usability-case.v1", checks: [{ id: "c1", pass: "thing X present" }] }), "utf8");
			const splitIndex = { train: ["skill-a"], dev: [], heldout: [] } as const;

			const base = computeBenchmarkContentDigest(tmp, splitIndex);
			expect(computeBenchmarkContentDigest(tmp, splitIndex)).toBe(base); // deterministic

			// Same case list, but mutate the user request.
			writeFileSync(path.join(caseDir, "user_request.txt"), "Do thing Y now\n", "utf8");
			expect(computeBenchmarkContentDigest(tmp, splitIndex)).not.toBe(base);

			// Restore, then mutate assertions instead.
			writeFileSync(path.join(caseDir, "user_request.txt"), "Do thing X\n", "utf8");
			writeFileSync(path.join(caseDir, "assertions.json"), JSON.stringify({ schema: "ocsid.usability-case.v1", checks: [{ id: "c1", pass: "thing Z present" }] }), "utf8");
			expect(computeBenchmarkContentDigest(tmp, splitIndex)).not.toBe(base);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("verifies the frozen manifest against every pilot case file", () => {
		expect(auditPreflight(benchmarkRoot).contentHashVerified).toBe(true);
	});

	it("rejects a changed fixture before scoring its split", () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "audit-freeze-"));
		try {
			const manifest = JSON.parse(readFileSync(path.join(benchmarkRoot, "manifest.json"), "utf8"));
			const testRoot = path.join(tmp, "tests");
			mkdirSync(path.join(testRoot, "benchmark-v1"), { recursive: true });
			writeFileSync(path.join(testRoot, "benchmark-v1", "manifest.json"), JSON.stringify(manifest), "utf8");
			for (const skillId of Object.values(manifest.splits).flat() as string[]) {
				cpSync(path.join(repoRoot, "skills", "tests", skillId), path.join(testRoot, skillId), { recursive: true });
			}
			const copied = path.join(testRoot, "benchmark-v1");
			expect(loadBenchmark(copied, ["train"]).cases.length).toBeGreaterThan(0);
			const fixture = path.join(testRoot, "chemprop", "test-cases", "sub-skills", "data-featurization", "multicomponent-npz-row-mismatch", "fixtures", "multicomponent.csv");
			writeFileSync(fixture, readFileSync(fixture, "utf8") + "changed\n", "utf8");
			expect(() => loadBenchmark(copied, ["train"])).toThrow(/content digest/i);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("runs + persists a baseline ledger over every real pilot case, labeled plumbing", async () => {
		const { cases, splitIndex, manifest } = loadBenchmark(benchmarkRoot);
		const deps = buildBaselineDeps();
		const run = await runAudit(cases, { runId: "plumb-real", runAt: "2026-01-01T00:00:00Z" }, { executor: deps.executor, grader: deps.grader, splitIndex });
		expect(run.summary.caseCount).toBe(cases.length);
		// Every real case reaches a graded depth (baseline artifact is non-empty → at least L2/L3).
		expect(run.cases.every((c) => c.depth === "L2" || c.depth === "L3")).toBe(true);

		const tmp = mkdtempSync(path.join(tmpdir(), "audit-real-"));
		try {
			const persisted = persistAuditRun(run, { qualityDir: tmp, kind: "baseline-plumbing" });
			const ledgerLines = readFileSync(persisted.ledgerPath, "utf8").trim().split("\n");
			expect(ledgerLines.length).toBe(cases.length);
			const summary = JSON.parse(readFileSync(persisted.summaryPath, "utf8"));
			expect(summary.kind).toBe("baseline-plumbing");
			expect(summary.caseCount).toBe(cases.length);
			expect(summary.skillCount).toBe(10);
			// per-split keys are "skill:split" pairs; every pilot skill should appear
			// with its frozen split (values are mean baseline rates, not case counts).
			const perSplit = summary.perSplit as Record<string, number>;
			expect(perSplit["chemprop:train"]).toBeTypeOf("number");
			expect(perSplit["gget:dev"]).toBeTypeOf("number");
			expect(Object.keys(perSplit).length).toBeGreaterThanOrEqual(10); // >= one group per pilot skill
			const splitNames = new Set(Object.keys(perSplit).map((k) => k.split(":")[1]));
			expect([...splitNames].sort()).toEqual(["dev", "heldout", "train"]);
			void manifest;
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
