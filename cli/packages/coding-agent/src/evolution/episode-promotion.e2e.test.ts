/**
 * P1-04 + P1-05 closed loop, once, end to end.
 *
 * The audit's step 4 asks for ONE human-approved RSI episode: failing evidence ->
 * controlled probe -> U0 diagnosis -> patch -> regression -> approval -> the real
 * promotion transaction -> re-verification in a NEW session against the newly
 * installed skill, with the refusal branch proven not to touch the live tree.
 *
 * Everything here is real except the model: the live library is installed by the
 * real `RepoSkillsLibraryManager` from a git source repository, the candidate is
 * authored by the real patcher, every leg is a real `runAgentEval` (workspace,
 * ledger, diagnostic evidence, candidate snapshot) and the promotion goes through
 * the manager's real lock/backup/rename transaction. The driver is deterministic
 * so the test is reproducible offline; it decides only what text to emit.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, runAgentEval, type AgentDriver } from "../audit/agent-executor.ts";
import { RepoSkillsLibraryManager, type RepoSkillsLibraryManagerOptions } from "../core/repo-skills-library-manager.ts";
import type { DiagnosticEvidence } from "./diagnostic-policy.ts";
import { episodeProbeEvidencePath, runEpisode } from "./episode-run.ts";
import { EPISODE_TERMINAL_PHASES, readEpisode } from "./episode.ts";
import { promoteEpisode, readPromotionLedger, type PostPromotionVerification } from "./promotion.ts";
import { REFERENCE_ADDITION_HEADING } from "./probe.ts";
import { skillTreeDigest } from "./skill-patch.ts";

const SKILL_ID = "alpha";
const EPISODE_ID = "ep-alpha-1";
const CASE_ID = "case-1";
const REFERENCE = "REFERENCE-MATERIAL: the reference material names the required tokens.";
const ASSERTED_TEXT = "Contains: REFERENCE-MATERIAL\nExists: answer.md\n";
const HEADING_TEXT = "Answer the question about the managed skill.";

const bundledSkillsDir = path.join(process.cwd(), "packages", "coding-agent", "src", "ocsid", "skills");
const updaterScript = path.join(bundledSkillsDir, "verify-repo-skill", "scripts", "update_repo_skills_router.mjs");
const taxonomyHash = "30f8aa8934db13c613e6dfea053acb0023543cb9d5c3990e348ecf100479c985";

const roots: string[] = [];

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
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

async function createSourceRepository(root: string): Promise<string> {
	const repository = path.join(root, "source");
	const libraryRoot = path.join(repository, "skills", "repositories");
	const skillDir = path.join(libraryRoot, "repo-skills", SKILL_ID);
	fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
	fs.writeFileSync(path.join(repository, ".gitattributes"), "* text=auto eol=lf\n", "utf8");
	execFileSync("git", ["init", "--initial-branch=main", repository]);
	git(repository, "config", "user.email", "test@example.com");
	git(repository, "config", "user.name", "OCSID Test");
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMarkdown("source-v1"), "utf8");
	fs.writeFileSync(
		path.join(skillDir, "references", "repo-routing-metadata.json"),
		`${JSON.stringify({
			schema_version: "2.0",
			repo_id: "owner/alpha",
			skill_id: SKILL_ID,
			taxonomy_sha256: taxonomyHash,
			routing_status: "classified",
			assignments: [{ area: "Scientific Computing", family: "Molecular Informatics" }],
		}, null, 2)}\n`,
		"utf8",
	);
	fs.cpSync(path.join(bundledSkillsDir, "repo-skills-router"), path.join(libraryRoot, "repo-skills-router"), { recursive: true });
	fs.writeFileSync(
		path.join(libraryRoot, "repo-skills", "repository-index.jsonl"),
		`${JSON.stringify({
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
		})}\n`,
		"utf8",
	);
	fs.writeFileSync(
		path.join(libraryRoot, "repo-skills-router", "references", "index", "assignments.jsonl"),
		`${JSON.stringify({
			repo_id: "owner/alpha",
			legacy_repo_id: "batch_0/alpha",
			skill_id: SKILL_ID,
			area: "Scientific Computing",
			family: "Molecular Informatics",
			confidence: "high",
		})}\n`,
		"utf8",
	);
	execFileSync(process.execPath, [updaterScript, "--library-root", libraryRoot, "--template-dir", path.join(bundledSkillsDir, "repo-skills-router"), "--router-visibility", "enabled"]);
	git(repository, "add", ".gitattributes", "skills");
	git(repository, "commit", "-m", "source v1");
	return repository;
}

function manager(agentDir: string, sourceRepository: string): RepoSkillsLibraryManager {
	const overrides: Omit<RepoSkillsLibraryManagerOptions, "agentDir" | "sourceRepository"> = {};
	return new RepoSkillsLibraryManager({
		...overrides,
		agentDir,
		sourceRepository,
		bundledSkillsDir,
		env: { ...process.env, OCSID_OFFLINE: "" },
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	agentDir: string;
	manager: RepoSkillsLibraryManager;
	/** The parent directory `runAgentEval` snapshots from (<...>/repo-skills). */
	skillRoot: string;
	liveSkillRoot: string;
	originalDigest: string;
	assertionsFile: string;
	verifierFile: string;
	patchFile: string;
	evidence: DiagnosticEvidence;
}

/** Install a real managed library and write the case files the episode needs. */
async function fixture(): Promise<Fixture> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-episode-e2e-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const sourceRepository = await createSourceRepository(root);
	const libraryManager = manager(agentDir, sourceRepository);
	await libraryManager.install();
	const skillRoot = path.join(agentDir, "skills", "repositories", "repo-skills");
	const liveSkillRoot = path.join(skillRoot, SKILL_ID);
	const originalDigest = skillTreeDigest(liveSkillRoot);
	const assertionsFile = path.join(root, "assertions.json");
	fs.writeFileSync(
		assertionsFile,
		`${JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["Contains: REFERENCE-MATERIAL", "Exists: answer.md"] }, null, 2)}\n`,
		"utf8",
	);
	const verifierFile = path.join(root, "verifier.json");
	fs.writeFileSync(verifierFile, JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [{ type: "json-number-range", path: "output/result.json", key: "value", min: 1, max: 1 }] }));
	const patchFile = path.join(root, "patch.json");
	fs.writeFileSync(
		patchFile,
		`${JSON.stringify({ ops: [{ kind: "write", path: "SKILL.md", content: skillMarkdown("candidate-v1") }] }, null, 2)}\n`,
		"utf8",
	);
	const evidence: DiagnosticEvidence = {
		schema: "ocsid.diagnostic-evidence.v1",
		runId: "audit-alpha-1",
		caseId: CASE_ID,
		skillId: SKILL_ID,
		skillDigest: originalDigest,
		score: 0,
		executionStatus: "succeeded",
		evidenceRefs: ["ledger.jsonl"],
		probeBudgetAvailable: false,
	};
	return { root, agentDir, manager: libraryManager, skillRoot, liveSkillRoot, originalDigest, assertionsFile, verifierFile, patchFile, evidence };
}

/**
 * Deterministic driver: the "after" probe leg and any leg whose skill snapshot
 * carries the candidate patch answer correctly; the untouched parent answers
 * unrelated text. The mock never invents the assertion, it only decides the text.
 */
function drivers(seen: string[]): () => AgentDriver {
	return () => ({
		name: "test-episode-e2e-driver",
		async run({ workspace, caseInput, startedAt }) {
			const withReference = caseInput.userRequest.includes(REFERENCE_ADDITION_HEADING);
			const snapshot = fs.readFileSync(path.join(workspace.skillSnapshotDir, "SKILL.md"), "utf8");
			const candidate = snapshot.includes("candidate-v1");
			seen.push(withReference ? "probe-after" : candidate ? "candidate" : "parent");
			fs.mkdirSync(path.join(workspace.root, "output"), { recursive: true });
			const text = withReference || candidate ? ASSERTED_TEXT : "unrelated output\n";
			fs.writeFileSync(path.join(workspace.root, "output", "answer.md"), text, "utf8");
			fs.writeFileSync(path.join(workspace.root, "output", "result.json"), JSON.stringify({ value: text === ASSERTED_TEXT ? 1 : 0 }));
			return {
				schema: "ocsid.execution-result.v1" as const,
				status: "succeeded" as const,
				artifact: text,
				artifactSha256: createHash("sha256").update(text).digest("hex"),
				usage: { modelCalls: 1, totalTokens: 10, toolCalls: 1, wallMs: 5 },
				startedAt,
				endedAt: startedAt,
			};
		},
	});
}

function options(f: Fixture, seen: string[]) {
	return {
		qualityDir: f.root,
		episodeId: EPISODE_ID,
		skillId: SKILL_ID,
		caseId: CASE_ID,
		skillRoot: f.skillRoot,
		evidence: f.evidence,
		request: HEADING_TEXT,
		reference: REFERENCE,
		assertionsFile: f.assertionsFile,
		verifierFile: f.verifierFile,
		patchFile: f.patchFile,
		config: { ...DEFAULT_AGENT_CONFIG, model: "test/model", wallMs: 60_000, tokenBudget: 100_000 },
		driverFactory: drivers(seen),
	};
}

describe("P1-04/P1-05 closed loop on a real managed library", () => {
	it("runs the episode, promotes the accepted candidate and re-verifies it in a new session", async () => {
		const f = await fixture();
		const seen: string[] = [];
		const run = await runEpisode(options(f, seen));

		// The loop is real: two controlled probe pairs, then parent/candidate.
		expect(seen).toEqual(["parent", "probe-after", "parent", "probe-after", "parent", "candidate"]);
		expect(run.episode.phase).toBe("awaiting-approval");
		expect(run.episode.terminal).not.toBe(true);
		expect(run.diagnosis).toMatchObject({ diagnosis: "skill_defect", decision: "patch" });
		expect(run.episode.probe).toMatchObject({ kind: "reference-addition", controlled: true, meanGain: 1 });
		expect(run.regression).toMatchObject({ parentMean: 0, candidateMean: 1, delta: 1, regressedCases: [] });
		expect(run.episode.acceptance?.verdict).toBe("accepted");
		expect(fs.existsSync(episodeProbeEvidencePath(f.root, EPISODE_ID))).toBe(true);
		// The candidate is bound to the LIVE skill the probe measured.
		expect(run.episode.candidate?.manifest.parentSkillDigest).toBe(f.originalDigest);
		// Nothing has touched the live tree yet.
		expect(fs.readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("source-v1");

		// ---- promotion: human approval, real transaction, fresh-session re-verification
		const verifyRuns: PostPromotionVerification[] = [];
		const promoted = await promoteEpisode({
			qualityDir: f.root,
			episode: run.episode,
			approval: { reference: "APR-2026-10-03-alpha", note: "reviewed the probe and regression evidence" },
			manager: f.manager,
			verifyAfterPromotion: async ({ skillId, liveSkillRoot, skillDigest }) => {
				// Re-verify in a NEW session against the NEWLY INSTALLED skill tree.
				const verification = await runAgentEval({
					qualityDir: f.root,
					runId: `${EPISODE_ID}-post-verify`,
					skillId,
					caseId: CASE_ID,
					skillRoot: path.dirname(liveSkillRoot),
					config: options(f, []).config,
					driver: drivers([])(),
					verifierFile: f.verifierFile,
					adhocCase: { skillId, caseId: CASE_ID, userRequest: HEADING_TEXT, assertionsText: fs.readFileSync(f.assertionsFile, "utf8") },
				});
				const evidence = JSON.parse(fs.readFileSync(verification.diagnosticEvidencePath, "utf8")) as DiagnosticEvidence;
				const result: PostPromotionVerification = {
					runId: verification.runId,
					status: verification.status,
					score: evidence.score,
					verifierSha256: verification.verifierSha256,
					evidenceRef: verification.diagnosticEvidencePath,
				};
				verifyRuns.push(result);
				expect(skillDigest).toBe(skillTreeDigest(liveSkillRoot));
				return result;
			},
		});

		expect(promoted.refused).toBeUndefined();
		// The live library now serves the candidate, and it is exactly the tree the manifest promised.
		expect(fs.readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("candidate-v1");
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(run.episode.candidate?.manifest.resultSkillDigest);
		// The re-verification was a real, scored, post-promotion session (score 1 on the installed skill).
		expect(verifyRuns).toHaveLength(1);
		expect(verifyRuns[0]).toMatchObject({ runId: `${EPISODE_ID}-post-verify`, status: "succeeded", score: 1 });
		expect(fs.existsSync(path.join(f.root, "audit", `${EPISODE_ID}-post-verify`, "summary.json"))).toBe(true);
		// Approval, the file commit and the re-verification stay separate records.
		const ledger = readPromotionLedger(f.root);
		expect(ledger.map((record) => record.kind)).toEqual(["approval", "file-commit", "post-verification"]);
		expect(ledger[1]?.commit).toMatchObject({ previousDigest: f.originalDigest, installedDigest: run.episode.candidate?.manifest.resultSkillDigest });
		expect(ledger[2]?.verification).toMatchObject({ verdict: "pass", score: 1 });
		// The episode is terminal and persisted as verified.
		const persisted = readEpisode(f.root, EPISODE_ID);
		expect(persisted.phase).toBe("verified");
		expect(EPISODE_TERMINAL_PHASES.includes(persisted.phase)).toBe(true);
		expect(persisted.promotion?.postVerification).toMatchObject({ score: 1, verdict: "pass" });
		expect(promoted.episode.promotion?.approvalRef).toBe("APR-2026-10-03-alpha");
	});

	it("refuses an unreferenced approval and leaves the live library untouched", async () => {
		const f = await fixture();
		const seen: string[] = [];
		const run = await runEpisode(options(f, seen));
		expect(run.episode.phase).toBe("awaiting-approval");

		const refused = await promoteEpisode({
			qualityDir: f.root,
			episode: run.episode,
			approval: { reference: "   " },
			manager: f.manager,
		});
		expect(refused.refused).toMatch(/human approval/i);
		expect(fs.readFileSync(path.join(f.liveSkillRoot, "SKILL.md"), "utf8")).toContain("source-v1");
		expect(skillTreeDigest(f.liveSkillRoot)).toBe(f.originalDigest);
		expect(readPromotionLedger(f.root).map((record) => record.kind)).toEqual(["refusal"]);
		// A refusal does not launder itself into a verified episode: the episode is
		// stopped as a failure (nothing was promoted), never as an improvement.
		const persisted = readEpisode(f.root, EPISODE_ID);
		expect(persisted.phase).toBe("failed");
		expect(persisted.stop?.kind).toBe("failure");
	});
});
