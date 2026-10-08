/**
 * P1-05: human-gated promotion into the live library.
 *
 * These tests drive the REAL `RepoSkillsLibraryManager` (git source repository,
 * real lock, real backup/rename transaction) rather than a stub, because the
 * whole point of the finding was that no production caller existed.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoSkillsLibraryManager, type RepoSkillsLibraryManagerOptions } from "../core/repo-skills-library-manager.ts";
import { runCandidateAuthor } from "./candidate-cli.ts";
import { createEpisode, readEpisode, saveEpisode, type EpisodeAcceptance, type EpisodeCandidate } from "./episode.ts";
import { promoteEpisode, readPromotionLedger, rollbackPromotion } from "./promotion.ts";
import { skillTreeDigest } from "./skill-patch.ts";

const roots: string[] = [];
const bundledSkillsDir = path.join(process.cwd(), "packages", "coding-agent", "src", "ocsid", "skills");
const updaterScript = path.join(bundledSkillsDir, "verify-repo-skill", "scripts", "update_repo_skills_router.mjs");
const taxonomyHash = "30f8aa8934db13c613e6dfea053acb0023543cb9d5c3990e348ecf100479c985";
const SKILL_ID = "alpha";

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "ocsid-promotion-"));
	roots.push(root);
	return root;
}

function skillMarkdown(marker: string): string {
	return [
		"---",
		`name: ${SKILL_ID}`,
		`description: "Use ${SKILL_ID} for focused repository workflows."`,
		"disable-model-invocation: true",
		"metadata:",
		"  ocsid-role: operating",
		"---",
		"",
		`# ${SKILL_ID}`,
		"",
		marker,
		"",
	].join("\n");
}

async function createSourceRepository(root: string, marker = "source-v1"): Promise<string> {
	const repository = path.join(root, "source");
	const libraryRoot = path.join(repository, "skills", "repositories");
	const skillDir = path.join(libraryRoot, "repo-skills", SKILL_ID);
	await mkdir(path.join(skillDir, "references"), { recursive: true });
	await writeFile(path.join(repository, ".gitattributes"), "* text=auto eol=lf\n", "utf8");
	execFileSync("git", ["init", "--initial-branch=main", repository]);
	git(repository, "config", "user.email", "test@example.com");
	git(repository, "config", "user.name", "OCSID Test");
	await writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown(marker), "utf8");
	await writeFile(path.join(skillDir, "references", "repo-routing-metadata.json"), `${JSON.stringify({
		schema_version: "2.0",
		repo_id: "owner/alpha",
		skill_id: SKILL_ID,
		taxonomy_sha256: taxonomyHash,
		routing_status: "classified",
		assignments: [{ area: "Scientific Computing", family: "Molecular Informatics" }],
	}, null, 2)}\n`, "utf8");
	cpSync(path.join(bundledSkillsDir, "repo-skills-router"), path.join(libraryRoot, "repo-skills-router"), { recursive: true });
	await writeFile(path.join(libraryRoot, "repo-skills", "repository-index.jsonl"), `${JSON.stringify({
		schema_version: 1,
		repo_id: "owner/alpha",
		legacy_repo_id: "batch_0/alpha",
		repo_name: "alpha",
		skill_id: SKILL_ID,
		source_url: "https://github.com/owner/alpha",
		source_commit: null,
		source_skill_root: `repo-skills/${SKILL_ID}`,
		target_skill_root: `repo-skills/${SKILL_ID}`,
		aliases: [],
		description: "Use alpha for focused repository workflows.",
	})}\n`, "utf8");
	await writeFile(path.join(libraryRoot, "repo-skills-router", "references", "index", "assignments.jsonl"), `${JSON.stringify({
		repo_id: "owner/alpha",
		legacy_repo_id: "batch_0/alpha",
		skill_id: SKILL_ID,
		area: "Scientific Computing",
		family: "Molecular Informatics",
		confidence: "high",
	})}\n`, "utf8");
	execFileSync(process.execPath, [updaterScript, "--library-root", libraryRoot, "--template-dir", path.join(bundledSkillsDir, "repo-skills-router"), "--router-visibility", "enabled"]);
	git(repository, "add", ".gitattributes", "skills");
	git(repository, "commit", "-m", "source v1");
	return repository;
}

function manager(agentDir: string, sourceRepository: string, overrides: Omit<RepoSkillsLibraryManagerOptions, "agentDir" | "sourceRepository"> = {}) {
	return new RepoSkillsLibraryManager({
		...overrides,
		agentDir,
		sourceRepository,
		bundledSkillsDir,
		env: { ...(overrides.env ?? process.env), OCSID_OFFLINE: "" },
	});
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	agentDir: string;
	sourceRepository: string;
	manager: RepoSkillsLibraryManager;
	liveSkillRoot: string;
	originalDigest: string;
	candidate: EpisodeCandidate;
	episode: ReturnType<typeof createEpisode>;
	acceptance: EpisodeAcceptance;
}

/** Install the library, author a candidate against it and stage an accepted episode. */
async function fixture(marker = "source-v1"): Promise<Fixture> {
	const root = await makeRoot();
	const agentDir = path.join(root, "agent");
	const sourceRepository = await createSourceRepository(root, marker);
	const libraryManager = manager(agentDir, sourceRepository);
	await libraryManager.install();
	const liveSkillRoot = path.join(agentDir, "skills", "repositories", "repo-skills", SKILL_ID);
	const originalDigest = skillTreeDigest(liveSkillRoot);
	const patchFile = path.join(root, "patch.json");
	await writeFile(patchFile, `${JSON.stringify({ ops: [{ kind: "write", path: "SKILL.md", content: skillMarkdown("candidate-v1") }] }, null, 2)}\n`, "utf8");
	const authored = runCandidateAuthor({
		skillId: SKILL_ID,
		skillRoot: liveSkillRoot,
		patchFile,
		author: "test",
		reason: "reference-addition probe",
		stagingDir: path.join(root, "staging"),
		out: path.join(root, "candidates-out"),
	});
	const candidate: EpisodeCandidate = {
		candidateId: authored.candidateId,
		stagedRoot: authored.stagedRoot,
		manifestFile: authored.manifestFile,
		manifest: JSON.parse(readFileSync(authored.manifestFile, "utf8")),
	};
	const acceptance: EpisodeAcceptance = {
		verdict: "accepted",
		scoreSource: "workspace-verifier",
		reasons: [],
		parentMean: 0.25,
		candidateMean: 1,
		delta: 0.75,
		regressedCases: [],
	};
	const episode = saveEpisode(root, {
		...createEpisode({ qualityDir: root, episodeId: "ep-1", skillId: SKILL_ID, caseId: "case-1" }),
		phase: "awaiting-approval",
		candidate,
		acceptance,
	});
	return { root, agentDir, sourceRepository, manager: libraryManager, liveSkillRoot, originalDigest, candidate, episode, acceptance };
}

const approval = { reference: "APR-2026-10-03-1", note: "reviewed the paired probe evidence" };

describe("human-gated promotion", () => {
	it("applies an approved candidate and records approval, commit and re-verification separately", async () => {
		const f = await fixture();
		let sawCandidateLive = false;
		const result = await promoteEpisode({
			qualityDir: f.root,
			episode: f.episode,
			approval,
			manager: f.manager,
			verifyAfterPromotion: async ({ skillDigest, liveSkillRoot }) => {
				sawCandidateLive = readFileSync(path.join(liveSkillRoot, "SKILL.md"), "utf8").includes("candidate-v1");
				expect(skillDigest).toBe(f.candidate.manifest.resultSkillDigest);
				return { runId: "post-1", status: "succeeded", score: 1, verifierSha256: "a".repeat(64), evidenceRef: path.join(f.root, "post.json") };
			},
		});
		expect(result.refused).toBeUndefined();
		expect(sawCandidateLive).toBe(true);
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("candidate-v1");
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(f.candidate.manifest.resultSkillDigest);
		expect(result.episode.phase).toBe("verified");
		expect(result.episode.promotion?.approvalRef).toBe(approval.reference);
		expect(result.episode.promotion?.postVerification).toMatchObject({ runId: "post-1", score: 1, verdict: "pass" });
		const ledger = readPromotionLedger(f.root);
		expect(ledger.map((record) => record.kind)).toEqual(["approval", "file-commit", "post-verification"]);
		expect(ledger[0]?.prevRecordId).toBeNull();
		expect(ledger[1]?.prevRecordId).toBe(ledger[0]?.recordId);
		expect(ledger[2]?.prevRecordId).toBe(ledger[1]?.recordId);
		expect(ledger[1]?.commit?.installedDigest).toBe(f.candidate.manifest.resultSkillDigest);
		expect(ledger[1]?.commit?.previousDigest).toBe(f.originalDigest);
		expect(ledger[1]?.approval?.reference).toBe(approval.reference);
		const backup = ledger[1]?.commit?.backupPath;
		expect(backup).toBeDefined();
		expect(readFileSync(path.join(backup as string, "repo-skills", SKILL_ID, "SKILL.md"), "utf8")).toContain("source-v1");
		expect(readEpisode(f.root, "ep-1").phase).toBe("verified");
	});

	it("refuses without a human approval reference and leaves the live tree untouched", async () => {
		const f = await fixture();
		const result = await promoteEpisode({ qualityDir: f.root, episode: f.episode, approval: { reference: "   " }, manager: f.manager });
		expect(result.refused).toMatch(/non-empty human approval reference/);
		expect(result.commitRecord).toBeUndefined();
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("source-v1");
		expect(readPromotionLedger(f.root).map((record) => record.kind)).toEqual(["refusal"]);
		expect(readEpisode(f.root, "ep-1").phase).toBe("failed");
	});

	it("refuses a candidate whose parent skill changed since it was authored", async () => {
		const f = await fixture();
		// Someone else (an install/update) touched the live skill after authoring.
		await writeFile(path.join(f.liveSkillRoot, "SKILL.md"), skillMarkdown("moved-on-v2"), "utf8");
		const result = await promoteEpisode({
			qualityDir: f.root,
			episode: f.episode,
			approval,
			manager: f.manager,
			verifyAfterPromotion: async () => ({ runId: "never", status: "succeeded", score: 1, verifierSha256: "a".repeat(64), evidenceRef: "never.json" }),
		});
		expect(result.refused).toMatch(/parent skill "alpha" changed since the candidate was authored/);
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("moved-on-v2");
		expect(readPromotionLedger(f.root).map((record) => record.kind)).toEqual(["approval", "refusal"]);
	});

	it("refuses a candidate the acceptance gate rejected", async () => {
		const f = await fixture();
		const rejected = saveEpisode(f.root, { ...f.episode, acceptance: { ...f.acceptance, verdict: "rejected", reasons: ["candidate regressed on case-2"] } });
		const result = await promoteEpisode({ qualityDir: f.root, episode: rejected, approval, manager: f.manager });
		expect(result.refused).toMatch(/acceptance gate rejected this candidate: candidate regressed on case-2/);
		expect(existsSync(path.join(f.liveSkillRoot, "SKILL.md"))).toBe(true);
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("source-v1");
		expect(readPromotionLedger(f.root).map((record) => record.kind)).toEqual(["refusal"]);
	});

	it("rolls the promotion back when the new session fails to reproduce the result", async () => {
		const f = await fixture();
		const result = await promoteEpisode({
			qualityDir: f.root,
			episode: f.episode,
			approval,
			manager: f.manager,
			verifyAfterPromotion: async () => ({ runId: "post-1", status: "succeeded", score: 0, evidenceRef: path.join(f.root, "post.json") }),
		});
		expect(result.rollbackRecord).toBeDefined();
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("source-v1");
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(f.originalDigest);
		expect(result.episode.phase).toBe("failed");
		expect(result.episode.stop?.reason).toMatch(/post-promotion verification failed/);
		expect(readPromotionLedger(f.root).map((record) => record.kind)).toEqual(["approval", "file-commit", "post-verification", "rollback"]);
		expect(f.manager.status().managed).toBe(true);
	});

	it("rolls back on request with a reason, through the same transaction path", async () => {
		const f = await fixture();
		await promoteEpisode({
			qualityDir: f.root,
			episode: f.episode,
			approval,
			manager: f.manager,
			verifyAfterPromotion: async () => ({ runId: "post-1", status: "succeeded", score: 1, verifierSha256: "a".repeat(64), evidenceRef: path.join(f.root, "post.json") }),
		});
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("candidate-v1");
		const rolled = await rollbackPromotion({
			qualityDir: f.root,
			episode: readEpisode(f.root, "ep-1"),
			reason: "operator reverted: the new session looked worse on a second case",
			manager: f.manager,
		});
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("source-v1");
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(f.originalDigest);
		expect(rolled.record.kind).toBe("rollback");
		expect(rolled.episode.phase).toBe("failed");
		await expect(rollbackPromotion({ qualityDir: f.root, episode: rolled.episode, reason: "  ", manager: f.manager })).rejects.toThrow(/requires a reason/);
	});

	/**
	 * Step 5 (exceptions and rollback): an interruption INSIDE the replacement
	 * transaction must not leave a half-updated library — the swapped part is
	 * restored, the state file still describes the old tree, and no `file-commit`
	 * record claims a promotion that never completed.
	 */
	it("leaves no half-updated library when the replacement transaction is interrupted", async () => {
		const f = await fixture();
		const points: string[] = [];
		const crashing = new RepoSkillsLibraryManager({
			agentDir: f.agentDir,
			sourceRepository: f.sourceRepository,
			bundledSkillsDir,
			env: { ...process.env, OCSID_OFFLINE: "" },
			transactionFaultInjector: (point) => {
				points.push(point);
				// Fire after the repo-skills swap has begun, i.e. mid-transaction.
				if (point === "before-install-state") throw new Error("simulated crash inside the promotion transaction");
			},
		});
		const result = await promoteEpisode({
			qualityDir: f.root,
			episode: f.episode,
			approval,
			manager: crashing,
			verifyAfterPromotion: async () => ({ runId: "post-1", status: "succeeded", score: 1, verifierSha256: "a".repeat(64), evidenceRef: path.join(f.root, "post.json") }),
		}).then(
			() => undefined,
			(error: unknown) => error as Error,
		);
		// An unexpected crash is NOT laundered into a "refusal": it surfaces.
		expect(result?.message).toMatch(/simulated crash inside the promotion transaction/);
		expect(points).toContain("before-install-state");
		// The transaction rolled itself back (restore points ran) instead of leaving a
		// half-swapped tree behind.
		expect(points.some((point) => point.startsWith("before-restore-"))).toBe(true);
		// The live tree is exactly the pre-promotion tree, byte for byte.
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("source-v1");
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(f.originalDigest);
		// The surviving library still describes the OLD tree (no orphan state).
		expect(f.manager.status().managed).toBe(true);
		// Only the approval was recorded: no `file-commit` claims a promotion that never completed.
		expect(readPromotionLedger(f.root).map((record) => record.kind)).toEqual(["approval"]);
		expect(readEpisode(f.root, "ep-1").phase).toBe("promotion");
	});
});


describe("promotion failure and episode identity regressions", () => {
	it("restores the live skill and records failure when verification throws", async () => {
		const f = await fixture();
		const result = await promoteEpisode({ qualityDir: f.root, episode: f.episode, approval, manager: f.manager, verifyAfterPromotion: async () => { throw new Error("verifier setup failed"); } });
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(f.originalDigest);
		expect(result.episode.phase).toBe("failed");
		expect(result.rollbackRecord).toBeDefined();
		expect(result.verificationRecord?.verification?.verdict).toBe("fail");
		expect(result.rollbackRecord?.reason).toMatch(/verifier setup failed/);
	});
	it("refuses historical rollback that would overwrite a different episode's promotion", async () => {
		const f = await fixture();
		const first = await promoteEpisode({ qualityDir: f.root, episode: f.episode, approval, manager: f.manager });
		const patchFile = path.join(f.root, "patch-second.json");
		await writeFile(patchFile, JSON.stringify({ ops: [{ kind: "write", path: "SKILL.md", content: skillMarkdown("candidate-v2") }] }));
		const authored = runCandidateAuthor({ skillId: SKILL_ID, skillRoot: f.liveSkillRoot, patchFile, author: "test", reason: "second", stagingDir: path.join(f.root, "stage-second"), out: path.join(f.root, "out-second") });
		const second = saveEpisode(f.root, { ...createEpisode({ qualityDir: f.root, episodeId: "ep-2", skillId: SKILL_ID, caseId: "case-1" }), phase: "awaiting-approval", acceptance: f.acceptance, candidate: { candidateId: authored.candidateId, stagedRoot: authored.stagedRoot, manifestFile: authored.manifestFile, manifest: JSON.parse(readFileSync(authored.manifestFile, "utf8")) } });
		await promoteEpisode({ qualityDir: f.root, episode: second, approval, manager: f.manager });
		await expect(rollbackPromotion({ qualityDir: f.root, episode: first.episode, reason: "revert first", manager: f.manager })).rejects.toThrow(/(changed|different|current|digest)/);
		expect(readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("candidate-v2");
	});
	it("refuses a legacy acceptance with no independent grading provenance", async () => {
		const f = await fixture();
		const legacy = { ...f.episode, acceptance: { ...f.acceptance } };
		delete legacy.acceptance.scoreSource;
		const result = await promoteEpisode({ qualityDir: f.root, episode: legacy, approval, manager: f.manager });
		expect(result.refused).toMatch(/(independent|verifier|grading)/);
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(f.originalDigest);
	});
});
