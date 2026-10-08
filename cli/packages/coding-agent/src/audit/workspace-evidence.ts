/**
 * P1-02: seal the evidence a workspace verdict was computed from.
 *
 * A real agent run scores a temporary workspace that is deleted in `finally`,
 * so before this module existed a recorded score could not be re-derived: the
 * `output/` files the private verifier actually read were gone, and the
 * verifier definition lives in an operator-owned file outside the repository.
 * `artifacts.jsonl` keeps the model's final *text*, which is not the same thing
 * as the files that were graded.
 *
 * This module closes that gap:
 *
 *  - `captureWorkspaceEvidence` snapshots every regular file below the
 *    workspace's `output/` tree (content + sha256 + byte length) together with
 *    the verifier's literal bytes and the verdict that was recorded at run time.
 *  - `replayWorkspaceVerifier` rebuilds that `output/` tree in a fresh temp dir,
 *    re-loads the verifier from the archived bytes, re-runs the same
 *    deterministic verification, and reports whether the verdict reproduces.
 *
 * Honesty rules: nothing is guessed. A file that cannot be stored faithfully
 * (oversized, non-UTF-8, symlink, escaping path) is recorded in `omitted` with a
 * reason, and a replay whose restored tree does not cover a path the verifier
 * checks is reported as inconsistent rather than silently passing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFileSync } from "./atomic.ts";
import type { GradeSpec } from "./types.ts";
import { parseWorkspaceVerifier, verifyWorkspace, type WorkspaceVerifier } from "./workspace-verifier.ts";

export const WORKSPACE_EVIDENCE_SCHEMA = "ocsid.workspace-evidence.v1";
export const WORKSPACE_EVIDENCE_FILE = "workspace-evidence.json";
/** Per-file cap for a stored output file, matching the artifact archive cap. */
export const WORKSPACE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

/** One archived output file. `content` is the exact UTF-8 text that was hashed. */
export interface WorkspaceEvidenceFile {
	/** Workspace-relative POSIX path, always below `output/`. */
	path: string;
	sha256: string;
	bytes: number;
	content: string;
}

/** A file below `output/` that could not be archived faithfully, and why. */
export interface WorkspaceEvidenceOmission {
	path: string;
	reason: "oversized" | "not-utf8" | "symlink" | "not-a-file" | "unsafe-path";
	bytes?: number;
}

export interface WorkspaceEvidence {
	schema: typeof WORKSPACE_EVIDENCE_SCHEMA;
	capturedAt: string;
	runId: string;
	skillId: string;
	caseId: string;
	/** The verifier's literal text plus the digest that binds it. */
	verifier: { sha256: string; text: string };
	/** The verdict recorded at run time, reproduced by a faithful replay. */
	verdict: GradeSpec;
	files: WorkspaceEvidenceFile[];
	omitted: WorkspaceEvidenceOmission[];
	maxBytes: number;
}

export interface WorkspaceReplayResult {
	runId: string;
	skillId: string;
	caseId: string;
	verifierSha256: string;
	fileCount: number;
	omitted: WorkspaceEvidenceOmission[];
	/** Check paths the verifier reads that the archive did not restore. */
	uncoveredPaths: string[];
	recorded: GradeSpec;
	replayed: GradeSpec;
	/** True only when the restored tree covers every checked path and the verdict matches. */
	consistent: boolean;
	mismatches: string[];
}

function sha256Hex(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

/** Every regular file below `<workspaceRoot>/output`, depth-first, sorted. */
function walkOutputFiles(outputRoot: string): { relative: string; absolute: string }[] {
	const found: { relative: string; absolute: string }[] = [];
	const visit = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			found.push({ relative: path.relative(outputRoot, absolute).split(path.sep).join("/"), absolute });
		}
	};
	visit(outputRoot);
	return found;
}

/** A safe archive path: relative, POSIX, no empty/`.`/`..` segment, below output/. */
export function assertSafeOutputRelativePath(relative: string): void {
	if (relative.length === 0 || path.isAbsolute(relative) || relative.includes("\\")) {
		throw new Error(`workspace evidence path must be a relative POSIX path: ${relative}`);
	}
	const segments = relative.split("/");
	if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
		throw new Error(`workspace evidence path escapes output/: ${relative}`);
	}
	if (segments[0] !== "output") throw new Error(`workspace evidence path must be below output/: ${relative}`);
}

/**
 * Snapshot the graded `output/` tree plus the verifier and the recorded verdict.
 * Read-only with respect to the workspace: it never mutates or repairs what the
 * agent produced.
 */
export function captureWorkspaceEvidence(input: {
	workspaceRoot: string;
	runId: string;
	skillId: string;
	caseId: string;
	verifier: WorkspaceVerifier;
	verdict: GradeSpec;
	maxBytes?: number;
}): WorkspaceEvidence {
	const maxBytes = input.maxBytes ?? WORKSPACE_EVIDENCE_MAX_BYTES;
	const outputRoot = path.resolve(input.workspaceRoot, "output");
	const files: WorkspaceEvidenceFile[] = [];
	const omitted: WorkspaceEvidenceOmission[] = [];
	if (fs.existsSync(outputRoot) && fs.lstatSync(outputRoot).isDirectory()) {
		for (const entry of walkOutputFiles(outputRoot)) {
			const relative = `output/${entry.relative}`;
			const stat = fs.lstatSync(entry.absolute);
			if (stat.isSymbolicLink()) {
				omitted.push({ path: relative, reason: "symlink" });
				continue;
			}
			if (!stat.isFile()) {
				omitted.push({ path: relative, reason: "not-a-file" });
				continue;
			}
			try {
				assertSafeOutputRelativePath(relative);
			} catch {
				omitted.push({ path: relative, reason: "unsafe-path" });
				continue;
			}
			const raw = fs.readFileSync(entry.absolute);
			if (raw.byteLength > maxBytes) {
				omitted.push({ path: relative, reason: "oversized", bytes: raw.byteLength });
				continue;
			}
			const text = raw.toString("utf8");
			if (!Buffer.from(text, "utf8").equals(raw)) {
				// A lossy decode would let a replay grade different bytes than the run did.
				omitted.push({ path: relative, reason: "not-utf8", bytes: raw.byteLength });
				continue;
			}
			files.push({ path: relative, sha256: sha256Hex(raw), bytes: raw.byteLength, content: text });
		}
	}
	return {
		schema: WORKSPACE_EVIDENCE_SCHEMA,
		capturedAt: new Date().toISOString(),
		runId: input.runId,
		skillId: input.skillId,
		caseId: input.caseId,
		verifier: { sha256: input.verifier.sha256, text: verifierTextFor(input.verifier) },
		verdict: input.verdict,
		files,
		omitted,
		maxBytes,
	};
}

/**
 * The verifier's literal text. The archived binding is the text, so a parsed
 * verifier must carry it; `loadWorkspaceVerifier`/`parseWorkspaceVerifier` attach
 * it and `sha256` is always the digest of exactly this text.
 */
function verifierTextFor(verifier: WorkspaceVerifier): string {
	if (typeof verifier.text !== "string") {
		throw new Error("verifier text is unavailable; cannot bind an archived verifier");
	}
	return verifier.text;
}

export function workspaceEvidencePath(runDir: string): string {
	return path.join(runDir, WORKSPACE_EVIDENCE_FILE);
}

/** Write the evidence atomically into the audit run directory; returns its path. */
export function writeWorkspaceEvidence(runDir: string, evidence: WorkspaceEvidence): string {
	const target = workspaceEvidencePath(runDir);
	atomicWriteFileSync(target, JSON.stringify(evidence, null, 2) + "\n", "utf8");
	return target;
}

/** Read and shape-check archived evidence. Throws when it is absent or malformed. */
export function readWorkspaceEvidence(runDir: string): WorkspaceEvidence {
	const target = workspaceEvidencePath(runDir);
	if (!fs.existsSync(target)) {
		throw new Error(`no archived workspace evidence in ${runDir} (${WORKSPACE_EVIDENCE_FILE} is missing; the run predates P1-02 or graded no output files)`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(target, "utf8"));
	} catch (error) {
		throw new Error(`archived workspace evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const evidence = parsed as Partial<WorkspaceEvidence>;
	if (evidence.schema !== WORKSPACE_EVIDENCE_SCHEMA || !Array.isArray(evidence.files) || !evidence.verifier ||
		typeof evidence.verifier.sha256 !== "string" || typeof evidence.verifier.text !== "string" || !evidence.verdict) {
		throw new Error(`archived workspace evidence does not match ${WORKSPACE_EVIDENCE_SCHEMA}`);
	}
	return evidence as WorkspaceEvidence;
}

/** Check paths a verifier reads, so a replay can prove it restored all of them. */
function checkedPaths(verifier: WorkspaceVerifier): string[] {
	return [...new Set(verifier.checks.map((check) => check.path))];
}

/**
 * Re-run the archived verifier over the archived output files.
 *
 * The restored tree lives in a throwaway temp dir (deleted before returning), so
 * the original workspace staying deleted is exactly the case this proves.
 */
export function replayWorkspaceVerifier(runDir: string, options: { tmpRoot?: string } = {}): WorkspaceReplayResult {
	const evidence = readWorkspaceEvidence(runDir);
	const verifier = parseWorkspaceVerifier(evidence.verifier.text);
	if (verifier.sha256 !== evidence.verifier.sha256) {
		throw new Error(`archived verifier binding is broken: stored sha256 ${evidence.verifier.sha256} but its text hashes to ${verifier.sha256}`);
	}

	const root = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "ocsid-evidence-"));
	const mismatches: string[] = [];
	const restored = new Set<string>();
	try {
		for (const file of evidence.files) {
			assertSafeOutputRelativePath(file.path);
			const target = path.join(root, ...file.path.split("/"));
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, file.content, "utf8");
			restored.add(file.path);
			const actual = sha256Hex(Buffer.from(file.content, "utf8"));
			if (actual !== file.sha256) {
				mismatches.push(`archived file ${file.path} hashes to ${actual} but its record claims ${file.sha256}`);
			}
		}
		const uncoveredPaths = checkedPaths(verifier).filter((checked) => !restored.has(checked));
		const replayed = verifyWorkspace(root, verifier);
		if (JSON.stringify(replayed) !== JSON.stringify(evidence.verdict)) {
			mismatches.push("replayed verdict differs from the recorded verdict");
		}
		if (uncoveredPaths.length > 0) {
			mismatches.push(`archive does not restore checked path(s): ${uncoveredPaths.join(", ")}`);
		}
		return {
			runId: evidence.runId,
			skillId: evidence.skillId,
			caseId: evidence.caseId,
			verifierSha256: verifier.sha256,
			fileCount: evidence.files.length,
			omitted: evidence.omitted ?? [],
			uncoveredPaths,
			recorded: evidence.verdict,
			replayed,
			consistent: mismatches.length === 0 && uncoveredPaths.length === 0,
			mismatches,
		};
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}
