/**
 * Canonical ID validation + path containment for RSI quality/audit artifacts.
 *
 * BUG-P0-02: runId / candidateId / skillId are user-supplied strings
 * that previously flowed directly into `path.join(..., runId)`, letting `..`,
 * absolute paths, Windows drive letters and UNC paths escape the quality root.
 * This module is the single choke point every CLI and library entry must use so
 * IDs are constrained to a canonical form AND resolved paths are verified to
 * stay inside the quality directory.
 */

import * as path from "node:path";
import * as fs from "node:fs";

/** Max length for any canonical component id. */
export const MAX_ID_LEN = 128;

/**
 * Canonical id shape: starts with an alphanumeric, then only
 * `[A-Za-z0-9._-]`, at most 127 more chars. Rejects `..`, absolute/UNC/drive
 * prefixes, separators, whitespace and other path metacharacters.
 */
export const CANONICAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Validate an unknown value as a canonical filesystem component id (runId,
 * candidateId, skillId). Case ids use a separate, slash-delimited format.
 */
export function validateId(value: unknown, label: string): string | null {
	if (typeof value !== "string" || value.length === 0) {
		return `${label} must be a non-empty string`;
	}
	if (value.length > MAX_ID_LEN) {
		return `${label} must be at most ${MAX_ID_LEN} characters`;
	}
	if (!CANONICAL_ID_RE.test(value)) {
		return `${label} "${value}" is not a valid id: it must start with an alphanumeric and contain only [A-Za-z0-9._-] (no path separators, "..", or drive/UNC prefixes)`;
	}
	return null;
}

/** Throw if `value` is not a canonical id. `label` names the field in errors. */
export function assertCanonicalId(value: unknown, label: string): void {
	const err = validateId(value, label);
	if (err !== null) throw new Error(err);
}

/**
 * Benchmark case ids identify nested case directories but are only used as
 * ledger keys. Accept canonical forward-slash segments while rejecting path
 * traversal, host-specific separators, and absolute or drive-prefixed paths.
 */
export function validateCaseId(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) {
		return "caseId must be a non-empty relative path of at most 512 characters";
	}
	const segments = value.split("/");
	for (const segment of segments) {
		const error = validateId(segment, "caseId segment");
		if (error !== null) return `caseId "${value}" is invalid: ${error}`;
	}
	return null;
}

export function assertCaseId(value: unknown): void {
	const error = validateCaseId(value);
	if (error !== null) throw new Error(error);
}

/** True when `child` is `base` itself or strictly inside `base`. */
export function isWithin(base: string, child: string): boolean {
	const rel = path.relative(base, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Refuse symlink escapes: the logical-string containment in `isWithin` passes
 * for a run/component dir that is a symlink pointing OUTSIDE the root (e.g.
 * `root/audit/<id> -> /somewhere/else`). A later mkdir+write then lands on the
 * real target outside the root. Enforce containment on REAL paths too: realpath
 * the deepest EXISTING ancestor of `candidate` and require it to stay inside the
 * realpath of `root`.
 *
 * No-op when `root` does not exist yet (nothing can be pre-created under it) or
 * when the anchor cannot be realpath'd (permission) — the logical check already
 * ran and covers literal `..`/absolute escapes regardless.
 */
function assertNoSymlinkEscape(root: string, candidate: string): void {
	// A symlinked ROOT defeats the realpath comparison below: realRoot resolves to
	// the link target, and the candidate's deepest existing ancestor resolves to
	// that same target, so isWithin passes while every later mkdir/write lands
	// outside the quality directory. Reject a linked root outright. (A symlinked
	// *child* is caught by the anchor comparison below.)
	if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
		throw new Error(`refusing to write through a symlinked ${path.basename(root)} directory; replace the symlink with a real directory`);
	}
	let realRoot: string;
	try {
		realRoot = fs.realpathSync(root);
	} catch {
		return;
	}
	let anchor = candidate;
	while (!fs.existsSync(anchor)) {
		const parent = path.dirname(anchor);
		if (parent === anchor) return; // walked to filesystem root with no existing ancestor
		anchor = parent;
	}
	let realAnchor: string;
	try {
		realAnchor = fs.realpathSync(anchor);
	} catch {
		return;
	}
	if (!isWithin(realRoot, realAnchor)) {
		throw new Error(`resolved path escapes the root through a symlink; refusing`);
	}
}

/**
 * Resolve `runId` as a run directory under `qualityDir` and verify the resolved
 * path stays inside `qualityDir`. Throws on non-canonical id or an escaping path.
 */
export function resolveRunDir(qualityDir: string, runId: string): string {
	assertCanonicalId(runId, "runId");
	const resolved = path.resolve(qualityDir, "audit", runId);
	const root = path.resolve(qualityDir, "audit");
	if (!isWithin(root, resolved)) {
		throw new Error(`runId "${runId}" resolves outside the quality/audit directory; refusing`);
	}
	assertNoSymlinkEscape(root, resolved);
	return resolved;
}

/** Validate a component id and return the path underneath `baseDir`. */
export function resolveComponentDir(baseDir: string, value: string, label: string): string {
	assertCanonicalId(value, label);
	const resolved = path.resolve(baseDir, value);
	if (!isWithin(path.resolve(baseDir), resolved)) {
		throw new Error(`${label} "${value}" resolves outside "${baseDir}"; refusing`);
	}
	assertNoSymlinkEscape(path.resolve(baseDir), resolved);
	return resolved;
}
