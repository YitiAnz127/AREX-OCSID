/**
 * Corpus freeze / verify / diff tooling for the on-disk benchmark (P1-01).
 *
 * Why this exists
 * ---------------
 * `splitHash` only pins *which* skills sit in which split. The per-split
 * `contentHashes` are what actually bind an experiment to a measured corpus
 * revision. When case files are edited after a freeze, an honest corpus needs a
 * NEW version identity — never a silent in-place digest overwrite, because that
 * retroactively changes what an old experiment measured (see P1-01 of
 * docs/architecture-closure-review-2026-10-03.zh.md).
 *
 * Three operations, one of which writes:
 *   - `freezeBenchmark` : (re)write the manifest digests, refresh the per-file
 *                         content index, and append an auditable record (previous
 *                         digests + reason) to `refreeze-log.jsonl`.
 *   - `verifyBenchmarkFrozen` : recompute digests/index from disk and report
 *                         drift. Never writes, never throws on drift.
 *   - `diffBenchmarkContentIndex` : which case files were added / removed /
 *                         edited relative to the committed index.
 *
 * Split *scope* (membership, `splitHash`, `skillCounts`) is deliberately never
 * changed here: different membership is a different split freeze, produced by
 * `assignDeterministicSplits` + `buildManifest` in `./schema.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	collectCaseLines,
	computeBenchmarkContentDigest,
	computeBenchmarkSplitDigests,
} from "../audit/loader.ts";
import { BENCHMARK_MANIFEST_SCHEMA, splitEncoding, type BenchmarkManifest, type BenchmarkSplit } from "./schema.ts";

/** Identity string recorded in every refreeze-log entry. */
export const BENCHMARK_FREEZE_TOOL = "ocsid repo-skills benchmark freeze (P1-01)";

/** Per-file digest index used to diff corpus revisions file by file. */
export const BENCHMARK_CONTENT_INDEX_FILE = "content-index.jsonl";

/** Append-only audit trail of every (re)freeze, including previous digests. */
export const BENCHMARK_REFREEZE_LOG_FILE = "refreeze-log.jsonl";

/**
 * Version identity of the pilot corpus (P1-01).
 *
 * `benchmark-v2` is the corpus the RSI loop measures today; `benchmark-v1` is
 * retired *in place* — its manifest keeps the digests it froze on
 * 2026-01-01T00:00:00Z, which no longer match the on-disk case tree, and that
 * mismatch is deliberate. Consumers must name the version explicitly so a
 * corpus swap is a visible diff, never a silent digest rewrite.
 */
export const OFFICIAL_BENCHMARK_DIR = "benchmark-v2";
export const OFFICIAL_BENCHMARK_NAME = "pilot-v2";
export const ARCHIVED_BENCHMARK_DIR = "benchmark-v1";
export const ARCHIVED_BENCHMARK_NAME = "pilot-v1";

export const BENCHMARK_SPLITS: readonly BenchmarkSplit[] = ["train", "dev", "heldout"];

/** One parsed line of `content-index.jsonl` (same tuple the digest is built from). */
export interface BenchmarkContentIndexEntry {
	split: BenchmarkSplit;
	skillId: string;
	/** Workspace-relative POSIX path under `<skillId>/test-cases/`. */
	path: string;
	sha256: string;
}

/** A case file that differs between the committed index and the present tree. */
export interface BenchmarkContentChange extends BenchmarkContentIndexEntry {
	/** Digest recorded at freeze time (absent for an added file). */
	previousSha256?: string;
}

export interface BenchmarkContentDiff {
	/** False when the benchmark has no committed index yet (pre-P1-01 corpus). */
	indexPresent: boolean;
	/** Number of case files recorded in the committed index. */
	entryCount: number;
	added: BenchmarkContentIndexEntry[];
	removed: BenchmarkContentIndexEntry[];
	changed: BenchmarkContentChange[];
}

/** True when a diff shows no added, removed, or edited case file. */
export function isContentDiffClean(diff: BenchmarkContentDiff): boolean {
	return !diff.indexPresent || (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0);
}

export interface BenchmarkVerifyResult {
	root: string;
	name: string;
	frozenAt: string;
	splitHash: string;
	/** True when the manifest carries digests and every one matches the tree. */
	verified: boolean;
	/** True when the committed per-file index matches the tree (or is absent). */
	indexClean: boolean;
	expectedContentHash?: string;
	actualContentHash: string;
	expectedContentHashes?: Record<BenchmarkSplit, string>;
	actualContentHashes: Record<BenchmarkSplit, string>;
	/** Splits whose stored digest disagrees with the present case tree. */
	mismatchedSplits: BenchmarkSplit[];
	/** Case files in the corpus (from the index, else enumerated now). */
	caseFileCount: number;
	index: BenchmarkContentDiff;
}

export interface BenchmarkFreezeRecord {
	/** Wall-clock time of the freeze operation. */
	ts: string;
	action: "freeze" | "refreeze";
	tool: string;
	/** Benchmark directory name (the on-disk version identity). */
	root: string;
	name: string;
	frozenAt: string;
	splitHash: string;
	contentHash: string;
	contentHashes: Record<BenchmarkSplit, string>;
	caseFileCount: number;
	/** Why this (re)freeze was performed. Required, never optional. */
	reason: string;
	/** The superseded revision's digests, so old experiment identity survives. */
	previous?: {
		/** Directory basename the superseded manifest lives in. */
		root: string;
		name: string;
		frozenAt: string;
		/** sha256 of the previous manifest.json bytes (tamper evidence). */
		manifestSha256: string;
		contentHash?: string;
		contentHashes?: Record<BenchmarkSplit, string>;
	};
}

export interface BenchmarkFreezeResult {
	root: string;
	manifestPath: string;
	contentIndexPath: string;
	refreezeLogPath: string;
	manifest: BenchmarkManifest;
	record: BenchmarkFreezeRecord;
	/** True when the recomputed digests equal the ones already committed. */
	contentUnchanged: boolean;
	wrote: boolean;
}

export interface FreezeBenchmarkOptions {
	/** Benchmark directory. Created when it does not exist yet. */
	benchmarkRoot: string;
	/** Why this freeze happens. Required: an audited corpus never freezes silently. */
	reason: string;
	/** New corpus version name (e.g. `pilot-v2`). Defaults to the current name. */
	name?: string;
	/** ISO freeze timestamp. Defaults to the current UTC time. */
	frozenAt?: string;
	/**
	 * Seed the split scope from another benchmark directory. Required when
	 * `benchmarkRoot` has no manifest yet (the first freeze of a new version).
	 */
	scopeFrom?: string;
	/** Compute digests and the record without writing anything. */
	dryRun?: boolean;
}

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function manifestPathOf(benchmarkRoot: string): string {
	return path.join(benchmarkRoot, "manifest.json");
}

/** Read a committed manifest. Throws when the directory has none. */
export function readBenchmarkManifest(benchmarkRoot: string): BenchmarkManifest {
	const manifestPath = manifestPathOf(benchmarkRoot);
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`benchmark manifest not found: ${manifestPath}`);
	}
	const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BenchmarkManifest;
	if (parsed.schema !== BENCHMARK_MANIFEST_SCHEMA) {
		throw new Error(`unsupported benchmark manifest schema: ${String((parsed as { schema?: unknown }).schema)}`);
	}
	return parsed;
}

/** sha256 of the manifest bytes, recorded so later edits are detectable. */
export function benchmarkManifestSha256(benchmarkRoot: string): string {
	return sha256Hex(fs.readFileSync(manifestPathOf(benchmarkRoot), "utf8"));
}

/**
 * The digest lines for a benchmark's current corpus: one line per case file,
 * binding split + skill + portable relative path + file digest. The manifest's
 * `contentHash`/`contentHashes` are sha256 over exactly these lines.
 */
export function benchmarkContentIndexLines(benchmarkRoot: string, manifest: BenchmarkManifest): string[] {
	const skillRoot = path.resolve(benchmarkRoot, "..");
	return collectCaseLines(skillRoot, manifest.splits);
}

/** Path of the committed per-file index. */
export function benchmarkContentIndexPath(benchmarkRoot: string): string {
	return path.join(benchmarkRoot, BENCHMARK_CONTENT_INDEX_FILE);
}

function parseIndexLine(line: string, source: string): BenchmarkContentIndexEntry {
	const parsed = JSON.parse(line) as unknown;
	if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some((v) => typeof v !== "string")) {
		throw new Error(`malformed benchmark content index line in ${source}: ${line.slice(0, 120)}`);
	}
	const [split, skillId, relPath, sha256] = parsed as [string, string, string, string];
	if (!BENCHMARK_SPLITS.includes(split as BenchmarkSplit)) {
		throw new Error(`unknown split "${split}" in benchmark content index ${source}`);
	}
	return { split: split as BenchmarkSplit, skillId, path: relPath, sha256 };
}

function entryKey(entry: { split: BenchmarkSplit; skillId: string; path: string }): string {
	return `${entry.split}\u0000${entry.skillId}\u0000${entry.path}`;
}

/**
 * Compare the committed `content-index.jsonl` with the present case tree.
 * Reports added / removed / edited case files — the evidence a re-freeze needs.
 */
export function diffBenchmarkContentIndex(
	benchmarkRoot: string,
	manifest?: BenchmarkManifest,
): BenchmarkContentDiff {
	const resolved = manifest ?? readBenchmarkManifest(benchmarkRoot);
	const indexPath = benchmarkContentIndexPath(benchmarkRoot);
	if (!fs.existsSync(indexPath)) {
		return { indexPresent: false, entryCount: 0, added: [], removed: [], changed: [] };
	}
	const committed = new Map<string, BenchmarkContentIndexEntry>();
	for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const entry = parseIndexLine(line, indexPath);
		committed.set(entryKey(entry), entry);
	}
	const added: BenchmarkContentIndexEntry[] = [];
	const changed: BenchmarkContentChange[] = [];
	const seen = new Set<string>();
	for (const line of benchmarkContentIndexLines(benchmarkRoot, resolved)) {
		const entry = parseIndexLine(line, "computed content index");
		const key = entryKey(entry);
		seen.add(key);
		const before = committed.get(key);
		if (before === undefined) added.push(entry);
		else if (before.sha256 !== entry.sha256) changed.push({ ...entry, previousSha256: before.sha256 });
	}
	const removed = [...committed.entries()].filter(([key]) => !seen.has(key)).map(([, entry]) => entry);
	return { indexPresent: true, entryCount: committed.size, added, removed, changed };
}

/**
 * Recompute the corpus digests from disk and compare them with the manifest.
 * Read-only: drift is reported, never repaired (a repair is an explicit freeze).
 */
export function verifyBenchmarkFrozen(benchmarkRoot: string): BenchmarkVerifyResult {
	const manifest = readBenchmarkManifest(benchmarkRoot);
	const skillRoot = path.resolve(benchmarkRoot, "..");
	const actualContentHashes = computeBenchmarkSplitDigests(skillRoot, manifest.splits);
	const actualContentHash = computeBenchmarkContentDigest(skillRoot, manifest.splits);
	const mismatchedSplits = BENCHMARK_SPLITS.filter((split) => manifest.contentHashes?.[split] !== actualContentHashes[split]);
	const expectedContentHash = typeof manifest.contentHash === "string" ? manifest.contentHash : undefined;
	const digestVerified =
		expectedContentHash !== undefined &&
		expectedContentHash === actualContentHash &&
		mismatchedSplits.length === 0;
	const index = diffBenchmarkContentIndex(benchmarkRoot, manifest);
	const indexClean = isContentDiffClean(index);
	const caseFileCount = index.indexPresent
		? index.entryCount + index.added.length
		: benchmarkContentIndexLines(benchmarkRoot, manifest).length;
	return {
		root: benchmarkRoot,
		name: manifest.name,
		frozenAt: manifest.frozenAt,
		splitHash: manifest.splitHash,
		verified: digestVerified,
		indexClean,
		expectedContentHash,
		actualContentHash,
		expectedContentHashes: manifest.contentHashes,
		actualContentHashes,
		mismatchedSplits,
		caseFileCount,
		index,
	};
}

/**
 * (Re)freeze a benchmark's content digests against the present case tree.
 *
 * Writes `manifest.json`, `content-index.jsonl`, and appends one record to
 * `refreeze-log.jsonl` that preserves the superseded revision's digests and the
 * mandatory reason. Split scope is copied verbatim and re-verified against its
 * own `splitHash`, so a content freeze can never quietly reroute the splits.
 */
export function freezeBenchmark(options: FreezeBenchmarkOptions): BenchmarkFreezeResult {
	const root = path.resolve(options.benchmarkRoot);
	const reason = options.reason?.trim();
	if (reason === undefined || reason === "") {
		throw new Error("freezeBenchmark requires a non-empty reason (an audited freeze is never silent).");
	}
	const hasManifest = fs.existsSync(manifestPathOf(root));
	if (!hasManifest && options.scopeFrom === undefined) {
		throw new Error(`no manifest at ${root}; pass scopeFrom to seed the split scope of a new benchmark version.`);
	}
	// The superseded revision: this directory's own manifest when re-freezing,
	// otherwise the scope source whose identity this new version replaces.
	const previousRoot = hasManifest ? root : path.resolve(options.scopeFrom as string);
	const scope = readBenchmarkManifest(previousRoot);

	// Re-verify the scope itself: the split hash must describe the split lists.
	const splitList = BENCHMARK_SPLITS.flatMap((split) => scope.splits[split].map((skillId) => ({ skillId, split })));
	const recomputedSplitHash = sha256Hex(splitEncoding(splitList));
	if (recomputedSplitHash !== scope.splitHash) {
		throw new Error(
			`benchmark split scope is inconsistent: ${path.basename(root)} stores splitHash ${scope.splitHash} but its split lists hash to ${recomputedSplitHash}.`,
		);
	}

	const skillRoot = path.resolve(root, "..");
	const contentHashes = computeBenchmarkSplitDigests(skillRoot, scope.splits);
	const contentHash = computeBenchmarkContentDigest(skillRoot, scope.splits);
	const indexLines = benchmarkContentIndexLines(root, scope);
	const name = options.name ?? scope.name;
	const frozenAt = options.frozenAt ?? new Date().toISOString();
	const manifest: BenchmarkManifest = {
		schema: BENCHMARK_MANIFEST_SCHEMA,
		name,
		frozenAt,
		splitHash: scope.splitHash,
		splits: {
			train: [...scope.splits.train],
			dev: [...scope.splits.dev],
			heldout: [...scope.splits.heldout],
		},
		skillCounts: {
			train: scope.splits.train.length,
			dev: scope.splits.dev.length,
			heldout: scope.splits.heldout.length,
		},
		contentHash,
		contentHashes,
	};

	const contentUnchanged =
		hasManifest && scope.contentHash === contentHash && BENCHMARK_SPLITS.every((s) => scope.contentHashes?.[s] === contentHashes[s]);

	const record: BenchmarkFreezeRecord = {
		ts: new Date().toISOString(),
		action: hasManifest ? "refreeze" : "freeze",
		tool: BENCHMARK_FREEZE_TOOL,
		root: path.basename(root),
		name,
		frozenAt,
		splitHash: scope.splitHash,
		contentHash,
		contentHashes,
		caseFileCount: indexLines.length,
		reason,
		// The superseded revision is recorded even when a NEW directory takes over
		// the role (scopeFrom), so a corpus swap never erases the old identity.
		previous: {
			root: path.basename(previousRoot),
			name: scope.name,
			frozenAt: scope.frozenAt,
			manifestSha256: benchmarkManifestSha256(previousRoot),
			...(typeof scope.contentHash === "string" ? { contentHash: scope.contentHash } : {}),
			...(scope.contentHashes !== undefined ? { contentHashes: scope.contentHashes } : {}),
		},
	};

	const manifestPath = manifestPathOf(root);
	const contentIndexPath = benchmarkContentIndexPath(root);
	const refreezeLogPath = path.join(root, BENCHMARK_REFREEZE_LOG_FILE);
	if (options.dryRun === true) {
		return { root, manifestPath, contentIndexPath, refreezeLogPath, manifest, record, contentUnchanged, wrote: false };
	}

	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
	fs.writeFileSync(contentIndexPath, indexLines.join("\n") + "\n", "utf8");
	fs.appendFileSync(refreezeLogPath, JSON.stringify(record) + "\n", "utf8");
	return { root, manifestPath, contentIndexPath, refreezeLogPath, manifest, record, contentUnchanged, wrote: true };
}

/** Human-readable one-line label for a case-file change. */
export function formatContentChange(change: BenchmarkContentIndexEntry): string {
	return `${change.split}/${change.skillId}/${change.path}`;
}
