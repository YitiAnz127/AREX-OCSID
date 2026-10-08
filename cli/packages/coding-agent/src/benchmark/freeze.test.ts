import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BENCHMARK_CONTENT_INDEX_FILE,
	BENCHMARK_REFREEZE_LOG_FILE,
	diffBenchmarkContentIndex,
	freezeBenchmark,
	verifyBenchmarkFrozen,
	type BenchmarkFreezeRecord,
} from "./freeze.ts";
import { buildManifest, type BenchmarkSplit } from "./schema.ts";

const FROZEN_AT = "2026-01-01T00:00:00.000Z";
const SPLITS: Record<BenchmarkSplit, string[]> = {
	train: ["skill-a", "skill-b"],
	dev: ["skill-c"],
	heldout: ["skill-d"],
};

/**
 * Build a throwaway corpus. `benchmarkRoot` is `<tmp>/benchmark-<n>` and the
 * case trees live beside it (`<tmp>/<skillId>/test-cases/...`), mirroring the
 * real layout where `skills/tests/benchmark-<version>` sits next to the
 * `skills/tests/<skillId>` case directories.
 */
function makeCorpus(): { dir: string; benchmarkRoot: string; seedRoot: string } {
	const dir = mkdtempSync(join(tmpdir(), "ocsid-freeze-"));
	for (const [split, skills] of Object.entries(SPLITS) as Array<[BenchmarkSplit, string[]]>) {
		for (const [index, skillId] of skills.entries()) {
			const caseDir = join(dir, skillId, "test-cases", `case-${index + 1}`);
			mkdirSync(caseDir, { recursive: true });
			writeFileSync(join(caseDir, "user_request.txt"), `request for ${skillId}\n`, "utf8");
			writeFileSync(join(caseDir, "assertions.json"), JSON.stringify({ split, skillId, index }), "utf8");
		}
	}
	const seedRoot = join(dir, "seed");
	mkdirSync(seedRoot, { recursive: true });
	const splitList = (Object.entries(SPLITS) as Array<[BenchmarkSplit, string[]]>).flatMap(([split, ids]) =>
		ids.map((skillId) => ({ skillId, split })),
	);
	writeFileSync(join(seedRoot, "manifest.json"), JSON.stringify(buildManifest("seed-v1", FROZEN_AT, splitList), null, 2) + "\n", "utf8");
	return { dir, benchmarkRoot: join(dir, "benchmark-test"), seedRoot };
}

function readLog(benchmarkRoot: string): BenchmarkFreezeRecord[] {
	return readFileSync(join(benchmarkRoot, BENCHMARK_REFREEZE_LOG_FILE), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as BenchmarkFreezeRecord);
}

describe("benchmark corpus freeze tooling (P1-01)", () => {
	it("freezes a new version from a split scope and verifies it against the tree", () => {
		const { dir, benchmarkRoot, seedRoot } = makeCorpus();
		try {
			const result = freezeBenchmark({
				benchmarkRoot,
				scopeFrom: seedRoot,
				name: "pilot-test-v2",
				frozenAt: FROZEN_AT,
				reason: "initial freeze of the test corpus",
			});
			expect(result.wrote).toBe(true);
			expect(result.record.action).toBe("freeze");
			// A new version inherits the scope AND records the identity it replaces.
			expect(result.record.previous?.name).toBe("seed-v1");
			expect(result.record.previous?.root).toBe("seed");
			expect(result.record.previous?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(result.contentUnchanged).toBe(false);
			expect(result.manifest.name).toBe("pilot-test-v2");
			// Split scope is inherited verbatim, never re-derived.
			expect(result.manifest.splits).toEqual({ train: SPLITS.train, dev: SPLITS.dev, heldout: SPLITS.heldout });
			const seedManifest = JSON.parse(readFileSync(join(seedRoot, "manifest.json"), "utf8"));
			expect(result.manifest.splitHash).toBe(seedManifest.splitHash);
			expect(result.manifest.contentHashes?.train).toMatch(/^[0-9a-f]{64}$/);
			expect(result.manifest.contentHash).toMatch(/^[0-9a-f]{64}$/);

			expect(existsSync(result.contentIndexPath)).toBe(true);
			const indexLines = readFileSync(result.contentIndexPath, "utf8").trim().split("\n");
			// One line per case file: 4 skills x 1 case x (user_request + assertions).
			expect(indexLines).toHaveLength(8);
			expect(result.record.caseFileCount).toBe(8);

			const log = readLog(benchmarkRoot);
			expect(log).toHaveLength(1);
			expect(log[0].reason).toBe("initial freeze of the test corpus");
			expect(log[0].contentHash).toBe(result.manifest.contentHash);

			const verify = verifyBenchmarkFrozen(benchmarkRoot);
			expect(verify.verified).toBe(true);
			expect(verify.indexClean).toBe(true);
			expect(verify.mismatchedSplits).toEqual([]);
			expect(verify.caseFileCount).toBe(8);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects edited case content and requires a reason to re-freeze", () => {
		const { dir, benchmarkRoot, seedRoot } = makeCorpus();
		try {
			freezeBenchmark({ benchmarkRoot, scopeFrom: seedRoot, name: "pilot-test-v2", frozenAt: FROZEN_AT, reason: "freeze 1" });
			const first = verifyBenchmarkFrozen(benchmarkRoot);
			const committedSha = readFileSync(join(benchmarkRoot, BENCHMARK_CONTENT_INDEX_FILE), "utf8")
				.split("\n")
				.map((line) => (line.trim() === "" ? undefined : (JSON.parse(line) as [string, string, string, string])))
				.find((parsed) => parsed?.[1] === "skill-a" && parsed?.[2] === "case-1/assertions.json")?.[3];

			const edited = join(dir, "skill-a", "test-cases", "case-1", "assertions.json");
			writeFileSync(edited, JSON.stringify({ edited: true }), "utf8");

			const drifted = verifyBenchmarkFrozen(benchmarkRoot);
			expect(drifted.verified).toBe(false);
			expect(drifted.indexClean).toBe(false);
			expect(drifted.mismatchedSplits).toEqual(["train"]);
			expect(drifted.index.changed).toHaveLength(1);
			expect(drifted.index.changed[0].skillId).toBe("skill-a");
			expect(drifted.index.changed[0].path).toBe("case-1/assertions.json");
			expect(drifted.index.changed[0].previousSha256).toBe(committedSha);
			expect(drifted.index.changed[0].sha256).not.toBe(committedSha);
			expect(drifted.actualContentHashes.train).not.toBe(first.actualContentHashes.train);

			// A freeze without a reason is refused: the audit trail must say why.
			expect(() => freezeBenchmark({ benchmarkRoot, reason: "   " })).toThrow(/non-empty reason/);

			const refrozen = freezeBenchmark({ benchmarkRoot, reason: "case assertion fix" });
			expect(refrozen.record.action).toBe("refreeze");
			expect(refrozen.record.previous?.contentHash).toBe(first.actualContentHash);
			expect(refrozen.record.previous?.contentHashes?.train).toBe(first.actualContentHashes.train);
			expect(refrozen.record.previous?.name).toBe("pilot-test-v2");
			expect(refrozen.record.previous?.root).toBe("benchmark-test");
			expect(refrozen.record.previous?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(refrozen.contentUnchanged).toBe(false);

			const log = readLog(benchmarkRoot);
			expect(log).toHaveLength(2);
			expect(log[1].reason).toBe("case assertion fix");
			expect(verifyBenchmarkFrozen(benchmarkRoot).verified).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("diffs added and removed case files against the committed index", () => {
		const { dir, benchmarkRoot, seedRoot } = makeCorpus();
		try {
			freezeBenchmark({ benchmarkRoot, scopeFrom: seedRoot, name: "pilot-test-v2", frozenAt: FROZEN_AT, reason: "freeze 1" });

			const addedDir = join(dir, "skill-c", "test-cases", "case-9");
			mkdirSync(addedDir, { recursive: true });
			writeFileSync(join(addedDir, "user_request.txt"), "new case\n", "utf8");
			unlinkSync(join(dir, "skill-d", "test-cases", "case-1", "assertions.json"));

			const diff = diffBenchmarkContentIndex(benchmarkRoot);
			expect(diff.indexPresent).toBe(true);
			expect(diff.entryCount).toBe(8);
			expect(diff.added.map((e) => `${e.split}/${e.skillId}/${e.path}`)).toEqual(["dev/skill-c/case-9/user_request.txt"]);
			expect(diff.removed.map((e) => `${e.split}/${e.skillId}/${e.path}`)).toEqual(["heldout/skill-d/case-1/assertions.json"]);
			expect(diff.changed).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a split scope whose stored splitHash disagrees with its split lists", () => {
		const { dir, benchmarkRoot, seedRoot } = makeCorpus();
		try {
			const manifestPath = join(seedRoot, "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.splitHash = "0".repeat(64);
			writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
			expect(() => freezeBenchmark({ benchmarkRoot, scopeFrom: seedRoot, name: "x", reason: "r" })).toThrow(
				/split scope is inconsistent/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("dry-run computes digests without writing, and a fresh directory needs a scope", () => {
		const { dir, benchmarkRoot, seedRoot } = makeCorpus();
		try {
			const dry = freezeBenchmark({ benchmarkRoot, scopeFrom: seedRoot, name: "pilot-test-v2", frozenAt: FROZEN_AT, reason: "dry", dryRun: true });
			expect(dry.wrote).toBe(false);
			expect(existsSync(join(benchmarkRoot, "manifest.json"))).toBe(false);
			expect(existsSync(dry.contentIndexPath)).toBe(false);
			expect(() => freezeBenchmark({ benchmarkRoot, name: "pilot-test-v2", reason: "no scope" })).toThrow(/pass scopeFrom/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
