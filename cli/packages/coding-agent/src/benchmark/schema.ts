/**
 * Pilot benchmark contracts (Step 2).
 *
 * These types define the *frozen* evaluation surface for the RSI loop: a
 * benchmark manifest pins a train/dev/held-out split, a quality ledger records
 * one machine-graded observation per (candidate x case), and the grader
 * extracts a scalar from an artifact via a declared jsonpath. Nothing about
 * "improvement" is inferred here — the ledger only records measurements; stats
 * and conclusions happen on top of observed rows.
 *
 * The test-case container itself is the existing `disco.usability-case.v1`
 * contract (user_request.txt + README.md + assertions.json + fixtures/) defined
 * by verify-repo-skill/references/usability-test-cases.md.
 */

import { createHash } from "node:crypto";

export const BENCHMARK_MANIFEST_SCHEMA = "disco.benchmark.v1" as const;
export const QUALITY_LEDGER_SCHEMA = "disco.quality-ledger.v1" as const;

export type BenchmarkSplit = "train" | "dev" | "heldout";

/** Frozen split assignment for one skill. */
export interface BenchmarkSkillSplit {
	skillId: string;
	split: BenchmarkSplit;
}

/** Frozen benchmark manifest tying skills to splits + skill counts. */
export interface BenchmarkManifest {
	schema: typeof BENCHMARK_MANIFEST_SCHEMA;
	/** Human-readable benchmark name. */
	name: string;
	/** ISO timestamp when the split was frozen. */
	frozenAt: string;
	/** sha256 of the canonical split encoding (see splitEncoding()). */
	splitHash: string;
	/** Ordered split groups. */
	splits: Record<BenchmarkSplit, string[]>;
	/**
	 * Number of **skills** per split — NOT a count of test cases. Case counts are
	 * content-derived at load time (loader.enumerateCaseRecords), so the manifest
	 * never freezes them (P2-02: the old `caseCounts` misleadingly held skill counts).
	 */
	skillCounts: Record<BenchmarkSplit, number>;
	/** Frozen digest of every file in every selected skill's test-cases tree. */
	contentHash?: string;
	/** Separate digests permit train/dev loading without reading held-out content. */
	contentHashes?: Record<BenchmarkSplit, string>;
}

/**
 * Canonical encoding for computing a stable split hash. Splits are sorted and
 * each line is `<split>\t<skillId>`. Changing the membership or split changes
 * the hash, so downstream experiments can be bound to one frozen manifest.
 */
export function splitEncoding(skillSplits: BenchmarkSkillSplit[]): string {
	const lines = [...skillSplits]
		.sort((a, b) => a.split.localeCompare(b.split) || a.skillId.localeCompare(b.skillId))
		.map((s) => `${s.split}\t${s.skillId}`);
	return lines.join("\n") + "\n";
}

/**
 * Deterministically assign a frozen split to a pilot skill set.
 *
 * After sorting the (already-deterministically selected) pilot ids, the last
 * `heldout` become heldout, the previous `dev` become dev, and the rest train.
 * Fully reproducible and independent of any external RNG, so re-running always
 * yields the same frozen split.
 */
export function assignDeterministicSplits(
	pilotIds: string[],
	options?: { heldout?: number; dev?: number },
): BenchmarkSkillSplit[] {
	const heldout = options?.heldout ?? 3;
	const dev = options?.dev ?? 3;
	const sorted = [...pilotIds].sort();
	const name = sorted.length;
	const out: BenchmarkSkillSplit[] = [];
	sorted.forEach((id, index) => {
		let split: BenchmarkSplit;
		if (index >= name - heldout) split = "heldout";
		else if (index >= name - heldout - dev) split = "dev";
		else split = "train";
		out.push({ skillId: id, split });
	});
	return out;
}

/** Build a fully-frozen BenchmarkManifest from a deterministic split list. */
export function buildManifest(
	name: string,
	frozenAt: string,
	skillSplits: BenchmarkSkillSplit[],
): BenchmarkManifest {
	const splits: Record<BenchmarkSplit, string[]> = { train: [], dev: [], heldout: [] };
	for (const s of skillSplits) splits[s.split].push(s.skillId);
	for (const key of Object.keys(splits) as BenchmarkSplit[]) splits[key].sort();
	return {
		schema: BENCHMARK_MANIFEST_SCHEMA,
		name,
		frozenAt,
		splitHash: splitSha256(splitEncoding(skillSplits)),
		splits,
		skillCounts: {
			train: splits.train.length,
			dev: splits.dev.length,
			heldout: splits.heldout.length,
		},
	};
}

/** Minimal sha256 hex digest over UTF-8 text (RFC: node runtime). */
function splitSha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Qualifier of how a grade was produced.
 *
 * P0-3 step 1: `token_overlap` is the truthful, explicit name for the
 * deterministic token-overlap grader source (see audit/grader.ts tokenGrader).
 * It records the SAME scoring source as legacy `model_grader`'s deterministic
 * side (a word-overlap proxy); the two labels are considered one scoring source
 * and both map to `deterministic_proxy` (see GRADE_SOURCE_CATEGORY / gradeSourceCategory).
 */
export type GradedBy = "assertion" | "human" | "model_grader" | "token_overlap";

/** Candidate runs may use either the text-proxy or skill-snapshot executor. */
export type CandidateRunKind = "candidate-eval" | "candidate-agent-eval";

export function isCandidateRunKind(kind: unknown): kind is CandidateRunKind {
	return kind === "candidate-eval" || kind === "candidate-agent-eval";
}

/**
 * B3 (P0-3): separate the *scoring source* from the *executor type*.
 *
 * The four normative categories are:
 *  - `deterministic_proxy`   : the legacy proxy/null-answer scoring path (candidate-eval
 *                              blob comparison / sentinel strings). Never a success rate.
 *  - `programmatic_assertion`: an answer checked against a frozen programmatic assertion
 *                              (pass/fail, deterministic, auditable).
 *  - `llm_judge`             : a structured, rubric+model-versioned LLM judge output.
 *  - `human_review`          : an authenticated human review (reviewerId + evidenceRef).
 *
 * Historical rows keep their legacy `gradedBy` value (never renamed). This mapping is a
 * pure, read-side compatibility shim used at projection/report boundaries so different
 * sources are never conflated into a single unlabelled mean.
 */
export const GRADE_SOURCE_CATEGORY = {
	assertion: "programmatic_assertion",
	human: "human_review",
	// Legacy model_grader covers BOTH the old deterministic proxy and the newer
	// structured LLM judge. By default we label it the conservative deterministic
	// proxy; callers that know a model grader is a structured llm_judge may pass
	// `kind` explicitly.
	model_grader: "deterministic_proxy",
	// P0-3 step 1: token_overlap is the same deterministic scoring source as the
	// legacy model_grader proxy (a word-overlap grader), so historical model_grader
	// rows and new token_overlap rows are considered one source at projection time.
	token_overlap: "deterministic_proxy",
} as const satisfies Record<GradedBy, string>;

export type GradeSourceCategory =
	| "deterministic_proxy"
	| "programmatic_assertion"
	| "llm_judge"
	| "human_review";

/** Read-side compatibility mapping of a legacy gradedBy (or explicit kind) to a B3 category. */
export function gradeSourceCategory(
	source: GradedBy | "llm_judge",
	kind?: "proxy" | "llm",
): GradeSourceCategory {
	if (source === "human") return "human_review";
	if (source === "assertion") return "programmatic_assertion";
	if (source === "llm_judge") return "llm_judge";
	// legacy model_grader: disambiguate by explicit kind when the caller knows it.
	if (kind === "llm") return "llm_judge";
	// P0-3 step 1: token_overlap is the deterministic word-overlap proxy — the
	// same source as legacy model_grader's deterministic side.
	if (source === "token_overlap") return "deterministic_proxy";
	return "deterministic_proxy";
}

/** One graded observation of one candidate against one test case. */
export interface QualityLedgerRow {
	schema: typeof QUALITY_LEDGER_SCHEMA;
	/** Unique run id (one per candidate evaluation pass). */
	runId: string;
	skillId: string;
	/** Test-case id (e.g. `sub-skills/inference/minimal-smoke-test`). */
	caseId: string;
	/** Content digest of the skill content being graded; null = baseline skill. */
	candidateSha256: string | null;
	/**
	 * sha256 of the graded artifact (response / produced file). Omit when the
	 * judgement was produced directly from an embedded score (e.g. a human or
	 * grader judgement recorded in the observation layer, which by privacy
	 * design never stores response content).
	 */
	artifactSha256?: string;
	/** Extractor locating the scalar to grade inside the artifact. */
	extractor: {
		path: string;
		jsonpath: string;
	};
	/** The extracted value (kept as raw data; interpretation is downstream). */
	observed?: unknown;
	/** Graded score in [0,1], or null when the case is only pass/fail without score. */
	score: number | null;
	gradedBy: GradedBy;
	/**
	 * P0-3 step 2: for a real (non-proxy) grader, the exact judge that produced
	 * this score — its model id and the grading-rubric version it executed. This
	 * makes a number traceable to its grader implementation, complementing the
	 * coarse `gradedBy` category. Absent for deterministic proxies and human rows.
	 */
	judge?: { modelVersion?: string; rubricVersion?: string };
	/** ISO timestamp of the grading. */
	ts: string;
}
