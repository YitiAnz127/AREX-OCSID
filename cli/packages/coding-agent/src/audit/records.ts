/**
 * Persistence for audit runs.
 *
 * Writes a completed audit run to the benchmark quality directory so the quality
 * ledger is materialized as real files (not just an in-memory result) and can be
 * re-inspected / compared across candidate runs.
 *
 * Honesty: every persisted run carries `kind: "baseline-plumbing"` unless a
 * caller explicitly supplies a real grading source. A "task_success_rate" from
 * the built-in deterministic baseline is a *pipeline round-trip value*, NOT a
 * claim about routing quality — the CLI and archive label it accordingly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import type { AuditRunResult } from "./runner.ts";
import { resolveRunDir } from "./id.ts";
import { atomicWriteFileSync } from "./atomic.ts";

export interface PersistOptions {
	/** Quality directory (e.g. getRsiBenchmarkDir()/quality). */
	qualityDir: string;
	/**
	 * Provenance label describing how the grades were produced. The safe default
	 * marks the run as deterministic plumbing, which is NOT a quality claim.
	 */
	kind?: string;
	/** Optional explicit non-claim note; default labels the run as baseline plumbing. */
	note?: string;
}

export interface PersistedAuditRun {
	dir: string;
	ledgerPath: string;
	summaryPath: string;
	artifactsPath: string;
	/** Path of the per-case tool-trajectory file (P0-2); always materialized. */
	tracesPath: string;
	runId: string;
}

/** Atomically write ledger JSONL + a summary manifest for a finished run. */
export function persistAuditRun(result: AuditRunResult, options: PersistOptions): PersistedAuditRun {
	const kind = options.kind ?? "baseline-plumbing";
	// BUG-P0-02: containment check before creating any directory.
	const dir = resolveRunDir(options.qualityDir, result.runId);
	fs.mkdirSync(dir, { recursive: true });
	const release = lockfile.lockSync(dir, { realpath: false });
	try {
		return persistAuditRunLocked(result, options, dir, kind);
	} finally {
		release();
	}
}

/**
 * Resolve a persisted run's directory from its runId (qualityDir/audit/<runId>).
 * Throws on a non-canonical id or an escaping path; does not require the run to
 * exist yet.
 */
export function resolveAuditRunDir(qualityDir: string, runId: string): string {
	return resolveRunDir(qualityDir, runId);
}

/**
 * Read the per-case artifact rows for a persisted run. Backward compatible: a
 * legacy run directory with no artifacts.jsonl returns an empty array rather
 * than throwing, so older persisted runs remain readable.
 */
export function readArtifacts(runDir: string): ArtifactRow[] {
	const artifactsPath = path.join(runDir, "artifacts.jsonl");
	if (!fs.existsSync(artifactsPath)) return [];
	const text = fs.readFileSync(artifactsPath, "utf8");
	const rows: ArtifactRow[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parsed = JSON.parse(trimmed) as ArtifactRow;
		rows.push(parsed);
	}
	return rows;
}

/**
 * Read the per-case tool-trajectory rows for a persisted run (P0-2). Backward
 * compatible: a legacy run directory with no traces.jsonl returns an empty array
 * rather than throwing.
 */
export function readTraces(runDir: string): TraceRow[] {
	const tracesPath = path.join(runDir, "traces.jsonl");
	if (!fs.existsSync(tracesPath)) return [];
	const text = fs.readFileSync(tracesPath, "utf8");
	const rows: TraceRow[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parsed = JSON.parse(trimmed) as TraceRow;
		rows.push(parsed);
	}
	return rows;
}

/** P0-1: protective upper bound (bytes) for a single stored artifact. */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** sha256 hex of a UTF-8 string (identical encoding to types.ts). */
function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A single artifact record persisted in artifacts.jsonl (P0-1). `artifact` is the
 * (possibly truncated) stored text; `artifactSha256` is the sha256 of the bytes
 * actually stored, `bytes` the stored byte lengtherialization, and `truncated`
 * marks an oversized artifact that was stored under the ARTIFACT_MAX_BYTES cap.
 */
export interface ArtifactRow {
	skillId: string;
	caseId: string;
	artifactSha256: string;
	bytes: number;
	artifact: string;
	/** True when `artifact` was truncated to fit the ARTIFACT_MAX_BYTES cap. */
	truncated?: boolean;
}

/**
 * P0-2: a per-case tool-trajectory record persisted in traces.jsonl. It makes
 * the score attributable to *how* the agent produced the artifact: how many
 * model rounds it took, how many tool calls were admitted, and the ordered
 * tool-call summary (name + compact args + admission status). Only written for
 * cases whose usage carried a toolTrace (i.e. a driver that used tools).
 */
export interface TraceRow {
	skillId: string;
	caseId: string;
	/** Total admitted+rejected tool invocations attempted by the driver (usage.toolCalls). */
	toolCalls: number;
	/** Agent turns (model calls) reported by the driver (usage.rounds). */
	rounds?: number;
	/** Ordered tool-call summary, in execution order. */
	trace: { name: string; status: "ok" | "error"; args?: string; detail?: string }[];
}

/**
 * Downscale `artifact` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character. Returns the kept text and the exact byte length written.
 */
function truncateArtifact(artifact: string, maxBytes: number): { text: string; bytes: number } {
	if (Buffer.byteLength(artifact, "utf8") <= maxBytes) return { text: artifact, bytes: Buffer.byteLength(artifact, "utf8") };
	let bytes = 0;
	let i = 0;
	for (; i < artifact.length; i += 1) {
		const cp = artifact.codePointAt(i)!;
		const len = Buffer.byteLength(String.fromCodePoint(cp), "utf8");
		if (bytes + len > maxBytes) break;
		bytes += len;
		i += cp > 0xffff ? 1 : 0; // surrogate pair takes two UTF-16 units
	}
	return { text: artifact.slice(0, i), bytes };
}

function persistAuditRunLocked(result: AuditRunResult, options: PersistOptions, dir: string, kind: string): PersistedAuditRun {
	const rows = result.cases.filter((c) => c.row).map((c) => c.row!);
	const ledgerPath = path.join(dir, "ledger.jsonl");
	const summaryPath = path.join(dir, "summary.json");
	const artifactsPath = path.join(dir, "artifacts.jsonl");
	const tracesPath = path.join(dir, "traces.jsonl");
	// A run ID identifies immutable evidence. Refuse even a partial previous
	// write so a re-run cannot erase later human grades or silently repair a
	// damaged audit record with unrelated evidence.
	if (fs.existsSync(ledgerPath) || fs.existsSync(summaryPath) || fs.existsSync(artifactsPath) || fs.existsSync(tracesPath)) {
		throw new Error(`audit run ${result.runId} already exists; choose a new runId`);
	}
	const ledger = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
	// Atomic write to avoid a torn file on concurrent readers; tmp name is
	// unique per write so concurrent writers cannot clobber each other (P1-xx
	// finding 3).
	atomicWriteFileSync(ledgerPath, ledger, "utf8");

	// P0-1: persist each case's artifact text so a score can be re-inspected on
	// the exact bytes that earned it (not just its digest). Only non-empty string
	// artifacts are written. Each row's artifactSha256 is the sha256 of the stored
	// bytes; for a full (non-truncated) artifact this equals the ledger row's
	// artifactSha256 (sha256 self-consistency). Oversized artifacts are truncated
	// to the ARTIFACT_MAX_BYTES cap and flagged `truncated: true`.
	const artifactRows: ArtifactRow[] = [];
	for (const c of result.cases) {
		const art = c.artifact;
		if (typeof art !== "string" || art.length === 0) continue;
		const fullSha256 = c.artifactSha256 ?? sha256Hex(art);
		const { text, bytes } = truncateArtifact(art, ARTIFACT_MAX_BYTES);
		const truncated = bytes < Buffer.byteLength(art, "utf8");
		artifactRows.push({
			skillId: c.case.skillId,
			caseId: c.case.caseId,
			// Non-truncated: reuse the ledger digest for exact self-consistency.
			// Truncated: hash the bytes actually stored (flagged so a reader knows
			// this digest is NOT the ledger's artifactSha256).
			artifactSha256: truncated ? sha256Hex(text) : fullSha256,
			bytes,
			artifact: text,
			...(truncated ? { truncated: true } : {}),
		});
	}
	if (artifactRows.length > 0) {
		const artifactsText = artifactRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
		atomicWriteFileSync(artifactsPath, artifactsText, "utf8");
	} else {
		// No artifacts to record still materializes the file so a reader can rely
		// on its presence; the file is the empty-string content.
		atomicWriteFileSync(artifactsPath, "", "utf8");
	}

	// P0-2: persist each case's tool trajectory so a score can be attributed to
	// the tool calls that produced it. Only written for cases that reported a
	// toolTrace. Always materialized (empty when none) so its presence is a
	// reliable invariant.
	const traceRows: TraceRow[] = [];
	for (const c of result.cases) {
		const usage = c.usage;
		const trace = usage?.toolTrace;
		if (!trace || trace.length === 0) continue;
		traceRows.push({
			skillId: c.case.skillId,
			caseId: c.case.caseId,
			toolCalls: typeof usage.toolCalls === "number" ? usage.toolCalls : trace.length,
			...(typeof usage.rounds === "number" ? { rounds: usage.rounds } : {}),
			trace: trace.map((t) => ({ name: t.name, status: t.status, ...(t.args !== undefined ? { args: t.args } : {}), ...(t.detail !== undefined ? { detail: t.detail } : {}) })),
		});
	}
	if (traceRows.length > 0) {
		atomicWriteFileSync(tracesPath, traceRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
	} else {
		atomicWriteFileSync(tracesPath, "", "utf8");
	}

	const summary = {
		...result.summary,
		runId: result.runId,
		kind,
		// Explicit non-claim: a baseline rate is plumbing, not routing quality.
		note: options.note ?? "baseline-plumbing: deterministic grader, no live agent/human judgement; NOT a routing quality result.",
		ledgerRowCount: rows.length,
		// P0-1: how many case artifacts were persisted under this run.
		artifactRowCount: artifactRows.length,
		// P0-2: how many case tool-trajectories were persisted under this run.
		traceRowCount: traceRows.length,
	};
	atomicWriteFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

	return { dir, ledgerPath, summaryPath, artifactsPath, tracesPath, runId: result.runId };
}
