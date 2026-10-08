/**
 * Loads real benchmark cases + the frozen split index so the audit runner can
 * operate on the on-disk pilot benchmark rather than only synthetic fixtures.
 *
 * Layout (see skills/tests/benchmark-v2 and each skill's test-cases/):
 *   <benchmarkRoot>/manifest.json            — ocsid.benchmark.v1 manifest
 *   <skillRoot>/<skillId>/test-cases/...     — <caseDir>/user_request.txt + assertions.json
 *   (skillRoot = parent of the benchmark root; skills sit SIBLING to it under
 *   skills/tests/<skillId>, not beneath the benchmark dir — see resolve(benchmarkRoot,"..")).
 *
 * The loader is read-only and deterministic: it returns cases in stable
 * (skill, path) order and builds a `skillId:caseId → split` index from the
 * frozen manifest.
 *
 * P0-04 held-out isolation: pass an explicit `split` ALLOWLIST to materialize
 * only the requested splits. Candidate generation and ranking must only ever
 * load train/dev; held-out must be evaluated by an independent, later step so
 * the terminal set is never searched/selected against.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { CaseRecord } from "./types.ts";
import { proxyExecutor } from "./types.ts";
import { checkCaseFiles } from "./runner.ts";
import type { SplitIndex } from "./runner.ts";
import { tokenGrader } from "./grader.ts";
import { defaultRequiredFragment, parseCaseAssertions } from "./parse.ts";
import type { BenchmarkManifest, BenchmarkSplit } from "../benchmark/schema.ts";
import { assertCanonicalId } from "./id.ts";

export interface LoadedBenchmark {
	manifest: BenchmarkManifest;
	cases: CaseRecord[];
	splitIndex: SplitIndex;
}

/** Case id = the case directory name, which is unique within a skill. */
export function enumerateCaseRecords(skillRoot: string, skillId: string): CaseRecord[] {
	// skillId is a path component here; enforce the canonical shape at this entry
	// too rather than relying on every caller having done it (id.ts is the shared
	// choke point — collectCaseLines below already rejects symlinks for the same
	// reason).
	assertCanonicalId(skillId, "skillId");
	const testCasesRoot = path.join(skillRoot, skillId, "test-cases");
	if (!fs.existsSync(testCasesRoot)) return [];
	const out: CaseRecord[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.name === "user_request.txt" && fs.existsSync(path.join(dir, "assertions.json"))) {
				const caseId = path.relative(testCasesRoot, dir).split(path.sep).join("/");
				out.push({
					skillId,
					caseId,
					files: {
						userRequest: fs.readFileSync(path.join(dir, "user_request.txt"), "utf8"),
						assertionsText: fs.readFileSync(path.join(dir, "assertions.json"), "utf8"),
					},
				});
			}
		}
	};
	walk(testCasesRoot);
	return out;
}

/**
 * Deterministic digest over the *content* of every benchmark case (P2-01).
 *
 * `splitHash` only locks which skill ids sit in which split; it does NOT change
 * when a case's user_request/assertions are edited, so the same frozen `splitHash`
 * could silently correspond to completely different evaluation content across
 * versions. To actually bind an experiment to one evaluated corpus, we need a
 * content-level digest.
 *
 * The digest covers every file beneath each selected skill's test-cases tree,
 * including prompts, assertions, reviewer notes, indexes, and binary fixtures.
 * Each line binds the split, skill, portable relative path, and file digest.
 */
export function collectCaseLines(skillRoot: string, splitIndex: RecipeSplitLookup): string[] {
	const lines: string[] = [];
	for (const splitName of Object.keys(splitIndex) as BenchmarkSplit[]) {
		for (const skillId of splitIndex[splitName]) {
			const testCasesRoot = path.join(skillRoot, skillId, "test-cases");
			if (!fs.existsSync(testCasesRoot)) throw new Error(`benchmark case tree is missing: ${skillId}`);
			const walk = (dir: string): void => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isSymbolicLink()) throw new Error(`benchmark case tree contains a symbolic link: ${skillId}`);
					if (entry.isDirectory()) {
						walk(full);
					} else if (entry.isFile()) {
						const relative = path.relative(testCasesRoot, full).split(path.sep).join("/");
						const digest = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
						lines.push(JSON.stringify([splitName, skillId, relative, digest]));
					} else {
						throw new Error(`benchmark case tree contains a non-file entry: ${skillId}`);
					}
				}
			};
			walk(testCasesRoot);
		}
	}
	lines.sort();
	return lines;
}

/** A stable `skillId → split` lookup used by the content digest. */
type RecipeSplitLookup = Record<BenchmarkSplit, readonly string[]>;

/** Compute a sha256 content digest over every benchmark case file. */
export function computeBenchmarkContentDigest(skillRoot: string, splitIndex: RecipeSplitLookup): string {
	const lines = collectCaseLines(skillRoot, splitIndex);
	return createHash("sha256").update(lines.join("\n") + "\n", "utf8").digest("hex");
}

/** Per-split digests let a train/dev run verify its inputs without reading held-out files. */
export function computeBenchmarkSplitDigests(skillRoot: string, splits: RecipeSplitLookup): Record<BenchmarkSplit, string> {
	return {
		train: computeBenchmarkContentDigest(skillRoot, { train: splits.train, dev: [], heldout: [] }),
		dev: computeBenchmarkContentDigest(skillRoot, { train: [], dev: splits.dev, heldout: [] }),
		heldout: computeBenchmarkContentDigest(skillRoot, { train: [], dev: [], heldout: splits.heldout }),
	};
}

/**
 * Load the frozen benchmark. When `split` is provided, ONLY cases whose frozen
 * split is in the allowlist are returned (their prompt/assertion content is not
 * even read off disk). Omission means "load every split" — used by the audit
 * preflight and the independent held-out final eval, never by candidate ranking.
 */
export function loadBenchmark(benchmarkRoot: string, split?: readonly BenchmarkSplit[]): LoadedBenchmark {
	const manifestPath = path.join(benchmarkRoot, "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BenchmarkManifest;
	const allow = split ? new Set(split) : null;
	const skillRoot = path.resolve(benchmarkRoot, "..");
	const cases: CaseRecord[] = [];
	const splitIndex: SplitIndex = {};
	for (const splitName of Object.keys(manifest.splits) as BenchmarkSplit[]) {
		if (allow !== null && !allow.has(splitName)) continue;
		const expected = manifest.contentHashes?.[splitName];
		const actual = computeBenchmarkContentDigest(skillRoot, {
			train: splitName === "train" ? manifest.splits.train : [],
			dev: splitName === "dev" ? manifest.splits.dev : [],
			heldout: splitName === "heldout" ? manifest.splits.heldout : [],
		});
		if (expected !== actual) throw new Error(`benchmark content digest mismatch for ${splitName}`);
		for (const skillId of manifest.splits[splitName]) {
			for (const c of enumerateCaseRecords(skillRoot, skillId)) {
				cases.push(c);
				splitIndex[`${skillId}:${c.caseId}`] = splitName;
			}
		}
	}
	// Deterministic order: by skill then case id.
	cases.sort((a, b) => a.skillId.localeCompare(b.skillId) || a.caseId.localeCompare(b.caseId));
	return { manifest, cases, splitIndex };
}

export interface AuditPreflight {
	manifestName: string;
	splitHash: string;
	/** P2-01: sha256 over every case's user_request + assertions content. */
	contentHash: string;
	/** True when manifest.contentHash is present and matches the computed one. */
	contentHashVerified: boolean;
	skillCount: number;
	caseCount: number;
	perSplit: Record<string, number>;
	perSkill: Record<string, number>;
	l0Valid: number;
	l0Invalid: Array<{ skillId: string; caseId: string; reason: string }>;
}

/**
 * Deterministic L0 preflight: loads the frozen benchmark and validates that
 * every enumerated case has parseable user_request + ocsid.usability-case.v1
 * assertions. No artifact execution or grading — this is the read-only "can the
 * runner see the benchmark" check.
 */
export function auditPreflight(benchmarkRoot: string): AuditPreflight {
	const { manifest, cases, splitIndex } = loadBenchmark(benchmarkRoot);
	const perSplit: Record<string, number> = {};
	const perSkill: Record<string, number> = {};
	const l0Invalid: AuditPreflight["l0Invalid"] = [];
	let l0Valid = 0;
	for (const c of cases) {
		const split = splitIndex[`${c.skillId}:${c.caseId}`] ?? "?";
		perSplit[split] = (perSplit[split] ?? 0) + 1;
		perSkill[c.skillId] = (perSkill[c.skillId] ?? 0) + 1;
		const check = checkCaseFiles(c.files);
		if (check.ok) l0Valid += 1;
		else l0Invalid.push({ skillId: c.skillId, caseId: c.caseId, reason: check.reason });
	}
	const skillRoot = path.resolve(benchmarkRoot, "..");
	const contentHash = computeBenchmarkContentDigest(skillRoot, manifest.splits);
	const manifestContentHash = typeof (manifest as BenchmarkManifest & { contentHash?: unknown }).contentHash === "string"
		? (manifest as BenchmarkManifest & { contentHash: string }).contentHash
		: undefined;
	const contentHashVerified = manifestContentHash !== undefined && manifestContentHash === contentHash;
	if (!contentHashVerified) throw new Error("benchmark content digest mismatch for complete manifest");
	return {
		manifestName: manifest.name,
		splitHash: manifest.splitHash,
		contentHash,
		contentHashVerified,
		skillCount: Object.keys(perSkill).length,
		caseCount: cases.length,
		perSplit,
		perSkill,
		l0Valid,
		l0Invalid,
	};
}

/**
 * Build the default *deterministic* baseline executor + grader used by
 * `audit --run`. The sentinel artifact is produced without a live agent or
 * human, so the resulting task_success_rate is a *pipeline round-trip value
 * only* — never a routing-quality claim (the CLI and records label it).
 */
export function buildBaselineDeps() {
	// Legacy string-sentinel executor — only a proxy adapter now (B1).
	const executor = proxyExecutor((_c: CaseRecord) => "<baseline-plumbing artifact: no agent executed>");
	const grader = tokenGrader({
		requiredFragment: defaultRequiredFragment,
		parsedAssertions: (c) => parseCaseAssertions(c),
	});
	return { executor, grader };
}
