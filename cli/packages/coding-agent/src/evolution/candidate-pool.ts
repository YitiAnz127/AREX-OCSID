/**
 * Candidate pooling - read already-recorded text-proxy and skill-snapshot
 * candidate runs from the quality
 * directory and aggregate them for comparison WITHOUT re-running.
 *
 * Purpose: once real-model (or any) candidate evals are recorded as
 * candidate ledgers, this module reads them back and lists them by
 * family run-id so results can be compared across candidates / across rounds.
 *
 * Honesty: this ONLY reads recorded values (candidateSha256, task_success_rate,
 * caseCount, gradedBy) from existing runs. It manufactures nothing - no
 * re-grading, no new claims beyond what the original run recorded.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { AuditRunSummary } from "../audit/runner.ts";
import type { QualityLedgerRow } from "../benchmark/schema.ts";

export interface RecordedRun {
	runId: string;
	kind: string;
	candidateSha256: string | null;
	taskSuccessRate: number | null;
	/** Number of cases the run scored; null when the summary omits/mangles it (a
	 *  corrupt/older summary must not surface as "0 cases" — that looks like a
	 *  real empty run and could mislead a downstream comparator). */
	caseCount: number | null;
	gradedBy: string | null;
}

interface SummaryFile extends AuditRunSummary {
	runId: string;
	kind: string;
	note?: string;
	ledgerRowCount?: number;
}

// Scan qualityDir/audit/*/summary.json for recorded candidate runs.
export function listCandidateRuns(qualityDir: string, opts: { includeKind?: string[] } = {}): RecordedRun[] {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return [];
	const allowed = opts.includeKind ?? ["candidate-eval", "candidate-agent-eval"];
	const out: RecordedRun[] = [];
	for (const dir of readdirSync(auditRoot)) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		if (!existsSync(summaryPath)) continue;
		let summary: SummaryFile;
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryFile;
		} catch {
			continue;
		}
		if (!allowed.includes(summary.kind)) continue;
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		let candidateSha256: string | null = null;
		// BUG-P1-12: do not trust the ledger's FIRST row for provenance. A run's
		// digest/grader can differ across rows, so scan ALL rows: take the first
		// non-null digest and the UNION of every distinct gradedBy source.
		const gradedBySet = new Set<string>();
		if (existsSync(ledgerPath)) {
			for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const row = JSON.parse(trimmed) as Partial<QualityLedgerRow>;
					if (candidateSha256 === null && row.candidateSha256) candidateSha256 = row.candidateSha256;
					if (row.gradedBy) gradedBySet.add(row.gradedBy);
				} catch {
					// ignore malformed row
				}
			}
		}
		const gradedBy = gradedBySet.size > 0 ? [...gradedBySet].sort().join(",") : null;
		out.push({
			runId: summary.runId,
			kind: summary.kind,
			candidateSha256,
			taskSuccessRate: summary.taskSuccessRate ?? null,
			caseCount: typeof summary.caseCount === "number" ? summary.caseCount : null,
			gradedBy,
		});
	}
	out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
	return out;
}

/** Group pooled runs by family run-id prefix (candidate runId is "<family>-<candidateId>"). */
export function poolByFamily(runs: RecordedRun[], familyRunId: string): RecordedRun[] {
	const prefix = `${familyRunId}-`;
	return runs.filter((r) => r.runId.startsWith(prefix)).sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}
