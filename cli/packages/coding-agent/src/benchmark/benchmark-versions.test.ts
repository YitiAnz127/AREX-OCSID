import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadBenchmark } from "../audit/loader.ts";
import {
	ARCHIVED_BENCHMARK_DIR,
	ARCHIVED_BENCHMARK_NAME,
	BENCHMARK_REFREEZE_LOG_FILE,
	OFFICIAL_BENCHMARK_DIR,
	OFFICIAL_BENCHMARK_NAME,
	benchmarkManifestSha256,
	readBenchmarkManifest,
	verifyBenchmarkFrozen,
	type BenchmarkFreezeRecord,
} from "./freeze.ts";

const srcBenchmark = path.dirname(fileURLToPath(import.meta.url));
// src/benchmark -> repo root is 5 levels up.
const repoRoot = path.resolve(srcBenchmark, "..", "..", "..", "..", "..");
const testsRoot = path.join(repoRoot, "skills", "tests");
const officialRoot = path.join(testsRoot, OFFICIAL_BENCHMARK_DIR);
const archivedRoot = path.join(testsRoot, ARCHIVED_BENCHMARK_DIR);

/**
 * The digests `benchmark-v1` froze on 2026-01-01T00:00:00Z. They are kept
 * verbatim as the archive's tamper evidence: re-freezing v1 in place would
 * silently rewrite what every earlier v1 experiment measured.
 */
const ARCHIVED_DIGESTS = {
	frozenAt: "2026-01-01T00:00:00Z",
	splitHash: "fabcb729156e295afed6b395f1905939f18857158351c0945c0c93525a7c7a05",
	contentHash: "15202b56f704a8a4df61070c896b46802f0482d8f0af5e401dd7baa9dae35767",
	contentHashes: {
		train: "2bffa8aec5ee5cc7f726f2855a43f4405afba89f9b648243b10fc4a4c8ca0a55",
		dev: "da693963b0256869979055ab12d813f6f44736bd51de36fcae1c974911e6e5ae",
		heldout: "83403930d5e4137ca2ea99ea98a778783fdf31a650b2a25b3b3ed39e73916b72",
	},
} as const;

/**
 * P1-01 corpus-identity guards.
 *
 * `benchmark-v1` is the archive: its manifest must keep the digests it was
 * frozen with, and those digests must NOT match the present case tree (the case
 * files were edited after that freeze and the original revision is
 * unrecoverable — `skills/tests/` was never tracked by git).
 *
 * `benchmark-v2` is the corpus the RSI loop measures: digests, the per-file
 * content index, and the append-only refreeze log must all agree with the tree,
 * and the log must name the revision v2 superseded.
 */
describe("benchmark corpus version registry (P1-01)", () => {
	it("keeps benchmark-v1's archived digests byte-identical and still mismatched", () => {
		const archived = readBenchmarkManifest(archivedRoot);
		expect(archived.name).toBe(ARCHIVED_BENCHMARK_NAME);
		expect(archived.frozenAt).toBe(ARCHIVED_DIGESTS.frozenAt);
		expect(archived.splitHash).toBe(ARCHIVED_DIGESTS.splitHash);
		expect(archived.contentHash).toBe(ARCHIVED_DIGESTS.contentHash);
		expect(archived.contentHashes).toEqual(ARCHIVED_DIGESTS.contentHashes);

		// Deliberate drift: v1 describes a corpus revision that is not on disk.
		// If this ever reports VERIFIED, someone restored the original case files
		// or silently re-froze v1 — both require an explicit decision here.
		const verify = verifyBenchmarkFrozen(archivedRoot);
		expect(verify.verified).toBe(false);
		expect(verify.mismatchedSplits).toEqual(["train", "dev", "heldout"]);
	});

	it("serves the official benchmark-v2 with digests, index, and a clean preflight", () => {
		expect(OFFICIAL_BENCHMARK_DIR).not.toBe(ARCHIVED_BENCHMARK_DIR);
		const verify = verifyBenchmarkFrozen(officialRoot);
		expect(verify.verified).toBe(true);
		expect(verify.indexClean).toBe(true);
		expect(verify.mismatchedSplits).toEqual([]);
		expect(verify.index.entryCount).toBeGreaterThanOrEqual(43);

		const loaded = loadBenchmark(officialRoot);
		expect(loaded.manifest.name).toBe(OFFICIAL_BENCHMARK_NAME);
		// Same split membership as v1: this was a content re-freeze, not a re-split.
		expect(loaded.manifest.splitHash).toBe(ARCHIVED_DIGESTS.splitHash);
		expect(loaded.cases.length).toBe(43);
		expect(new Set(loaded.cases.map((c) => c.skillId)).size).toBe(10);
	});

	it("records the superseded revision in benchmark-v2's refreeze log", () => {
		const logPath = path.join(officialRoot, BENCHMARK_REFREEZE_LOG_FILE);
		const records = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as BenchmarkFreezeRecord);
		expect(records.length).toBeGreaterThanOrEqual(1);
		const first = records[0];
		expect(first.action).toBe("freeze");
		expect(first.root).toBe(OFFICIAL_BENCHMARK_DIR);
		expect(first.name).toBe(OFFICIAL_BENCHMARK_NAME);
		expect(first.reason.trim().length).toBeGreaterThan(0);
		// The archive's identity survives the version bump, including the exact
		// manifest bytes it was superseded with.
		expect(first.previous?.root).toBe(ARCHIVED_BENCHMARK_DIR);
		expect(first.previous?.name).toBe(ARCHIVED_BENCHMARK_NAME);
		expect(first.previous?.contentHash).toBe(ARCHIVED_DIGESTS.contentHash);
		expect(first.previous?.contentHashes).toEqual(ARCHIVED_DIGESTS.contentHashes);
		expect(first.previous?.manifestSha256).toBe(benchmarkManifestSha256(archivedRoot));
		// Every record agrees with the manifest currently on disk for v2.
		const manifest = readBenchmarkManifest(officialRoot);
		const last = records[records.length - 1];
		expect(last.contentHash).toBe(manifest.contentHash);
		expect(last.contentHashes).toEqual(manifest.contentHashes);
	});
});
