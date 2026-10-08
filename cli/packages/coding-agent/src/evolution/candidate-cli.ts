/**
 * C1 (P1) — CLI surface for authoring a verifiable skill patch candidate.
 *
 * `repo-skills candidate` turns a parent skill tree + a patch of ordered ops
 * into an immutable CandidateManifest, WITHOUT mutating the live tree:
 *
 *   repo-skills candidate author \
 *     --skill <id> --skill-root <dir> --patch <json-file> \
 *     --author <name> --reason "<why>" \
 *     [--staging-dir <dir>] [--out <dir>] [--json]
 *
 * Guarantees surfaced by the module (all from skill-patch.ts):
 *   - The patch is validated (path-escape, symlink, file-size, executable
 *     script) and applied to an isolated COPY of the parent tree.
 *   - A stale patch over a changed parent is refused (parent digest check).
 *   - The candidate id is derivable from (parent digest, patch digest) so the
 *     same patch over the same parent yields the same id (idempotent).
 *   - The manifest is written APPEND-ONLY under <out>/candidates/ so the
 *     exploration record is retained even for failed/rejected candidates.
 *
 * This module is dependency-thin (only node stdlib + skill-patch) and keeps the
 * large repo-skills.ts dispatch table a single thin case.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyPatchToTree,
	buildManifest,
	patchDigest,
	skillTreeDigest,
	type PatchOp,
} from "./skill-patch.ts";
import { atomicWriteFileSync } from "../audit/atomic.ts";

export class CandidateCliError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 2) {
		super(message);
		this.name = "CandidateCliError";
		this.exitCode = exitCode;
	}
}

export interface CandidateAuthorArgs {
	/** Skill id being evolved (informational; used in the manifest). */
	skillId: string;
	/** Absolute path to the live (parent) skill tree. */
	skillRoot: string;
	/** Path to a JSON file describing the patch: { "ops": PatchOp[] }. */
	patchFile: string;
	/** Author attribution. */
	author: string;
	/** Human-readable reason for the change. */
	reason: string;
	/** Where to apply the patch (isolated staging copy). Defaults to a temp dir. */
	stagingDir?: string;
	/** Base dir under which <out>/candidates/ is created. Defaults to process.cwd(). */
	out?: string;
}

export interface CandidateAuthorResult {
	manifestFile: string;
	candidateId: string;
	targetSkillId: string;
	parentSkillDigest: string;
	patchDigest: string;
	resultSkillDigest: string;
	stagedRoot: string;
}

function readPatchFile(patchFile: string): PatchOp[] {
	let raw: string;
	try {
		raw = fs.readFileSync(patchFile, "utf8");
	} catch (error) {
		throw new CandidateCliError(`cannot read patch file: ${patchFile} (${(error as Error).message})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new CandidateCliError(`patch file is not valid JSON: ${(error as Error).message}`);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!Array.isArray((parsed as { ops?: unknown }).ops)
	) {
		throw new CandidateCliError('patch file must be a JSON object with an "ops" array.');
	}
	const ops: PatchOp[] = [];
	for (const rawOp of (parsed as { ops: unknown[] }).ops) {
		const o = rawOp as { kind?: unknown; path?: unknown; content?: unknown };
		if (o === null || typeof o !== "object") throw new CandidateCliError("patch op must be an object.");
		const kind = o.kind;
		const p = o.path;
		if (kind !== "write" && kind !== "delete") {
			throw new CandidateCliError(`patch op kind must be "write" or "delete", got ${JSON.stringify(kind)}.`);
		}
		if (typeof p !== "string" || p.length === 0) {
			throw new CandidateCliError("patch op requires a non-empty string path.");
		}
		if (kind === "write") {
			if (typeof o.content !== "string") throw new CandidateCliError("write op requires string content.");
			ops.push({ kind, path: p, content: o.content });
		} else {
			ops.push({ kind: "delete", path: p });
		}
	}
	return ops;
}

/**
 * Author a candidate manifest. Validates + stages the patch against a COPY of
 * the live skill tree, then writes the manifest append-only. The live tree is
 * never mutated.
 */
export function runCandidateAuthor(args: CandidateAuthorArgs): CandidateAuthorResult {
	if (!args.skillId.trim()) throw new CandidateCliError("--skill requires a non-empty skill id.");
	if (!args.author.trim()) throw new CandidateCliError("--author requires a non-empty author.");
	if (!args.reason.trim()) throw new CandidateCliError("--reason requires a non-empty reason.");

	const skillRoot = path.resolve(args.skillRoot);
	if (!fs.existsSync(skillRoot) || !fs.statSync(skillRoot).isDirectory()) {
		throw new CandidateCliError(`--skill-root is not a directory: ${skillRoot}`);
	}
	const ops = readPatchFile(args.patchFile);
	if (ops.length === 0) throw new CandidateCliError("patch contains no ops (nothing to do).");

	const parentSkillDigest = skillTreeDigest(skillRoot);
	const patchDigestHex = patchDigest(ops);
	const stagedRoot = args.stagingDir
		? path.resolve(args.stagingDir)
		: fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-candidate-"));
	const applied = applyPatchToTree(skillRoot, ops, parentSkillDigest, stagedRoot);

	const manifest = buildManifest({
		targetSkillId: args.skillId,
		parentSkillDigest,
		patchDigest: patchDigestHex,
		resultSkillDigest: applied.resultSkillDigest,
		author: args.author,
		reason: args.reason,
	});

	const outRoot = path.resolve(args.out ?? process.cwd());
	const candidatesDir = path.join(outRoot, "candidates");
	fs.mkdirSync(candidatesDir, { recursive: true });
	const manifestFile = path.join(candidatesDir, `${manifest.candidateId}.json`);
	if (!fs.existsSync(manifestFile)) {
		// Atomic (tmp + rename), per repo convention. A plain writeFileSync that is
		// interrupted leaves truncated JSON, and because this is guarded by
		// existsSync — the documented idempotent re-run path — the corruption is
		// never repaired. The manifest is the only record binding
		// parentSkillDigest/patchDigest/resultSkillDigest for the candidate.
		atomicWriteFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
	}

	return {
		manifestFile,
		candidateId: manifest.candidateId,
		targetSkillId: args.skillId,
		parentSkillDigest,
		patchDigest: patchDigestHex,
		resultSkillDigest: applied.resultSkillDigest,
		stagedRoot,
	};
}
