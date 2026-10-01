import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCandidateAuthor, CandidateCliError } from "./candidate-cli.ts";
import { skillTreeDigest } from "./skill-patch.ts";

describe("candidate-cli (C1: authoring a verifiable skill patch)", () => {
	let root: string;
	let skillRoot: string;
	let stagingRoot: string;
	let outRoot: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "cand-cli-"));
		skillRoot = path.join(root, "skill");
		stagingRoot = path.join(root, "staging");
		outRoot = path.join(root, "out");
		fs.mkdirSync(skillRoot, { recursive: true });
		fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "v1\n");
		fs.mkdirSync(path.join(skillRoot, "test-cases"), { recursive: true });
		fs.writeFileSync(path.join(skillRoot, "test-cases", "t1.md"), "frozen\n");
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writePatch(ops: unknown): string {
		const f = path.join(root, "patch.json");
		fs.writeFileSync(f, JSON.stringify({ ops }, null, 2));
		return f;
	}

	it("authors a manifest and leaves the live tree untouched", () => {
		const beforeDigest = skillTreeDigest(skillRoot);
		const patchFile = writePatch([{ kind: "write", path: "SKILL.md", content: "v2\n" }]);
		const res = runCandidateAuthor({
			skillId: "s1",
			skillRoot,
			patchFile,
			author: "alice",
			reason: "sharpen instructions",
			stagingDir: stagingRoot,
			out: outRoot,
		});
		// live tree unchanged
		expect(skillTreeDigest(skillRoot)).toBe(beforeDigest);
		// manifest written append-only in <out>/candidates/
		expect(fs.existsSync(res.manifestFile)).toBe(true);
		const manifest = JSON.parse(fs.readFileSync(res.manifestFile, "utf8"));
		expect(manifest.enc).toBe("disco.candidate-manifest.v1");
		expect(manifest.candidateId).toBe(res.candidateId);
		expect(manifest.targetSkillId).toBe("s1");
		expect(manifest.parentSkillDigest).toBe(beforeDigest);
		expect(manifest.patchDigest).toBe(res.patchDigest);
		expect(manifest.resultSkillDigest).toBe(skillTreeDigest(stagingRoot));
		// staging contains the new content, not the frozen corpus
		expect(fs.readFileSync(path.join(stagingRoot, "SKILL.md"), "utf8")).toBe("v2\n");
		expect(fs.existsSync(path.join(stagingRoot, "test-cases"))).toBe(false);
	});

	it("is idempotent for the same (parent, patch)", () => {
		const patchFile = writePatch([{ kind: "write", path: "SKILL.md", content: "v2\n" }]);
		const a = runCandidateAuthor({ skillId: "s1", skillRoot, patchFile, author: "alice", reason: "r", stagingDir: stagingRoot, out: outRoot });
		const b = runCandidateAuthor({ skillId: "s1", skillRoot, patchFile, author: "alice", reason: "r", stagingDir: stagingRoot, out: outRoot });
		expect(b.candidateId).toBe(a.candidateId);
		expect(b.manifestFile).toBe(a.manifestFile);
	});

	it("rejects a patch that escapes the skill subtree", () => {
		const patchFile = writePatch([{ kind: "write", path: "../evil.txt", content: "x" }]);
		expect(() =>
			runCandidateAuthor({ skillId: "s1", skillRoot, patchFile, author: "alice", reason: "r", stagingDir: stagingRoot, out: outRoot }),
		).toThrow(/escapes|rejected/i);
	});

	it("rejects invalid patch files with friendly errors", () => {
		expect(() => runCandidateAuthor({ skillId: "s1", skillRoot, patchFile: path.join(root, "missing.json"), author: "a", reason: "r", out: outRoot })).toThrow(CandidateCliError);
		const bad = path.join(root, "bad.json");
		fs.writeFileSync(bad, "{ not json");
		expect(() => runCandidateAuthor({ skillId: "s1", skillRoot, patchFile: bad, author: "a", reason: "r", out: outRoot })).toThrow(/not valid JSON/);
		const noOps = path.join(root, "noops.json");
		fs.writeFileSync(noOps, JSON.stringify({ ops: [] }));
		expect(() => runCandidateAuthor({ skillId: "s1", skillRoot, patchFile: noOps, author: "a", reason: "r", out: outRoot })).toThrow(/no ops/);
	});

	it("requires author and reason", () => {
		const patchFile = writePatch([{ kind: "write", path: "SKILL.md", content: "v2\n" }]);
		expect(() => runCandidateAuthor({ skillId: "s1", skillRoot, patchFile, author: "  ", reason: "r", out: outRoot })).toThrow(/author/);
		expect(() => runCandidateAuthor({ skillId: "s1", skillRoot, patchFile, author: "a", reason: "  ", out: outRoot })).toThrow(/reason/);
	});
});
