/**
 * Cross-run score report.
 *
 * Aggregates recorded quality ledgers (text-proxy and skill-snapshot candidate
 * runs) into a per-case,
 * per-candidate comparison so real human/model grades baked in via `grade` can
 * be read back and compared WITHOUT re-running.
 *
 * Honesty contract:
 *  - This only READS recorded ledger/summary values; it manufactures nothing and
 *    does not re-grade.
 *  - The report surfaces structural issues it detects (score out of range, ledger
 *    row count vs manifest, duplicate (skill,case) rows, runId mismatch, mixed
 *    candidate digests in one run) as `issues` — it does NOT silently "fix" them.
 *  - task_success_rate shown is the recorded value; per-case entries expose the
 *    actual gradedBy/score/ts so a reviewer can see provenance of each number.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isCandidateRunKind, type QualityLedgerRow } from "../benchmark/schema.ts";
import { assertCanonicalId, resolveRunDir } from "../audit/id.ts";

export type IssueKind = "SCORE_RANGE" | "ROW_TOO_MANY" | "ROW_TOO_FEW" | "DUPLICATE_CASE" | "RUN_ID_MISMATCH" | "MIXED_DIGEST";

export interface Issue {
	runId: string;
	kind: IssueKind;
	detail: string;
}

export interface CaseEntry {
	runId: string;
	score: number | null;
	gradedBy: string;
	ts: string;
}

export interface CaseReport {
	skillId: string;
	caseId: string;
	entries: CaseEntry[];
}

export interface RunReport {
	runId: string;
	kind: string;
	candidateSha256: string | null;
	taskSuccessRate: number | null;
	caseCount: number;
	ledgerRowCount: number;
	gradedByCounts: Record<string, number>;
}

export interface ScoreReport {
	runs: RunReport[];
	byCase: CaseReport[];
	byCandidate: CandidateAggregate[];
	issues: Issue[];
}

export interface SkillAggregate {
	skillId: string;
	caseCount: number;
	mean: number | null;
}

export interface CandidateAggregate {
	candidateSha256: string | null;
	caseCount: number;
	scoredCount: number;
	mean: number | null;
	gradedBySources: string[];
	perSkill: SkillAggregate[];
}

interface SummaryLike {
	runId?: string;
	kind?: string;
	taskSuccessRate?: number | null;
	caseCount?: number;
	ledgerRowCount?: number;
	note?: string;
	[k: string]: unknown;
}

function isFiniteInRange(x: unknown): x is number {
	return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

export interface BaselineReading {
	found: boolean;
	runId: string;
	rate: number | null;
	kind: string | null;
	note: string | null;
}

/**
 * Read a run's recorded task_success_rate for use as a relative baseline in
 * evalreport. Any run kind may serve as a baseline source; the kind + note are
 * returned so the caller surfaces where the baseline number came from (a
 * deterministic baseline is NOT a routing-quality claim).
 */
export function readBaselineRate(qualityDir: string, runId: string): BaselineReading {
	// BUG-P0-02: containment check before reading.
	const runDir = resolveRunDir(qualityDir, runId);
	const summaryPath = path.join(runDir, "summary.json");
	if (!existsSync(summaryPath)) {
		return { found: false, runId, rate: null, kind: null, note: null };
	}
	let summary: SummaryLike;
	try {
		summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryLike;
	} catch {
		return { found: false, runId, rate: null, kind: null, note: null };
	}
	const rate = typeof summary.taskSuccessRate === "number" ? summary.taskSuccessRate : null;
	return {
		found: true,
		runId,
		rate,
		kind: typeof summary.kind === "string" ? summary.kind : null,
		note: typeof summary.note === "string" ? summary.note : null,
	};
}

export interface BaselineByCaseEntry {
	score: number | null;
	gradedBy: string;
	ts: string;
}

export interface BaselineByCase {
	found: boolean;
	runId: string;
	kind: string | null;
	note: string | null;
	/** key `${skillId}::${caseId}` -> recorded score/grader. */
	byCase: Map<string, BaselineByCaseEntry>;
	caseCount: number;
}

/**
 * Read a baseline run's per-case ledger scores so evalreport can show a per-case
 * delta against the candidate. Reads any run kind's ledger (baseline-plumbing
 * rows carry candidateSha256=null AND assertion scores). Presence of a key means
 * the baseline actually scored that case; absence means it did not (surfaced as
 * "no baseline" rather than a fabricated 0).
 */
export function readBaselineByCase(qualityDir: string, runId: string): BaselineByCase {
	// BUG-P0-02: containment check before reading.
	const dir = resolveRunDir(qualityDir, runId);
	const summaryPath = path.join(dir, "summary.json");
	const ledgerPath = path.join(dir, "ledger.jsonl");
	if (!existsSync(summaryPath) || !existsSync(ledgerPath)) {
		return { found: false, runId, kind: null, note: null, byCase: new Map(), caseCount: 0 };
	}
	let summary: SummaryLike;
	try {
		summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryLike;
	} catch {
		return { found: false, runId, kind: null, note: null, byCase: new Map(), caseCount: 0 };
	}
	const byCase = new Map<string, BaselineByCaseEntry>();
	for (const line of readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)) {
		try {
			const row = JSON.parse(line) as { skillId?: string; caseId?: string; score?: number | null; gradedBy?: string; ts?: string };
			if (typeof row.skillId === "string" && typeof row.caseId === "string") {
				byCase.set(`${row.skillId}::${row.caseId}`, {
					score: typeof row.score === "number" ? row.score : null,
					gradedBy: typeof row.gradedBy === "string" ? row.gradedBy : "unknown",
					ts: typeof row.ts === "string" ? row.ts : "unknown",
				});
			}
		} catch {
			// skip malformed line
		}
	}
	return {
		found: true,
		runId,
		kind: typeof summary.kind === "string" ? summary.kind : null,
		note: typeof summary.note === "string" ? summary.note : null,
		byCase,
		caseCount: byCase.size,
	};
}

export function buildScoreReport(qualityDir: string, opts: { filterRunId?: string } = {}): ScoreReport {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { runs: [], byCase: [], byCandidate: [], issues: [] };

	const issues: Issue[] = [];
	const runs: RunReport[] = [];
	const byCaseMap = new Map<string, CaseReport>(); // key `${skillId}::${caseId}`
	const candidateScores = new Map<string | null, Array<{ skillId: string; caseId: string; score: number; gradedBy: string }>>();
	const digestsPerRun = new Map<string, Set<string | null>>();

	for (const dir of readdirSync(auditRoot)) {
		if (opts.filterRunId !== undefined) {
			// BUG-P0-02: a caller-supplied run filter must itself be a canonical id.
			assertCanonicalId(opts.filterRunId, "filterRunId");
			if (dir !== opts.filterRunId) continue;
		}
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(summaryPath) || !existsSync(ledgerPath)) continue; // not an evaluable run

		let summary: SummaryLike;
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryLike;
		} catch {
			issues.push({ runId: dir, kind: "ROW_TOO_FEW", detail: "summary.json is not valid JSON" });
			continue;
		}
		if (!isCandidateRunKind(summary.kind)) continue;

		const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
		const rows: QualityLedgerRow[] = [];
		try {
			for (const line of lines) rows.push(JSON.parse(line) as QualityLedgerRow);
		} catch {
			issues.push({ runId: dir, kind: "ROW_TOO_FEW", detail: "ledger.jsonl contains a malformed line" });
			continue;
		}

		// runId-in-row vs folder
		for (const r of rows) {
			if (r.runId && r.runId !== dir) {
				issues.push({ runId: dir, kind: "RUN_ID_MISMATCH", detail: `row runId "${r.runId}" != folder "${dir}" (skill:case ${r.skillId}:${r.caseId})` });
			}
		}

		// digest consistency within the run
		const digests = new Set(rows.map((r) => r.candidateSha256));
		digestsPerRun.set(dir, digests);
		if (digests.size > 1) {
			issues.push({ runId: dir, kind: "MIXED_DIGEST", detail: `run has ${digests.size} distinct candidateSha256 values` });
		}
		const candidateSha256 = rows.find((r) => r.candidateSha256 !== null)?.candidateSha256 ?? null;

		// row count vs summary
		const expectedRows = typeof summary.ledgerRowCount === "number" ? summary.ledgerRowCount : null;
		if (expectedRows !== null && expectedRows !== rows.length) {
			issues.push({
				runId: dir,
				kind: expectedRows > rows.length ? "ROW_TOO_FEW" : "ROW_TOO_MANY",
				detail: `summary.ledgerRowCount=${expectedRows} vs actual rows=${rows.length}`,
			});
		}

		// per-case entries + per-row score-range checks + duplicate detection
		const gradedByCounts: Record<string, number> = {};
		const seenKeys = new Set<string>();
		for (const r of rows) {
			gradedByCounts[r.gradedBy] = (gradedByCounts[r.gradedBy] ?? 0) + 1;
			if (r.score !== null && !isFiniteInRange(r.score)) {
				issues.push({ runId: dir, kind: "SCORE_RANGE", detail: `row ${r.skillId}:${r.caseId} score=${r.score} (gradedBy=${r.gradedBy}) not in [0,1]` });
			}
			const key = `${r.skillId}::${r.caseId}`;
			if (seenKeys.has(key)) {
				issues.push({ runId: dir, kind: "DUPLICATE_CASE", detail: `duplicate row for ${r.skillId}:${r.caseId}` });
			} else {
				seenKeys.add(key);
			}
			const entry: CaseEntry = { runId: dir, score: r.score, gradedBy: r.gradedBy, ts: r.ts };
			const existing = byCaseMap.get(key);
			if (existing) existing.entries.push(entry);
			else byCaseMap.set(key, { skillId: r.skillId, caseId: r.caseId, entries: [entry] });
			// BUG-P1-14: only finite, in-range [0,1] scores may enter a candidate's
			// mean. Out-of-range / NaN / Infinity rows are flagged above but must
			// NOT be folded into the aggregate, or one bad row skews the mean.
			if (r.score !== null && isFiniteInRange(r.score)) {
				const bucket = candidateScores.get(r.candidateSha256) ?? [];
				bucket.push({ skillId: r.skillId, caseId: r.caseId, score: r.score, gradedBy: r.gradedBy });
				candidateScores.set(r.candidateSha256, bucket);
			}
		}

		runs.push({
			runId: dir,
			kind: summary.kind,
			candidateSha256,
			taskSuccessRate: summary.taskSuccessRate ?? null,
			caseCount: typeof summary.caseCount === "number" ? summary.caseCount : rows.length,
			ledgerRowCount: rows.length,
			gradedByCounts,
		});
	}

	const byCase = [...byCaseMap.values()].sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0) || (a.caseId < b.caseId ? -1 : 1));
	runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

	// Aggregate per candidate: mean over its UNIQUE scored cases, plus per-skill means.
	//
	// A case scored across multiple runs of the same digest must contribute ONCE to
	// the digest mean — not once per row. Collapsing each (skillId, caseId) to the
	// mean of its observations (order-independent) prevents a run that wrote more
	// rows from dominating the digest and stops shared cases from being double-
	// counted, which previously skewed the candidate ranking used for promotion /
	// regression (~BUG: un-normalized digest mean).
	const byCandidate: CandidateAggregate[] = [];
	for (const [digest, rows] of candidateScores) {
		const caseSum = new Map<string, { skillId: string; sum: number; n: number }>();
		const sources = new Set<string>();
		for (const r of rows) {
			sources.add(r.gradedBy);
			const key = `${r.skillId}::${r.caseId}`;
			const c = caseSum.get(key) ?? { skillId: r.skillId, sum: 0, n: 0 };
			c.sum += r.score;
			c.n += 1;
			caseSum.set(key, c);
		}
		// One mean per unique case; each case weighs equally in the digest mean.
		const caseMeans = [...caseSum.values()].map((c) => ({ skillId: c.skillId, mean: c.sum / c.n }));
		const perSkillMap = new Map<string, { count: number; sum: number }>();
		let total = 0;
		for (const c of caseMeans) {
			total += c.mean;
			const s = perSkillMap.get(c.skillId) ?? { count: 0, sum: 0 };
			s.count += 1;
			s.sum += c.mean;
			perSkillMap.set(c.skillId, s);
		}
		const uniqueCases = caseMeans.length;
		const perSkill = [...perSkillMap.entries()]
			.map(([skillId, s]) => ({ skillId, caseCount: s.count, mean: s.sum / s.count }))
			.sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
		byCandidate.push({
			candidateSha256: digest,
			caseCount: uniqueCases,
			scoredCount: uniqueCases,
			mean: uniqueCases === 0 ? null : total / uniqueCases,
			gradedBySources: [...sources].sort(),
			perSkill,
		});
	}
	byCandidate.sort((a, b) => {
		const am = a.mean ?? -1;
		const bm = b.mean ?? -1;
		if (am > bm) return -1;
		if (am < bm) return 1;
		// BUG (determinism): equal means previously returned 0, leaving the order
		// to the stable sort's insertion order (which derives from readdirSync /
		// ledger row order) — non-deterministic output for tied candidates. Break
		// ties on the candidate digest (null digest sorts first) so the ranking is
		// reproducible.
		const ad = a.candidateSha256 ?? "";
		const bd = b.candidateSha256 ?? "";
		return ad < bd ? -1 : ad > bd ? 1 : 0;
	});

	return { runs, byCase, byCandidate, issues };
}

export interface SkillDelta {
	skillId: string;
	comparedCases: number;
	/** Mean (candidate - baseline) over cases BOTH sides scored, in points. */
	meanDelta: number | null;
	baselineGradedBy: string;
}

/**
 * Per-skill relative delta between ONE candidate run and a baseline run.
 *
 * Only cases scored by BOTH the candidate run and the baseline run participate,
 * so the comparison is apples-to-apples per case; skills with no overlap yield
 * no entry (surfaced by the caller). Deltas are numeric differences only and are
 * labelled with the baseline grader.
 */
export function aggregateSkillDeltaFromCases(byCase: CaseReport[], candidateRunId: string, baselineByCase: Map<string, BaselineByCaseEntry>): SkillDelta[] {
	const acc = new Map<string, { count: number; sum: number; baseGradedBy: Set<string> }>();
	for (const c of byCase) {
		const cand = c.entries.find((e) => e.runId === candidateRunId);
		if (!cand || typeof cand.score !== "number") continue;
		const base = baselineByCase.get(`${c.skillId}::${c.caseId}`);
		if (!base || typeof base.score !== "number") continue;
		const s = acc.get(c.skillId) ?? { count: 0, sum: 0, baseGradedBy: new Set<string>() };
		s.count += 1;
		s.sum += cand.score - base.score;
		s.baseGradedBy.add(base.gradedBy);
		acc.set(c.skillId, s);
	}
	const out: SkillDelta[] = [];
	for (const [skillId, s] of acc) {
		out.push({ skillId, comparedCases: s.count, meanDelta: s.sum / s.count, baselineGradedBy: [...s.baseGradedBy].sort().join("|") });
	}
	return out.sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}

export interface CoverageGap {
	candidateCovered: number;
	overlapped: number;
	candidateOnly: number;
	baselineOnly: number;
	candidateOnlyCases: string[];
}

/**
 * Surface how much of a candidate run actually got compared against a baseline
 * run -- so "no baseline for case X" is explicit rather than silently omitted.
 * A case counts toward the candidate side when the candidate run scored it
 * (irrespective of numeric vs null score); overlap requires the baseline to have
 * scored the same case. This is pure bookkeeping, no judgement.
 *
 * NOTE (deferred, P2-05): overlap here is PRESENCE-based, while
 * aggregateSkillDeltaFromCases/aggregateSkillDeltaByDigest require a NUMERIC
 * baseline score. A baseline row scored with a null score is counted as
 * "overlapped" here but excluded from the delta's compared cases. Aligned on
 * purpose: this function reports how much the baseline scored (bookkeeping),
 * the delta functions report how much is numerically comparable. A single
 * overlap definition for all four fields would need to re-categorize
 * null-mismatched cases (currently they fall out of both overlap and
 * candidateOnly), so this contract difference is left documented and intentional.
 */
export function coverageGap(byCase: CaseReport[], candidateRunId: string, baselineByCase: Map<string, BaselineByCaseEntry>): CoverageGap {
	const baselineKeys = new Set(baselineByCase.keys());
	let overlapped = 0;
	const candidateOnlyCases: string[] = [];
	let candidateCovered = 0;
	for (const c of byCase) {
		const cand = c.entries.find((e) => e.runId === candidateRunId);
		if (!cand) continue;
		candidateCovered += 1;
		const key = `${c.skillId}::${c.caseId}`;
		if (baselineKeys.has(key)) overlapped += 1;
		else candidateOnlyCases.push(key);
	}
	candidateOnlyCases.sort();
	return {
		candidateCovered,
		overlapped,
		candidateOnly: candidateOnlyCases.length,
		baselineOnly: baselineKeys.size - overlapped,
		candidateOnlyCases: candidateOnlyCases.slice(0, 20),
	};
}

export type DigestMergeStrategy = "mean" | "latest";

/** Validate a candidate digest prefix: at least 8 hex chars. Returns a message on failure or null when valid. */
export function validateDigestPrefix(digestPrefix: string): string | null {
	if (typeof digestPrefix !== "string" || digestPrefix.length < 8) {
		return "candidate digest prefix must be at least 8 characters";
	}
	if (!/^[0-9a-fA-F]+$/.test(digestPrefix)) {
		return "candidate digest prefix must contain only hex characters [0-9a-fA-F]";
	}
	return null;
}

export interface DigestCaseEntry {
	mean: number;
	gradedBy: Set<string>;
	count: number;
	latestTs: string | null;
	strategy: DigestMergeStrategy;
}

export interface DigestCaseScores {
	/** key `${skillId}::${caseId}` -> merged score for this digest on the case (mean or latest per strategy). */
	byCase: Map<string, DigestCaseEntry>;
	candidateCovered: number;
	matchedRuns: number;
}

/**
 * Gather per-case scores for a candidate digest across all candidate runs.
 * `digestPrefix` must be at least 8 hex chars (validated). Merge strategy:
 *  - "mean" (default): average all numeric scores for the case across runs.
 *  - "latest": take the score with the newest `ts`; ties break to the later row.
 * gradedBy sources are always collected across the runs that scored the case.
 */
export function readDigestCaseScores(qualityDir: string, digestPrefix: string, opts: { merge?: DigestMergeStrategy } = {}): DigestCaseScores {
	const invalid = validateDigestPrefix(digestPrefix);
	if (invalid !== null) throw new Error(invalid);
	const merge = opts.merge ?? "mean";
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { byCase: new Map(), candidateCovered: 0, matchedRuns: 0 };
	// For "mean" accumulate sum/count; for "latest" keep the newest candidate row per case.
	const meanAcc = new Map<string, { sum: number; count: number; gradedBy: Set<string> }>();
	const latestAcc = new Map<string, { score: number; ts: string; seq: number; gradedBy: Set<string> }>();
	let matchedRuns = 0;
	let seq = 0;
	// Sort run dirs so enumeration order (which drives the "latest" tie-break via
	// `seq`) is deterministic regardless of filesystem enumeration order — equal
	// timestamps across runs otherwise resolve differently on different hosts.
	for (const dir of readdirSync(auditRoot).sort()) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(summaryPath) || !existsSync(ledgerPath)) continue;
		let summary: SummaryLike;
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryLike;
		} catch {
			continue;
		}
		if (!isCandidateRunKind(summary.kind)) continue;
		let runMatched = false;
		for (const line of readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)) {
			let row: { skillId?: string; caseId?: string; candidateSha256?: string | null; score?: number | null; gradedBy?: string; ts?: string };
			try {
				row = JSON.parse(line) as typeof row;
			} catch {
				continue;
			}
			if (typeof row.candidateSha256 !== "string" || !row.candidateSha256.startsWith(digestPrefix)) continue;
			if (typeof row.skillId !== "string" || typeof row.caseId !== "string" || typeof row.score !== "number") continue;
			runMatched = true;
			seq += 1;
			const key = `${row.skillId}::${row.caseId}`;
			const ts = typeof row.ts === "string" ? row.ts : "";
			if (merge === "latest") {
				const cur = latestAcc.get(key);
				if (!cur || ts > cur.ts || (ts === cur.ts && seq > cur.seq)) {
					const gradedBy = new Set(cur?.gradedBy ?? []);
					gradedBy.add(row.gradedBy ?? "unknown");
					latestAcc.set(key, { score: row.score, ts, seq, gradedBy });
				}
			} else {
				const s = meanAcc.get(key) ?? { sum: 0, count: 0, gradedBy: new Set<string>() };
				s.sum += row.score;
				s.count += 1;
				s.gradedBy.add(row.gradedBy ?? "unknown");
				meanAcc.set(key, s);
			}
		}
		if (runMatched) matchedRuns += 1;
	}
	const byCase = new Map<string, DigestCaseEntry>();
	if (merge === "latest") {
		for (const [key, l] of latestAcc) {
			byCase.set(key, { mean: l.score, gradedBy: l.gradedBy, count: 1, latestTs: l.ts || null, strategy: merge });
		}
	} else {
		for (const [key, s] of meanAcc) {
			byCase.set(key, { mean: s.sum / s.count, gradedBy: s.gradedBy, count: s.count, latestTs: null, strategy: merge });
		}
	}
	return { byCase, candidateCovered: byCase.size, matchedRuns };
}

export interface DigestSkillDelta extends SkillDelta {
	candidateGradedBy: string;
}

/**
 * Per-skill delta between a candidate digest (merged across runs) and a baseline
 * run, over cases BOTH sides scored. Reuses the apples-to-apples rule; adds
 * candidate gradedBy sources.
 */
export function aggregateSkillDeltaByDigest(digestScores: DigestCaseScores, baselineByCase: Map<string, BaselineByCaseEntry>): DigestSkillDelta[] {
	const acc = new Map<string, { count: number; sum: number; baseGradedBy: Set<string>; candGradedBy: Set<string> }>();
	for (const [key, c] of digestScores.byCase) {
		const base = baselineByCase.get(key);
		if (!base || typeof base.score !== "number") continue;
		const [skillId] = key.split("::");
		const s = acc.get(skillId) ?? { count: 0, sum: 0, baseGradedBy: new Set<string>(), candGradedBy: new Set<string>() };
		s.count += 1;
		s.sum += c.mean - base.score;
		s.baseGradedBy.add(base.gradedBy);
		for (const g of c.gradedBy) s.candGradedBy.add(g);
		acc.set(skillId, s);
	}
	const out: DigestSkillDelta[] = [];
	for (const [skillId, s] of acc) {
		out.push({
			skillId,
			comparedCases: s.count,
			meanDelta: s.sum / s.count,
			baselineGradedBy: [...s.baseGradedBy].sort().join("|"),
			candidateGradedBy: [...s.candGradedBy].sort().join("|"),
		});
	}
	return out.sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}
