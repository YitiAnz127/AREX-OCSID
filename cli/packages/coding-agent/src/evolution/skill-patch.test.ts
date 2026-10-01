import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makePatch,
	patchDigest,
	validatePatch,
	applyPatchToStaging,
	skillTreeDigest,
	applyPatchToTree,
	candidateIdFor,
	buildManifest,
	validateGenealogy,
	DEFAULT_PATCH_POLICY,
	type PatchOp,
} from "./skill-patch.ts";

function makeParent(root: string, overrides: Record<string, string> = {}): string {
	const tree = join(root, "skill-a");
	mkdirSync(join(tree, "sub"), { recursive: true });
	writeFileSync(join(tree, "SKILL.md"), overrides["SKILL.md"] ?? "# Skill A\n\nOriginal instructions.\n");
	writeFileSync(join(tree, "sub", "flow.txt"), overrides["sub/flow.txt"] ?? "default flow\n");
	// a frozen eval corpus that candidates must not touch
	mkdirSync(join(tree, "test-cases"), { recursive: true });
	writeFileSync(join(tree, "test-cases", "case.json"), "{}\n");
	return tree;
}

describe("skill-patch (C1: candidate as verifiable skill patch)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "arex-c1-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("derives a deterministic patch digest, stable across platforms", () => {
		const ops: PatchOp[] = [
			{ kind: "write", path: "SKILL.md", content: "new content" },
			{ kind: "write", path: "sub/flow.txt", content: "flow v2\n" },
		];
		// ordering is part of the identity: reordering MUST change the digest
		expect(patchDigest(ops)).not.toBe(patchDigest([...ops].reverse()));
		expect(patchDigest(ops)).toBe(patchDigest(JSON.parse(JSON.stringify(ops))));
		expect(makePatch(ops).patchDigest).toBe(patchDigest(ops));
	});

	it("validates path-escape, file-size and executable-script violations", () => {
		const root = makeParent(tmp);
		const escapes: PatchOp[] = [{ kind: "write", path: "../outside.txt", content: "x" }];
		expect(validatePatch(escapes, root)).toHaveLength(1);

		const big: PatchOp[] = [{ kind: "write", path: "a.txt", content: "x".repeat(DEFAULT_PATCH_POLICY.maxFileBytes + 1) }];
		expect(validatePatch(big, root)).toHaveLength(1);
		expect(validatePatch(big, root)[0].reason).toContain("exceeds");

		const script: PatchOp[] = [{ kind: "write", path: "run.sh", content: "#!/bin/sh\necho hi\n" }];
		expect(validatePatch(script, root)[0].reason).toContain("executable");
	});

	it("applies a validated patch to a staging tree, excluding test-cases", () => {
		const root = makeParent(tmp);
		const stub = join(tmp, "stage");
		const ops: PatchOp[] = [
			{ kind: "write", path: "SKILL.md", content: "# Skill A v2\n\nImproved.\n" },
			{ kind: "write", path: "extra.txt", content: "added\n" },
			{ kind: "delete", path: "sub/flow.txt" },
		];
		const written = applyPatchToStaging(ops, stub);
		expect(written).toEqual(["SKILL.md", "extra.txt"]);
		expect(readFileSync(join(stub, "SKILL.md"), "utf8")).toContain("v2");
		expect(existsSync(join(stub, "extra.txt"))).toBe(true);
		expect(existsSync(join(stub, "sub", "flow.txt"))).toBe(false);
		// live parent untouched
		expect(readFileSync(join(root, "SKILL.md"), "utf8")).toContain("Original");
	});

	it("throws when applying through a symlinked directory in staging", () => {
		// The symlink must live in the STAGING tree, since that is the tree the ops
		// are applied to. (This test previously built the symlink under the *parent*
		// and applied to a fresh empty stub, so there was no symlink on the path at
		// all — it passed only because dirSafe treated a non-existent directory as a
		// symlink. Fixing that made the false pass visible.)
		const outside = join(tmp, "outside-write");
		mkdirSync(outside, { recursive: true });
		const stub = join(tmp, "stage2");
		mkdirSync(stub, { recursive: true });
		symlinkSync(outside, join(stub, "link"));
		const ops: PatchOp[] = [{ kind: "write", path: "link/evil.txt", content: "x" }];
		expect(() => applyPatchToStaging(ops, stub)).toThrow(/symlink/);
		// nothing was written through the link
		expect(existsSync(join(outside, "evil.txt"))).toBe(false);
	});

	it("throws when DELETING through a symlinked directory in staging", () => {
		// The delete branch had no symlink guard at all: rmSync resolved through the
		// parent link and removed a real file outside the staging tree.
		const outside = join(tmp, "outside-del");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "important.txt"), "keep\n");
		const stub = join(tmp, "stage-del");
		mkdirSync(stub, { recursive: true });
		symlinkSync(outside, join(stub, "link"));
		const ops: PatchOp[] = [{ kind: "delete", path: "link/important.txt" }];
		expect(() => applyPatchToStaging(ops, stub)).toThrow(/symlink/);
		expect(existsSync(join(outside, "important.txt"))).toBe(true);
	});

	it("allows a patch op that creates a new subdirectory", () => {
		// A not-yet-existing directory is not a symlink. dirSafe used to return false
		// on ENOENT, so any op introducing a new nested dir failed with a bogus
		// "writes through a symlink".
		const stub = join(tmp, "stage-new");
		mkdirSync(stub, { recursive: true });
		const ops: PatchOp[] = [{ kind: "write", path: "references/new.md", content: "x\n" }];
		const written = applyPatchToStaging(ops, stub);
		expect(written).toEqual(["references/new.md"]);
		expect(readFileSync(join(stub, "references", "new.md"), "utf8")).toBe("x\n");
	});

	it("refuses a staging dir inside the live skill tree, so the live tree is never mutated", () => {
		const root = makeParent(tmp);
		const digest = skillTreeDigest(root);
		const ops: PatchOp[] = [{ kind: "write", path: "SKILL.md", content: "# MUTATED BY CANDIDATE\n" }];

		// staging === the live tree: previously rewrote the skill in place while the
		// manifest still recorded the pre-mutation parentSkillDigest.
		expect(() => applyPatchToTree(root, ops, digest, root)).toThrow(/outside the skill tree/);
		// staging nested inside the live tree: previously recursed stage/stage/stage/…
		expect(() => applyPatchToTree(root, ops, digest, join(root, "stage"))).toThrow(/outside the skill tree/);

		// The live tree survived both attempts byte-for-byte.
		expect(skillTreeDigest(root)).toBe(digest);
		expect(readFileSync(join(root, "SKILL.md"), "utf8")).toContain("Original");
	});

	it("computes a stable whole-skill-tree digest that excludes test-cases", () => {
		const a = makeParent(tmp, { extra: "fix" });
		const d1 = skillTreeDigest(a);
		// changing the eval corpus must NOT change the candidate digest
		writeFileSync(join(a, "test-cases", "case.json"), "{changed}\n");
		expect(skillTreeDigest(a)).toBe(d1);
		// changing skill content MUST change it
		writeFileSync(join(a, "SKILL.md"), "# changed\n");
		expect(skillTreeDigest(a)).not.toBe(d1);
		// deterministic across roots with identical content (excluding nothing else)
		const b = makeParent(tmp, { extra: "fix" });
		expect(skillTreeDigest(b)).toBe(d1);
	});

	it("applyPatchToTree copies the parent, refuses stale parents, and returns the result digest", () => {
		const parent = makeParent(tmp);
		const parentDigest = skillTreeDigest(parent);
		const ops: PatchOp[] = [{ kind: "write", path: "SKILL.md", content: "v2" }];
		const staging = join(tmp, "stage-tree");
		const { stagedRoot, resultSkillDigest } = applyPatchToTree(parent, ops, parentDigest, staging);
		expect(existsSync(join(stagedRoot, "SKILL.md"))).toBe(true);
		expect(existsSync(join(stagedRoot, "test-cases"))).toBe(false); // eval corpus never staged
		expect(resultSkillDigest).toBe(skillTreeDigest(stagedRoot));
		// live parent byte-identical during eval
		expect(skillTreeDigest(parent)).toBe(parentDigest);

		// stale parent must be refused
		writeFileSync(join(parent, "SKILL.md"), "# mutated\n");
		expect(() => applyPatchToTree(parent, ops, parentDigest, join(tmp, "stage2"), DEFAULT_PATCH_POLICY)).toThrow(/changed|stale/i);
	});

	it("same parent+patch yields same candidate id (idempotency + duplicate detection)", () => {
		const parent = makeParent(tmp);
		const pd = skillTreeDigest(parent);
		const ops: PatchOp[] = [{ kind: "write", path: "SKILL.md", content: "v2" }];
		const d = patchDigest(ops);
		expect(candidateIdFor(pd, d)).toBe(candidateIdFor(pd, d));
		expect(candidateIdFor(pd, d)).not.toBe(candidateIdFor(pd, patchDigest([{ kind: "write", path: "a", content: "y" }])));
	});

	it("builds a complete candidate manifest", () => {
		const parent = makeParent(tmp);
		const pd = skillTreeDigest(parent);
		const ops: PatchOp[] = [{ kind: "write", path: "SKILL.md", content: "v2" }];
		const m = buildManifest({
			targetSkillId: "skill-a",
			parentSkillDigest: pd,
			patchDigest: patchDigest(ops),
			resultSkillDigest: "abc123",
			author: "agent-1",
			reason: "tighten instructions",
			createdAt: "2026-01-01T00:00:00Z",
		});
		expect(m.enc).toBe("disco.candidate-manifest.v1");
		expect(m.candidateId).toBe(candidateIdFor(pd, patchDigest(ops)));
		expect(m.parentSkillDigest).toBe(pd);
		expect(m.patchDigest).toBe(patchDigest(ops));
		expect(m.targetSkillId).toBe("skill-a");
		expect(m.author).toBe("agent-1");
		expect(m.resultSkillDigest).toBe("abc123");
	});

	it("retains rejected/failed candidates by NOT mutating the parent on rejection", () => {
		// a rejected candidate must leave history (parent tree) intact and
		// record-able — applyPatchToTree only stages, never touches the live tree.
		const parent = makeParent(tmp);
		const pd = skillTreeDigest(parent);
		const bad: PatchOp[] = [{ kind: "write", path: "../escape.md", content: "x" }];
		const staging = join(tmp, "stage-reject");
		expect(() => applyPatchToTree(parent, bad, pd, staging)).toThrow(/rejected|escape/);
		expect(skillTreeDigest(parent)).toBe(pd); // live history preserved
	});

	it("genealogy detects duplicate candidates and cycles", () => {
		const parent = makeParent(tmp);
		const pd = skillTreeDigest(parent);
		const ops: PatchOp[] = [{ kind: "write", path: "SKILL.md", content: "v2" }];
		const d = patchDigest(ops);
		// acyclic chain p -> r1 -> r2
		const nodes = [
			{ candidateId: candidateIdFor(pd, d), parentSkillDigest: pd, resultSkillDigest: "r1" },
			{ candidateId: "c2", parentSkillDigest: "r1", resultSkillDigest: "r2" },
		];
		const g = validateGenealogy(nodes);
		expect(g.cycles).toEqual([]);
		expect(g.duplicateIds).toEqual([]);

		// duplicate candidate id
		expect(validateGenealogy([...nodes, { ...nodes[0] }]).duplicateIds).toContain(nodes[0].candidateId);

		// cycle: r2 claims to derive from pd which derives from r2
		const cyclic = [
			{ candidateId: "a", parentSkillDigest: pd, resultSkillDigest: "r1" },
			{ candidateId: "b", parentSkillDigest: "r1", resultSkillDigest: "r2" },
			{ candidateId: "c", parentSkillDigest: "r2", resultSkillDigest: pd },
		];
		expect(validateGenealogy(cyclic).cycles.length).toBeGreaterThan(0);
	});
});
