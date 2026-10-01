/**
 * Read-only meta-audit (repo-skills audit-consistency).
 *
 * Checks that the RSI harness is internally consistent and still honours its
 * honesty rules, WITHOUT running the pipeline:
 *   1. proposal-no-live-apply  - Step 4 forbid live-tree application at the source
 *                                (evolution/types.ts + propose-only.ts must never
 *                                contain `appliedToLiveTree: true`).
 *   2. routing-honesty-label   - the CLI help / records must still carry the
 *                                "NOT a routing-quality" disclaimers.
 *   3. ledger-self-consistent  - every run's ledger row count matches its summary
 *                                and recorded scores stay in [0,1].
 *   4. archives-present        - docs/rsi/archive-v*.md all non-empty.
 *
 * This module REPORTS check results; it never claims the audited target is
 * "correct". It is itself read-only.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCandidateRunKind } from "../benchmark/schema.ts";

export interface ConsistencyCheck {
	name: string;
	pass: boolean;
	detail: string;
	/** "error" (default, counts toward failed) or "warning" (informational, never counts as a failure). */
	level?: "error" | "warning";
	/**
	 * BUG-P1-18: explicit four-state verdict. `"pass"` means at least one run was
	 * actually inspected and was consistent; `"fail"` means a real problem was
	 * found; `"skip"` (NO_DATA) means there was nothing to inspect (e.g. no audit
	 * dir), so the check neither proves correctness nor failing — it must NOT be
	 * reported as a PASS. Omitted ⇒ derived from `pass` (default `"pass"`/`"fail"`).
	 */
	status?: "pass" | "fail" | "skip";
}

export interface AuditConsistencyResult {
	checks: ConsistencyCheck[];
	passed: number;
	failed: number;
	warnings: number;
	/** BUG-P1-18: checks with NO_DATA (nothing to inspect) — neither pass nor fail. */
	skipped: number;
	/** issues regrouped per run (best-effort: run id parsed from detail's leading `<id>:` segment). */
	byRun: Record<string, { errors: string[]; warnings: string[]; checks: string[] }>;
	unassigned: { errors: string[]; warnings: string[]; checks: string[] };
}

// Detail notes follow `<runId>: <message>`; anchor on word/'.'/'-' before ': '.
const RUN_NOTE_RE = /^([A-Za-z0-9_.-]+):\s+(.*)$/;
// check details commonly prefix their first note with "N problem(s): " or "N note(s): "; strip for parsing.
const COUNT_PREFIX_RE = /^\d+\s+[a-z]+\(s\):\s*/;

export function summarizeIssues(checks: ConsistencyCheck[]): { byRun: Record<string, { errors: string[]; warnings: string[]; checks: string[] }>; unassigned: { errors: string[]; warnings: string[]; checks: string[] } } {
	const byRun: Record<string, { errors: string[]; warnings: string[]; checks: string[] }> = {};
	const unassigned: { errors: string[]; warnings: string[]; checks: string[] } = { errors: [], warnings: [], checks: [] };
	for (const c of checks) {
		if (c.pass && c.level !== "warning") continue; // only problems
		const isWarn = c.level === "warning";
		for (const raw of c.detail.split(";").map((s) => s.trim()).filter(Boolean)) {
			const note = raw.replace(COUNT_PREFIX_RE, "");
			const m = RUN_NOTE_RE.exec(note);
			const msg = m ? m[2] : note;
			const runId = m ? m[1] : "";
			const target = runId ? (byRun[runId] ??= { errors: [], warnings: [], checks: [] }) : unassigned;
			if (isWarn) target.warnings.push(msg);
			else target.errors.push(msg);
			if (!target.checks.includes(c.name)) target.checks.push(c.name);
		}
	}
	return { byRun, unassigned };
}

// Paths are resolved relative to this file. In the source tree HERE = src/evolution/
// and in the built bundle HERE = dist/evolution/ (same relative layout), so we probe
// both the .ts (source/vitest) and .js (build) forms of each companion file.
const HERE = path.dirname(fileURLToPath(import.meta.url));
function resolveCompanion(rel: readonly string[]): string {
	const base = path.join(HERE, ...rel);
	for (const ext of [".ts", ".js"]) {
		const candidate = `${base}${ext}`;
		if (existsSync(candidate)) return candidate;
	}
	return `${base}.ts`; // report missing (check will flag it) if neither exists
}
const SRC_TYPES = resolveCompanion(["types"]);
const SRC_PROPOSE = resolveCompanion(["propose-only"]);
const CLI_REPO_SKILLS = resolveCompanion(["..", "cli", "repo-skills"]);
const RECORDS = resolveCompanion(["..", "audit", "records"]);

/**
 * Locate the workspace root: walk up from this module until a package.json declaring
 * the `ocsid` bin is found (the cli package root), then return its parent (the repo
 * root that contains docs/rsi). Works for both source and built layouts.
 */
export function resolveRepoRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i += 1) {
		const pkg = path.join(dir, "package.json");
		if (existsSync(pkg)) {
			try {
				const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { bin?: Record<string, string> };
				if (parsed.bin && typeof parsed.bin.ocsid === "string") {
					return path.dirname(dir);
				}
			} catch {
				// keep walking
			}
		}
		const next = path.dirname(dir);
		if (next === dir) break;
		dir = next;
	}
	return path.resolve(process.cwd());
}

/** Default docs/rsi archive directory, rooted at the repo root regardless of cwd. */
export function resolveDocsRsiDefault(): string {
	return path.join(resolveRepoRoot(), "docs", "rsi");
}

function fileTextOrEmpty(p: string): string {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

export function checkNoLiveApply(name: string, filePaths: string[]): ConsistencyCheck {
	const hits: Array<{ f: string; line: string }> = [];
	for (const f of filePaths) {
		// A missing source CANNOT be inspected, so the invariant is not verified —
		// reporting pass here made a vanished safety file (rename, build-layout
		// change, partial publish) look like a clean audit on an error-level check.
		// checkRoutingHonestyLabel below already flags a missing file as a failure;
		// this now matches it.
		if (!existsSync(f)) {
			hits.push({ f, line: "MISSING (the no-live-apply invariant could not be verified)" });
			continue;
		}
		const lines = readFileSync(f, "utf8").split("\n");
		lines.forEach((line, i) => {
			if (/appliedToLiveTree\s*:\s*true/.test(line)) hits.push({ f, line: `${i + 1}: ${line.trim()}` });
		});
	}
	return {
		name,
		pass: hits.length === 0,
		detail: hits.length === 0 ? `no "appliedToLiveTree: true" in ${filePaths.map((f) => path.basename(f)).join(", ")}` : `found: ${hits.map((h) => `${h.f}:${h.line}`).join("; ")}`,
	};
}

function checkRoutingHonestyLabel(name: string, filePaths: string[]): ConsistencyCheck {
	const missing: string[] = [];
	for (const f of filePaths) {
		if (!existsSync(f)) {
			missing.push(`${path.basename(f)} (missing)`);
			continue;
		}
		const text = readFileSync(f, "utf8");
		if (!/NOT a routing[ -]quality/.test(text)) missing.push(path.basename(f));
	}
	return {
		name,
		pass: missing.length === 0,
		detail: missing.length === 0 ? "all inspected sources carry the NOT a routing-quality label" : `missing in: ${missing.join(", ")}`,
	};
}

function checkLedgerSelfConsistent(name: string, qualityDir: string): ConsistencyCheck {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { name, pass: false, status: "skip", level: "warning", detail: "no audit dir (NO_DATA — nothing to check)" };
	let checkedRuns = 0;
	const problems: string[] = [];
	for (const dir of readdirSync(auditRoot).sort()) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(summaryPath) || !existsSync(ledgerPath)) continue;
		let summary: { kind?: string; ledgerRowCount?: number };
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as typeof summary;
		} catch {
			continue;
		}
		checkedRuns += 1;
		const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
		if (typeof summary.ledgerRowCount === "number" && summary.ledgerRowCount !== lines.length) {
			problems.push(`${dir}: ledgerRowCount=${summary.ledgerRowCount} vs ${lines.length} rows`);
		}
		for (const line of lines) {
			try {
				const r = JSON.parse(line) as { score?: number | null };
				if (typeof r.score === "number" && !(r.score >= 0 && r.score <= 1)) {
					problems.push(`${dir}: score=${r.score} out of [0,1]`);
				}
			} catch {
				problems.push(`${dir}: malformed ledger line`);
			}
		}
	}
	const seen = problems.slice(0, 8).join("; ");
	return {
		name,
		pass: problems.length === 0,
		detail: problems.length === 0 ? `${checkedRuns} run(s) self-consistent` : `${problems.length} problem(s): ${seen}${problems.length > 8 ? " …" : ""}`,
	};
}

function checkArchivesPresent(name: string, docsRsiDir: string): ConsistencyCheck {
	if (!existsSync(docsRsiDir)) return { name, pass: false, detail: `docs/rsi dir missing at ${docsRsiDir}` };
	const files = readdirSync(docsRsiDir).filter((f) => /^archive-v\d+(?:-[\w-]+)?\.md$/.test(f)).sort();
	const empty = files.filter((f) => readFileSync(path.join(docsRsiDir, f), "utf8").trim().length === 0);
	return {
		name,
		pass: empty.length === 0 && files.length > 0,
		detail: `${files.length} archive file(s); empty: ${empty.length ? empty.join(",") : "none"}`,
	};
}

const SHORT_DIGEST_RE = /^[0-9a-fA-F]{8,64}$/;

function checkRunDigestUnique(name: string, qualityDir: string): ConsistencyCheck {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { name, pass: false, status: "skip", level: "warning", detail: "no audit dir (NO_DATA — nothing to check)" };
	let checkedRuns = 0;
	const problems: string[] = [];
	for (const dir of readdirSync(auditRoot).sort()) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(summaryPath) || !existsSync(ledgerPath)) continue;
		let summary: { kind?: string };
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as typeof summary;
		} catch {
			continue;
		}
		if (!isCandidateRunKind(summary.kind)) continue; // every candidate run must carry one digest
		checkedRuns += 1;
		const digests = new Set<string>();
		let sawNull = false;
		for (const line of readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)) {
			try {
				const r = JSON.parse(line) as { candidateSha256?: string | null };
				if (r.candidateSha256 === null || r.candidateSha256 === undefined) sawNull = true;
				else digests.add(r.candidateSha256);
			} catch {
				// handled by ledger-self-consistent; skip here
			}
		}
		if (sawNull) problems.push(`${dir}: candidate-eval row has null/undefined digest`);
		// one candidate-eval run should evidence exactly one candidate digest
		if (digests.size > 1) problems.push(`${dir}: ${digests.size} distinct candidate digests in one candidate-eval run`);
	}
	const seen = problems.slice(0, 8).join("; ");
	return {
		name,
		pass: problems.length === 0,
		detail: problems.length === 0 ? `${checkedRuns} candidate-eval run(s) carry a single digest` : `${problems.length} problem(s): ${seen}${problems.length > 8 ? " …" : ""}`,
	};
}

function checkDigestWellformed(name: string, qualityDir: string): ConsistencyCheck {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { name, pass: false, status: "skip", level: "warning", detail: "no audit dir (NO_DATA — nothing to check)" };
	let checkedRows = 0;
	const problems: string[] = [];
	for (const dir of readdirSync(auditRoot).sort()) {
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(ledgerPath)) continue;
		for (const line of readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)) {
			try {
				const r = JSON.parse(line) as { candidateSha256?: string | null };
				if (r.candidateSha256 === null || r.candidateSha256 === undefined) continue; // baseline/null rows exempt
				checkedRows += 1;
				if (!SHORT_DIGEST_RE.test(r.candidateSha256)) {
					problems.push(`${dir}: malformed digest "${String(r.candidateSha256).slice(0, 20)}"`);
				}
			} catch {
				// handled by ledger-self-consistent
			}
		}
	}
	const seen = problems.slice(0, 8).join("; ");
	return {
		name,
		pass: problems.length === 0,
		detail: problems.length === 0 ? `${checkedRows} digest row(s) well-formed (8-64 hex)` : `${problems.length} problem(s): ${seen}${problems.length > 8 ? " …" : ""}`,
	};
}

function checkSummaryLedgerConsistency(name: string, qualityDir: string): ConsistencyCheck {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { name, pass: false, status: "skip", level: "warning", detail: "no audit dir (NO_DATA — nothing to check)" };
	let checkedRuns = 0;
	const problems: string[] = [];
	for (const dir of readdirSync(auditRoot).sort()) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(summaryPath) || !existsSync(ledgerPath)) continue;
		let summary: { kind?: string };
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as typeof summary;
		} catch {
			continue;
		}
		if (!isCandidateRunKind(summary.kind) && summary.kind !== "baseline-plumbing") continue; // only judge known comparison semantics
		checkedRuns += 1;
		let digestCount = 0;
		let nullCount = 0;
		for (const line of readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)) {
			try {
				const r = JSON.parse(line) as { candidateSha256?: string | null };
				if (r.candidateSha256 === null || r.candidateSha256 === undefined) nullCount += 1;
				else digestCount += 1;
			} catch {
				// handled by ledger-self-consistent
			}
		}
		if (isCandidateRunKind(summary.kind) && digestCount === 0) {
			problems.push(`${dir}: candidate-eval run has NO candidate digest rows (all null/absent)`);
		}
		if (summary.kind === "baseline-plumbing" && digestCount > 0) {
			problems.push(`${dir}: baseline-plumbing run carries ${digestCount} candidate digest row(s)`);
		}
	}
	const seen = problems.slice(0, 8).join("; ");
	return {
		name,
		pass: problems.length === 0,
		detail: problems.length === 0 ? `${checkedRuns} known-kind run(s) consistent with their ledger` : `${problems.length} problem(s): ${seen}${problems.length > 8 ? " …" : ""}`,
	};
}

function checkSummaryRateVsLedgerMean(name: string, qualityDir: string): ConsistencyCheck {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { name, pass: false, status: "skip", level: "warning", detail: "no audit dir (NO_DATA — nothing to check)" };
	const notes: string[] = [];
	for (const dir of readdirSync(auditRoot).sort()) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(summaryPath) || !existsSync(ledgerPath)) continue;
		let summary: { taskSuccessRate?: number | null };
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as typeof summary;
		} catch {
			continue;
		}
		if (typeof summary.taskSuccessRate !== "number") continue; // nothing to compare
		let sum = 0;
		let n = 0;
		for (const line of readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)) {
			try {
				const r = JSON.parse(line) as { score?: number | null };
				if (typeof r.score === "number") {
					sum += r.score;
					n += 1;
				}
			} catch {
				// handled elsewhere
			}
		}
		if (n === 0) continue;
		const mean = sum / n;
		if (Math.abs(mean - summary.taskSuccessRate) > 0.05) {
			notes.push(`${dir}: summary.taskSuccessRate=${summary.taskSuccessRate.toFixed(2)} vs ledger mean=${mean.toFixed(2)} (sources may differ; informational)`);
		}
	}
	return {
		name,
		pass: true, // always pass: informational only, scores may come from different graders
		level: "warning",
		detail: notes.length === 0 ? "summary rates align with ledger means within tolerance" : `${notes.length} note(s): ${notes.slice(0, 6).join("; ")}${notes.length > 6 ? " …" : ""}`,
	};
}

function checkSummaryFieldsPresent(name: string, qualityDir: string): ConsistencyCheck {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { name, pass: false, status: "skip", level: "warning", detail: "no audit dir (NO_DATA — nothing to check)" };
	const errors: string[] = [];
	const warnings: string[] = [];
	for (const dir of readdirSync(auditRoot).sort()) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		const ledgerPath = path.join(auditRoot, dir, "ledger.jsonl");
		if (!existsSync(ledgerPath)) continue;
		if (!existsSync(summaryPath)) {
			errors.push(`${dir}: ledger present but summary.json missing`);
			continue;
		}
		let summary: { runId?: unknown; kind?: unknown; ledgerRowCount?: number };
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as typeof summary;
		} catch {
			errors.push(`${dir}: summary.json unparseable`);
			continue;
		}
		if (typeof summary.runId !== "string" || summary.runId.length === 0) errors.push(`${dir}: summary missing runId`);
		if (typeof summary.kind !== "string" || summary.kind.length === 0) errors.push(`${dir}: summary missing kind`);
		if (typeof summary.ledgerRowCount !== "number") warnings.push(`${dir}: summary missing ledgerRowCount (informational)`);
	}
	const errDetail = errors.slice(0, 6).join("; ");
	return {
		name,
		pass: errors.length === 0,
		detail: `${errors.length} error(s): ${errDetail || "none"}${errors.length > 6 ? " …" : ""}; ${warnings.length} info: ${warnings.slice(0, 6).join("; ") || "none"}`,
	};
}

function checkRunDirMatchesRunId(name: string, qualityDir: string): ConsistencyCheck {
	const auditRoot = path.join(qualityDir, "audit");
	if (!existsSync(auditRoot)) return { name, pass: false, status: "skip", level: "warning", detail: "no audit dir (NO_DATA — nothing to check)" };
	const problems: string[] = [];
	let checked = 0;
	for (const dir of readdirSync(auditRoot).sort()) {
		const summaryPath = path.join(auditRoot, dir, "summary.json");
		if (!existsSync(summaryPath)) continue; // identity/absence handled by summary-fields-present
		let summary: { runId?: unknown };
		try {
			summary = JSON.parse(readFileSync(summaryPath, "utf8")) as typeof summary;
		} catch {
			continue;
		}
		if (typeof summary.runId !== "string" || summary.runId.length === 0) continue; // missing runId handled separately
		checked += 1;
		if (summary.runId !== dir) problems.push(`${dir}: summary.runId="${summary.runId}" != directory name "${dir}"`);
	}
	const seen = problems.slice(0, 8).join("; ");
	return {
		name,
		pass: problems.length === 0,
		detail: problems.length === 0 ? `${checked} run(s) have runId matching their directory name` : `${problems.length} problem(s): ${seen}${problems.length > 8 ? " …" : ""}`,
	};
}

export function auditConsistency(opts: { qualityDir: string; docsRsiDir: string }): AuditConsistencyResult {
	const checks: ConsistencyCheck[] = [
		checkNoLiveApply("proposal-no-live-apply", [SRC_TYPES, SRC_PROPOSE]),
		checkRoutingHonestyLabel("routing-honesty-label", [CLI_REPO_SKILLS, RECORDS]),
		checkLedgerSelfConsistent("ledger-self-consistent", opts.qualityDir),
		checkArchivesPresent("archives-present", opts.docsRsiDir),
		checkSummaryFieldsPresent("summary-fields-present", opts.qualityDir),
		checkRunDirMatchesRunId("run-dir-matches-runid", opts.qualityDir),
		checkRunDigestUnique("run-single-digest", opts.qualityDir),
		checkDigestWellformed("digest-wellformed", opts.qualityDir),
		checkSummaryLedgerConsistency("summary-ledger-consistency", opts.qualityDir),
		checkSummaryRateVsLedgerMean("summary-rate-vs-ledger-mean", opts.qualityDir),
	];
	const skips = checks.filter((c) => c.status === "skip").length;
	const failed = checks.filter((c) => c.status !== "skip" && !c.pass).length;
	const warnings = checks.filter((c) => c.status !== "skip" && c.pass && c.level === "warning").length;
	const { byRun, unassigned } = summarizeIssues(checks);
	return { checks, passed: checks.length - skips - failed, failed, warnings, skipped: skips, byRun, unassigned };
}
