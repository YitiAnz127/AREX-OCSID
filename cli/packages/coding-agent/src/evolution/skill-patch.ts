/**
 * C1 (P1) — Candidate as a verifiable skill patch, not opaque text.
 *
 * Today a candidate is a text string hashed into `candidateSha256`; the family's
 * "text" is not the skill-tree content. There is no reviewable
 * "parent -> change -> child" chain. This module makes a candidate a verified
 * PATCH against one parent skill tree, recorded in a candidate manifest with:
 *
 *   candidateId / parentSkillDigest / patchDigest / targetSkillId / author / reason
 *
 * Guarantees (from the stage-C spec):
 *  - The same patch applied to the same parent yields the same result digest
 *    (deterministic; op order is part of the identity).
 *  - Applying a patch whose parent no longer matches is refused (no blind
 *    reuse of a stale patch over a changed parent).
 *  - A patch may only touch the allowed skill subtree; every operation is
 *    validated (path-escape, symlink, file-size, executable-script) inside an
 *    isolated STAGING tree before anything is written to the live tree.
 *  - The candidate digest covers the WHOLE candidate skill tree at eval time
 *    (not just a description string), so the traceable content equals what was
 *    scored. The frozen eval corpus (test-cases/) is EXCLUDED from the patch
 *    surface and from the content digest, so a candidate can never alter the
 *    graded set — candidates act on the skill definition, not the benchmark.
 *  - Failed and rejected candidates are RETAINED (append-only history), never
 *    deleted, to preserve the exploration record.
 *  - Genealogy is a DAG over parent content hashes; duplicate parents and
 *    cycles are detected.
 *
 * This module is pure and side-effect-free (all helpers take explicit roots),
 * so it is unit-testable without touching the live skill library.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isWithin } from "../audit/id.ts";

/** A single ordered file operation in a candidate patch. */
export type PatchOp =
	| { kind: "write"; path: string; content: string }
	| { kind: "delete"; path: string };

/** Canonical patch: insertions/deletions are already ordered; others rejected */
export interface SkillPatch {
	/** Deterministic sha256 over the canonical patch encoding. */
	patchDigest: string;
	/** Operations, in application order. */
	ops: PatchOp[];
}

/**
 * Canonical encoding for a patch. Every op serialises with its kind first then
 * its slashed path, so a write and a delete cannot collide and ordering is
 * explicit. The digest is stable across platforms.
 */
export function encodePatch(ops: PatchOp[]): string {
	const lines = ops.map((op) => {
		const p = op.path.split(path.sep).join("/");
		if (op.kind === "write") {
			return `write\t${p}\t${op.content.length}\n${op.content}`;
		}
		return `delete\t${p}\n`;
	});
	return lines.join("\n") + "\n";
}

export function patchDigest(ops: PatchOp[]): string {
	return createHash("sha256").update(encodePatch(ops), "utf8").digest("hex");
}

export function makePatch(ops: PatchOp[]): SkillPatch {
	return { patchDigest: patchDigest(ops), ops };
}

/** Sanitisation/validation config. */
export interface PatchPolicy {
	/** Max bytes of a single written file. */
	maxFileBytes: number;
	/** True to reject a written file that is an executable script (shebang). */
	rejectExecutableScripts: boolean;
	/** Max number of ops. */
	maxOps: number;
}

export const DEFAULT_PATCH_POLICY: PatchPolicy = {
	maxFileBytes: 128 * 1024,
	rejectExecutableScripts: true,
	maxOps: 256,
};

export interface PatchViolation {
	opIndex: number;
	reason: string;
}

/**
 * Validate a patch against a skill subtree WITHOUT touching the disk yet.
 * `allowedRoot` is the absolute skill-tree root the patch may touch.
 *
 * Checks: every target path stays inside allowedRoot, no symlink in any newly
 * written parent dir, file-size caps, and (optionally) executable scripts.
 * Returns the violations; an empty list means "safe to stage".
 */
export function validatePatch(ops: PatchOp[], allowedRoot: string, policy: PatchPolicy = DEFAULT_PATCH_POLICY): PatchViolation[] {
	const root = path.resolve(allowedRoot);
	const violations: PatchViolation[] = [];
	if (ops.length > policy.maxOps) {
		violations.push({ opIndex: -1, reason: `patch exceeds maxOps ${policy.maxOps}` });
	}
	for (let i = 0; i < ops.length; i += 1) {
		const op = ops[i];
		const abs = path.resolve(root, op.path);
		const rel = path.relative(root, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			violations.push({ opIndex: i, reason: `path escapes the skill subtree: ${op.path}` });
			continue;
		}
		if (op.kind === "write") {
			const bytes = Buffer.byteLength(op.content, "utf8");
			if (bytes > policy.maxFileBytes) {
				violations.push({ opIndex: i, reason: `file exceeds ${policy.maxFileBytes} bytes: ${op.path}` });
			}
			if (policy.rejectExecutableScripts && /^#!/.test(op.content)) {
				violations.push({ opIndex: i, reason: `executable script rejected: ${op.path}` });
			}
		}
	}
	return violations;
}

/** True when `p` exists AND is a symbolic link. Never follows the link. */
function isSymlink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false; // does not exist -> there is no link to follow
	}
}

function dirSafe(root: string, fileAbs: string): boolean {
	const dir = path.dirname(fileAbs);
	// Walk up from the file's parent dir to the root; reject if any EXISTING level
	// is a symlink. A level that does not exist cannot be a symlink and the caller
	// mkdirs it immediately afterwards — treating ENOENT as unsafe made every op
	// that creates a new subdirectory fail with a bogus "writes through a symlink".
	let cur = dir;
	while (cur !== path.dirname(root) && !path.relative(root, cur).startsWith("..")) {
		try {
			if (fs.lstatSync(cur).isSymbolicLink()) return false;
		} catch {
			// ENOENT (or unreadable): nothing to follow here; keep walking up.
		}
		if (cur === root) break;
		cur = path.dirname(cur);
	}
	return true;
}

/**
 * Apply a validated patch into an isolated STAGING directory. `stagingRoot`
 * begins as an empty (or freshly copied parent) dir; ops are applied inside it.
 *
 * The subtree checks (address of writes under the allowed subtree, symlink
 * rejection) run against `stagingRoot` itself. Returns the list of files written
 * so callers can compute the whole-tree digest after application.
 */
export function applyPatchToStaging(ops: PatchOp[], stagingRoot: string, policy: PatchPolicy = DEFAULT_PATCH_POLICY): string[] {
	const root = path.resolve(stagingRoot);
	fs.mkdirSync(root, { recursive: true });
	const written: string[] = [];
	for (let i = 0; i < ops.length; i += 1) {
		const op = ops[i];
		const abs = path.resolve(root, op.path);
		const rel = path.relative(root, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`patch op ${i} escapes the skill subtree: ${op.path}`);
		}
		if (op.kind === "delete") {
			// The delete branch needs the same symlink guard as the write branch: a
			// parent symlink (`link -> /outside`) makes rmSync resolve through it and
			// delete a real file outside the staging tree. It previously had none.
			if (!dirSafe(root, abs) || isSymlink(abs)) {
				throw new Error(`patch op ${i} deletes through a symlink: ${op.path}`);
			}
			if (fs.existsSync(abs)) {
				fs.rmSync(abs, { force: true, recursive: true });
			}
			continue;
		}
		// dirSafe covers the ancestor DIRECTORIES; the target FILE can itself be a
		// symlink to a file outside the tree, which writeFileSync would follow.
		if (!dirSafe(root, abs) || isSymlink(abs)) {
			throw new Error(`patch op ${i} writes through a symlink: ${op.path}`);
		}
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, op.content, "utf8");
		written.push(path.relative(root, abs).split(path.sep).join("/"));
	}
	return written;
}

/**
 * Whole-skill-tree content digest. Walks every regular file under the skill
 * tree EXCLUDING `test-cases/` (the frozen eval corpus a candidate must not
 * touch), sorting paths for stability. Symlinks and non-file entries are a
 * violation (the tree must be clean and portable).
 *
 * Returns sha256 hex. The digest binds each file's slashed relative path with
 * its byte content, so any content or layout change alters the digest.
 */
export function skillTreeDigest(skillRoot: string): string {
	const root = path.resolve(skillRoot);
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`skill tree contains a symlink: ${path.relative(root, full)}`);
			if (entry.isDirectory()) {
				const rel = path.relative(root, full).split(path.sep).join("/");
				if (rel === "test-cases") continue; // frozen eval corpus is out of the candidate surface
				walk(full);
			} else if (entry.isFile()) {
				const rel = path.relative(root, full).split(path.sep).join("/");
				lines.push(`${rel}\t${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
			} else {
				throw new Error(`skill tree contains a non-file entry: ${path.relative(root, full)}`);
			}
		}
	};
	walk(root);
	lines.sort();
	return createHash("sha256").update(lines.join("\n") + "\n", "utf8").digest("hex");
}

/** Candidate manifest (C1). Immutable once written. */
export interface CandidateManifest {
	enc: "ocsid.candidate-manifest.v1";
	candidateId: string;
	targetSkillId: string;
	/** sha256 of the whole parent skill tree the patch was based on. */
	parentSkillDigest: string;
	/** sha256 of the canonical patch (see patchDigest). */
	patchDigest: string;
	/** sha256 of the whole tree AFTER the patch is applied (the scored content). */
	resultSkillDigest: string;
	/** Human/agent attribution. */
	author: string;
	/** Free-form reason for the change. */
	reason: string;
	/** ISO timestamp. */
	createdAt: string;
}

/**
 * Deterministically derive a candidate id from the patch + parent digest so the
 * same (parent, patch) always yields the same id (idempotency + duplicate
 * detection are trivial).
 */
export function candidateIdFor(parentSkillDigest: string, patchDigest: string): string {
	return createHash("sha256").update(`${parentSkillDigest}\t${patchDigest}`, "utf8").digest("hex");
}

/**
 * Apply a patch to a COPY of the parent skill tree and compute the resulting
 * whole-tree digest, WITHOUT mutating the live tree. Returns both the staged
 * (already-applied) tree root name and the resulting digest.
 *
 * - Refuses when `parentSkillDigest` does not match `skillTreeDigest(parentRoot)`
 *   (stale patch over a changed parent).
 * - Validates the patch before staging; throws on any violation.
 */
export function applyPatchToTree(
	parentRoot: string,
	ops: PatchOp[],
	expectedParentDigest: string,
	stagingDir: string,
	policy: PatchPolicy = DEFAULT_PATCH_POLICY,
): { stagedRoot: string; resultSkillDigest: string } {
	const parent = path.resolve(parentRoot);
	if (!fs.existsSync(path.join(parent))) throw new Error(`parent skill tree not found: ${parentRoot}`);
	const actualParent = skillTreeDigest(parent);
	if (actualParent !== expectedParentDigest) {
		throw new Error(`parent skill tree changed: expected ${expectedParentDigest.slice(0, 12)}… got ${actualParent.slice(0, 12)}…; refusing to apply a stale patch`);
	}
	const viol = validatePatch(ops, parent, policy);
	if (viol.length > 0) {
		throw new Error(`patch rejected: ${viol.map((v) => v.reason).join("; ")}`);
	}
	// Copy the parent into staging (excluding test-cases — candidates may not
	// touch the eval corpus), then apply ops on top.
	//
	// Staging MUST be a genuinely separate tree. This is the guard that makes the
	// "without mutating the live tree" contract above true rather than aspirational
	// — it is reachable from the user-facing `--staging-dir` flag:
	//   - dest === parent: copyTreeContents copies the tree onto itself and
	//     applyPatchToStaging then rewrites the LIVE skill in place, while the
	//     manifest still records the pre-mutation parentSkillDigest, so the record
	//     looks self-consistent after the live tree has been silently replaced.
	//   - dest inside parent (e.g. <skill>/stage): copyTreeContents re-lists the
	//     directory it is creating, recursing as stage/stage/stage/… until the
	//     disk fills.
	// Both directions are rejected: neither may contain the other.
	const dest = path.resolve(stagingDir);
	if (isWithin(parent, dest) || isWithin(dest, parent)) {
		throw new Error(
			`staging dir must be outside the skill tree: "${path.basename(dest)}" is not separate from "${path.basename(parent)}"`,
		);
	}
	fs.mkdirSync(dest, { recursive: true });
	copyTreeContents(parent, dest);
	applyPatchToStaging(ops, dest, policy);
	const digest = skillTreeDigest(dest);
	return { stagedRoot: dest, resultSkillDigest: digest };
}

function copyTreeContents(src: string, dest: string): void {
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`skill tree contains a symlink: ${entry.name}`);
		if (entry.isDirectory()) {
			const rel = path.relative(src, s).split(path.sep).join("/");
			if (rel === "test-cases") continue; // never stage the eval corpus
			const d = path.join(dest, entry.name);
			// `src` is checked for symlinks, but a pre-existing symlink in the
			// DESTINATION would be written through (mkdirSync no-ops on a symlink to
			// a directory) — reachable when --staging-dir names a prepared directory.
			if (isSymlink(d)) throw new Error(`staging destination contains a symlink: ${entry.name}`);
			fs.mkdirSync(d, { recursive: true });
			copyTreeContents(s, d);
		} else if (entry.isFile()) {
			const d = path.join(dest, entry.name);
			if (isSymlink(d)) throw new Error(`staging destination contains a symlink: ${entry.name}`);
			fs.copyFileSync(s, d);
		} else {
			throw new Error(`skill tree contains a non-file entry: ${entry.name}`);
		}
	}
}

/** Build a complete candidate manifest after a successful staged apply. */
export function buildManifest(opts: {
	candidateId?: string;
	targetSkillId: string;
	parentSkillDigest: string;
	patchDigest: string;
	resultSkillDigest: string;
	author: string;
	reason: string;
	createdAt?: string;
}): CandidateManifest {
	const id = opts.candidateId ?? candidateIdFor(opts.parentSkillDigest, opts.patchDigest);
	return {
		enc: "ocsid.candidate-manifest.v1",
		candidateId: id,
		targetSkillId: opts.targetSkillId,
		parentSkillDigest: opts.parentSkillDigest,
		patchDigest: opts.patchDigest,
		resultSkillDigest: opts.resultSkillDigest,
		author: opts.author,
		reason: opts.reason,
		createdAt: opts.createdAt ?? new Date().toISOString(),
	};
}

export interface GenealogyNode {
	candidateId: string;
	parentSkillDigest: string;
	resultSkillDigest: string;
}

/**
 * Genealogy: build a DAG over candidate manifests by parent content digest.
 * Detects (a) duplicate candidates (same candidateId already present) and
 * (b) cycles in the parent→result edge set.
 *
 * `edges` maps a result digest → the parent digest it was derived from. A DAG
 * is valid iff it has no back-edge; a cycle means a candidate claims to derive
 * from its own descendant.
 */
export function validateGenealogy(edges: ReadonlyArray<GenealogyNode>): { duplicateIds: string[]; cycles: string[][] } {
	const seen = new Map<string, number>();
	const duplicateIds: string[] = [];
	for (const n of edges) {
		const prev = seen.get(n.candidateId);
		if (prev !== undefined) duplicateIds.push(n.candidateId);
		seen.set(n.candidateId, (prev ?? 0) + 1);
	}
	// Build adjacency: parent digest -> result digests; then look for a cycle.
	const adj = new Map<string, string[]>();
	for (const n of edges) {
		if (!adj.has(n.parentSkillDigest)) adj.set(n.parentSkillDigest, []);
		adj.get(n.parentSkillDigest)!.push(n.resultSkillDigest);
	}
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map<string, number>();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const visit = (d: string): void => {
		color.set(d, GRAY);
		stack.push(d);
		for (const next of adj.get(d) ?? []) {
			const c = color.get(next) ?? WHITE;
			if (c === GRAY) {
				const idx = stack.indexOf(next);
				cycles.push([...stack.slice(idx), next]);
			} else if (c === WHITE) {
				visit(next);
			}
		}
		stack.pop();
		color.set(d, BLACK);
	};
	for (const d of adj.keys()) {
		if ((color.get(d) ?? WHITE) === WHITE) visit(d);
	}
	return { duplicateIds: [...new Set(duplicateIds)], cycles };
}
