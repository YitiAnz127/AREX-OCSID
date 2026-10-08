import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
	RepoSkillsInstallResult,
	RepoSkillsLibraryStatus,
	RepoSkillsRouterToggleResult,
} from "../core/repo-skills-library-manager.ts";
import { RepoSkillsLibraryConflictError } from "../core/repo-skills-library-manager.ts";
import { ENV_AGENT_DIR } from "../config.ts";
import { handleRepoSkillsCommand, parseRepoSkillsCommand, readFamilyManifest, readGradeManifest, resolveAgentGateway } from "./repo-skills.ts";

it("uses the external runner's DISCO gateway variables", () => {
	const gateway = resolveAgentGateway({}, {
		DISCO_GATEWAY_URL: "http://example.test/v1",
		DISCO_GATEWAY_MODEL: "test-model",
		DISCO_GATEWAY_KEY: "test-key",
	});
	expect(gateway).toEqual({ baseUrl: "http://example.test/v1", model: "test-model", apiKey: "test-key", maxTokens: 1500 });
	expect(resolveAgentGateway({ agentModel: "override" }, {
		DISCO_GATEWAY_URL: "http://example.test/v1", DISCO_GATEWAY_MODEL: "old",
		DISCO_GATEWAY_KEY: "test-key", DISCO_GATEWAY_MAX_TOKENS: "900",
	}).model).toBe("override");
});

function installResult(overrides: Partial<RepoSkillsInstallResult> = {}): RepoSkillsInstallResult {
	return {
		operation: "install",
		commit: "a".repeat(40),
		managedSkills: 170,
		localSkills: 2,
		totalSkills: 172,
		routerEnabled: true,
		noop: false,
		issues: [],
		...overrides,
	};
}

function statusResult(overrides: Partial<RepoSkillsLibraryStatus> = {}): RepoSkillsLibraryStatus {
	return {
		installed: true,
		managed: true,
		sourceRepository: "https://github.com/VectorSpaceLab/AREX-Skill.git",
		commit: "a".repeat(40),
		managedSkills: 170,
		localSkills: 2,
		totalSkills: 172,
		totalFiles: 1000,
		routerPresent: true,
		routerEnabled: true,
		issues: [],
		...overrides,
	};
}

function fakeManager() {
	return {
		install: vi.fn(async (): Promise<RepoSkillsInstallResult> => installResult()),
		update: vi.fn(async (): Promise<RepoSkillsInstallResult> => installResult({ operation: "update" })),
		status: vi.fn((): RepoSkillsLibraryStatus => statusResult()),
		setRouterEnabled: vi.fn(
			async (enabled: boolean): Promise<RepoSkillsRouterToggleResult> => ({ enabled, changed: true }),
		),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("repo-skills CLI", () => {
	it("parses the command namespace without claiming unrelated commands", () => {
		expect(parseRepoSkillsCommand(["repo-skills", "install", "--force"])).toEqual({
			type: "install",
			force: true,
		});
		expect(parseRepoSkillsCommand(["repo-skills", "router", "disable"])).toEqual({
			type: "router",
			enabled: false,
		});
		expect(parseRepoSkillsCommand(["--offline", "repo-skills", "status"])).toEqual({ type: "status" });
		expect(parseRepoSkillsCommand(["update"])).toBeUndefined();
	});

	it("handles nested help and restricts --force to install and update", () => {
		expect(parseRepoSkillsCommand(["repo-skills"])).toEqual({ type: "help" });
		expect(parseRepoSkillsCommand(["repo-skills", "install", "--help"])).toEqual({ type: "help" });
		expect(parseRepoSkillsCommand(["repo-skills", "router", "--help"])).toEqual({ type: "help" });
		expect(parseRepoSkillsCommand(["repo-skills", "update", "--force"])).toEqual({
			type: "update",
			force: true,
		});
		expect(() => parseRepoSkillsCommand(["repo-skills", "status", "--force"])).toThrow(
			"Unexpected argument for status",
		);
		expect(() => parseRepoSkillsCommand(["repo-skills", "router", "disable", "--force"])).toThrow(
			'Router command must be "enable" or "disable"',
		);
	});

	it("parses usage and report subcommands with their flags", () => {
		expect(parseRepoSkillsCommand(["repo-skills", "usage"])).toEqual({ type: "usage" });
		expect(parseRepoSkillsCommand(["repo-skills", "report"])).toEqual({ type: "report", json: false });
		expect(parseRepoSkillsCommand(["repo-skills", "report", "--json"])).toEqual({ type: "report", json: true });
		expect(() => parseRepoSkillsCommand(["repo-skills", "usage", "--force"])).toThrow(
			"Unexpected argument for usage",
		);
		expect(() => parseRepoSkillsCommand(["repo-skills", "report", "--bogus"])).toThrow(
			"Unknown option for report",
		);
		expect(parseRepoSkillsCommand(["repo-skills", "ledger"])).toEqual({ type: "ledger", json: false });
		expect(parseRepoSkillsCommand(["repo-skills", "ledger", "--json"])).toEqual({ type: "ledger", json: true });
		expect(() => parseRepoSkillsCommand(["repo-skills", "ledger", "--bogus"])).toThrow(
			"Unknown option for ledger",
		);
		// BUG-P0-03: audit is a dev-only command — --benchmark is required; the old
		// implicit default (a runtime dir that never exists on install) is removed.
		expect(() => parseRepoSkillsCommand(["repo-skills", "audit"])).toThrow("--benchmark <root> is required");
		expect(parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "bench"])).toEqual({
			type: "audit",
			json: false,
			benchmarkRoot: "bench",
			runId: undefined,
			candidate: undefined,
			source: undefined,
		});
		expect(parseRepoSkillsCommand(["repo-skills", "audit", "--json", "--run", "baseline-1", "--benchmark", "bench"])).toEqual({
			type: "audit",
			json: true,
			benchmarkRoot: "bench",
			runId: "baseline-1",
			candidate: undefined,
			source: undefined,
		});
		expect(parseRepoSkillsCommand(["repo-skills", "audit", "--run", "cand-1", "--candidate", "some text", "--source", "hyp", "--json", "--benchmark", "bench"])).toEqual({
			type: "audit",
			json: true,
			benchmarkRoot: "bench",
			runId: "cand-1",
			candidate: "some text",
			source: "hyp",
		});
		expect(() => parseRepoSkillsCommand(["repo-skills", "audit", "--run"])).toThrow(
			"--run requires a run-id argument",
		);
		expect(() => parseRepoSkillsCommand(["repo-skills", "audit", "--bogus"])).toThrow(
			"Unknown option for audit",
		);
		expect(parseRepoSkillsCommand([
			"repo-skills", "audit", "--benchmark", "bench", "--run", "candidate-run",
			"--executor", "agent", "--skill", "skill-a", "--case", "c1",
			"--skill-root", "live", "--candidate-manifest", "candidate.json", "--candidate-root", "staged", "--verifier", "private.json",
		])).toMatchObject({
			type: "audit", executor: "agent", skillRoot: "live",
			candidateManifestFile: "candidate.json", candidateRoot: "staged", verifierFile: "private.json",
		});
		expect(parseRepoSkillsCommand(["repo-skills", "diagnose", "--evidence", "visible.json", "--probe-budget", "--json"])).toEqual({
			type: "diagnose", evidenceFile: "visible.json", json: true, probeBudget: true,
		});
		expect(parseRepoSkillsCommand([
			"repo-skills", "audit", "--benchmark", "bench", "--run", "pair", "--executor", "agent",
			"--skill", "skill-a", "--case", "c1", "--candidate-manifest", "candidate.json",
			"--candidate-root", "staged", "--verifier", "private.json", "--paired",
		])).toMatchObject({ type: "audit", paired: true, verifierFile: "private.json" });
		expect(() => parseRepoSkillsCommand([
			"repo-skills", "audit", "--benchmark", "bench", "--run", "r", "--executor", "agent",
			"--skill", "skill-a", "--case", "c1", "--candidate-manifest", "candidate.json",
		])).toThrow(/candidate-root/);
		expect(() => parseRepoSkillsCommand([
			"repo-skills", "audit", "--benchmark", "bench", "--run", "r", "--executor", "agent",
			"--skill", "skill-a", "--case", "c1", "--split", "heldout",
		])).toThrow(/split/i);
		expect(() => parseRepoSkillsCommand([
			"repo-skills", "audit", "--benchmark", "bench", "--run", "r",
			"--candidate-manifest", "candidate.json", "--candidate-root", "staged",
		])).toThrow(/executor agent/);
		expect(parseRepoSkillsCommand(["repo-skills", "evolve", "--propose", "--round", "r1", "--skill", "gget", "--hypothesis", "h", "--plan", "a|b", "--json"])).toEqual({
			type: "evolve",
			json: true,
			roundId: "r1",
			targetSkillId: "gget",
			hypothesis: "h",
			plan: ["a", "b"],
			source: "quality-ledger",
			finding: "",
			empirical: false,
		});
		// Propose-only: auto mode is intentionally rejected.
		expect(() => parseRepoSkillsCommand(["repo-skills", "evolve", "--auto"])).toThrow(
			"auto is intentionally not available",
		);
		expect(() => parseRepoSkillsCommand(["repo-skills", "evolve", "--propose", "--round", "r1", "--skill", "gget", "--hypothesis", "h"])).toThrow(
			"at least one --plan item",
		);
		// BUG-P0-03: baseline is dev-only — --benchmark is required.
		expect(() => parseRepoSkillsCommand(["repo-skills", "baseline", "--seed", "s1"])).toThrow("--benchmark <root> is required");
		expect(parseRepoSkillsCommand(["repo-skills", "baseline", "--json", "--seed", "s1", "--grader", "structure", "--benchmark", "bench"])).toEqual({
			type: "baseline",
			json: true,
			benchmarkRoot: "bench",
			seed: "s1",
			grader: "structure",
		});
		expect(parseRepoSkillsCommand(["repo-skills", "family", "--candidates", "family.json", "--benchmark", "bench", "--json"])).toEqual({
			type: "family",
			json: true,
			benchmarkRoot: "bench",
			candidatesFile: "family.json",
		});
		expect(() => parseRepoSkillsCommand(["repo-skills", "family"])).toThrow("--candidates <file>");
		expect(() => parseRepoSkillsCommand(["repo-skills", "family", "--candidates"])).toThrow("requires a JSON file path");
		expect(() => parseRepoSkillsCommand(["repo-skills", "family", "--candidates", "family.json"])).toThrow("--benchmark <root> is required");
		expect(parseRepoSkillsCommand(["repo-skills", "pool", "--json", "--family", "fam"])).toEqual({ type: "pool", json: true, family: "fam" });
		expect(parseRepoSkillsCommand(["repo-skills", "pool"])).toEqual({ type: "pool", json: false, family: undefined });
		expect(parseRepoSkillsCommand(["repo-skills", "grade", "--run", "r1", "--skill", "chemprop", "--case", "c1", "--score", "0.9", "--by", "human", "--reviewer", "reviewer-1", "--evidence", "ev/1"])).toEqual({
			type: "grade",
			runId: "r1",
			skillId: "chemprop",
			caseId: "c1",
			score: 0.9,
			by: "human",
			note: undefined,
			reviewerId: "reviewer-1",
			rubricVersion: undefined,
			evidenceRef: "ev/1",
		});
		expect(parseRepoSkillsCommand(["repo-skills", "grade", "--run", "r1", "--skill", "chemprop", "--case", "integration/python-api-train-then-predict", "--score", "0.9", "--by", "human", "--reviewer", "reviewer-1", "--evidence", "ev/1"])).toMatchObject({
			type: "grade",
			caseId: "integration/python-api-train-then-predict",
		});
		// B3: human grade without reviewer/evidence is rejected at parse time
		// (consistent with judgement).
		expect(() => parseRepoSkillsCommand(["repo-skills", "grade", "--run", "r1", "--skill", "chemprop", "--case", "c1", "--score", "0.9", "--by", "human"])).toThrow(/reviewer/i);
		expect(() => parseRepoSkillsCommand(["repo-skills", "grade", "--run", "r1", "--skill", "chemprop", "--case", "c1", "--score", "0.9", "--by", "human", "--reviewer", "reviewer-1"])).toThrow(/evidence/i);
		expect(() => parseRepoSkillsCommand(["repo-skills", "grade", "--run", "r1"])).toThrow("--skill, --case, and --score");
		expect(parseRepoSkillsCommand(["repo-skills", "grade", "--from-json", "g.json", "--by", "model_grader"])).toEqual({
			type: "grade",
			by: "model_grader",
			fromJson: "g.json",
		});
		expect(() => parseRepoSkillsCommand(["repo-skills", "grade", "--from-json", "g.json", "--run", "r1"])).toThrow("cannot be combined");
		expect(parseRepoSkillsCommand(["repo-skills", "judgement", "--run", "review-1", "--skill", "chemprop", "--case", "root/case-a", "--score", "0.9", "--by", "human", "--reviewer", "reviewer-1", "--evidence", "ev/1"])).toEqual({
			type: "judgement",
			runId: "review-1",
			skillId: "chemprop",
			caseId: "root/case-a",
			score: 0.9,
			by: "human",
			reviewerId: "reviewer-1",
			rubricVersion: undefined,
			evidenceRef: "ev/1",
		});
		expect(parseRepoSkillsCommand(["repo-skills", "judgement", "--run", "review-2", "--skill", "gget", "--case", "integration/case-b", "--score", "0.5", "--by", "assertion", "--reviewer", "r-1", "--rubric", "v2", "--evidence", "ev/1"])).toEqual({
			type: "judgement",
			runId: "review-2",
			skillId: "gget",
			caseId: "integration/case-b",
			score: 0.5,
			by: "assertion",
			reviewerId: "r-1",
			rubricVersion: "v2",
			evidenceRef: "ev/1",
		});
		expect(() => parseRepoSkillsCommand(["repo-skills", "judgement", "--skill", "chemprop"])).toThrow("judgement requires");
		expect(() => parseRepoSkillsCommand(["repo-skills", "judgement", "--score", "0.5"])).toThrow("judgement requires");
		expect(() => parseRepoSkillsCommand(["repo-skills", "judgement", "--run", "r", "--skill", "chemprop", "--case", "root/case-a", "--score", "0.5", "--by", "human"])).toThrow(/reviewer/i);
		// B3: human judgement also requires --evidence (consistent with grade).
		expect(() => parseRepoSkillsCommand(["repo-skills", "judgement", "--run", "r", "--skill", "chemprop", "--case", "root/case-a", "--score", "0.5", "--by", "human", "--reviewer", "r-1"])).toThrow(/evidence/i);
		expect(() => parseRepoSkillsCommand(["repo-skills", "judgement", "--skill", "../escape", "--score", "0.5"])).toThrow();
		expect(() => parseRepoSkillsCommand(["repo-skills", "judgement", "--skill", "chemprop", "--score", "0.5", "--by", "bogus"])).toThrow("--by must be");
		expect(() => parseRepoSkillsCommand(["repo-skills", "judgement", "--skill", "chemprop", "--score", "0.5", "--bogus"])).toThrow("Unknown option for judgement");
		expect(parseRepoSkillsCommand(["repo-skills", "evalreport", "--json", "--run", "r1"])).toEqual({ type: "evalreport", json: true, run: "r1", baseline: undefined, candidate: undefined, merge: "mean" });
		expect(parseRepoSkillsCommand(["repo-skills", "evalreport"])).toEqual({ type: "evalreport", json: false, run: undefined, baseline: undefined, candidate: undefined, merge: "mean" });
		expect(parseRepoSkillsCommand(["repo-skills", "evalreport", "--baseline", "base-1"])).toEqual({ type: "evalreport", json: false, run: undefined, baseline: "base-1", candidate: undefined, merge: "mean" });
		expect(parseRepoSkillsCommand(["repo-skills", "evalreport", "--candidate", "abcd1234", "--baseline", "base-1"])).toEqual({ type: "evalreport", json: false, run: undefined, baseline: "base-1", candidate: "abcd1234", merge: "mean" });
		expect(parseRepoSkillsCommand(["repo-skills", "evalreport", "--candidate", "abcd1234", "--baseline", "base-1", "--merge", "latest"])).toEqual({ type: "evalreport", json: false, run: undefined, baseline: "base-1", candidate: "abcd1234", merge: "latest" });
		expect(() => parseRepoSkillsCommand(["repo-skills", "evalreport", "--candidate", "abcd1234", "--run", "r1"])).toThrow("mutually exclusive");
		expect(() => parseRepoSkillsCommand(["repo-skills", "evalreport", "--candidate", "zz", "--baseline", "b"])).toThrow("at least 8");
		expect(parseRepoSkillsCommand(["repo-skills", "audit-consistency", "--json"])).toEqual({ type: "auditConsistency", json: true, docs: undefined });
		expect(parseRepoSkillsCommand(["repo-skills", "family-disparity", "--family", "fam", "--baseline", "b1", "--json"])).toEqual({ type: "familyDisparity", json: true, family: "fam", baseline: "b1", merge: "mean" });
		expect(parseRepoSkillsCommand(["repo-skills", "family-disparity"])).toEqual({ type: "familyDisparity", json: false, family: undefined, baseline: undefined, merge: "mean" });
		expect(parseRepoSkillsCommand(["repo-skills", "family-disparity", "--merge", "latest"])).toEqual({ type: "familyDisparity", json: false, family: undefined, baseline: undefined, merge: "latest" });
		expect(() => parseRepoSkillsCommand(["repo-skills", "family-disparity", "--merge", "bogus"])).toThrow("--merge must be 'mean' or 'latest'");
		expect(() => parseRepoSkillsCommand(["repo-skills", "family-disparity", "--bogus"])).toThrow("Unknown option for family-disparity");
		expect(() => parseRepoSkillsCommand(["repo-skills", "family-disparity", "--baseline"])).toThrow("--baseline requires a run-id");
		// BUG-P0-04: --split allowlist parsing on candidate-ranking/held-out eval commands.
		expect(parseRepoSkillsCommand(["repo-skills", "baseline", "--benchmark", "b", "--split", "train"])).toEqual({
			type: "baseline",
			json: false,
			benchmarkRoot: "b",
			seed: "seed-default",
			grader: "token",
			split: ["train"],
		});
		expect(parseRepoSkillsCommand(["repo-skills", "baseline", "--benchmark", "b", "--split", "heldout"])).toMatchObject({ split: ["heldout"] });
		expect(parseRepoSkillsCommand(["repo-skills", "family", "--candidates", "f.json", "--benchmark", "b", "--split", "dev|heldout"])).toMatchObject({ split: ["dev", "heldout"] });
		expect(parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "b", "--run", "ho-1", "--split", "heldout"])).toMatchObject({ split: ["heldout"] });
		expect(parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "b"])).toMatchObject({ split: undefined });
		expect(() => parseRepoSkillsCommand(["repo-skills", "baseline", "--benchmark", "b", "--split", "bogus"])).toThrow("--split must be train|dev|heldout");
		expect(() => parseRepoSkillsCommand(["repo-skills", "family", "--candidates", "f.json", "--benchmark", "b", "--split"])).toThrow("--split requires a value");
		// BUG-P2-15: audit --candidate / --source must never be silently dropped —
		// they require --run, and --source additionally requires --candidate.
		expect(() => parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "b", "--candidate", "some text"])).toThrow("--candidate requires --run");
		expect(() => parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "b", "--source", "hyp"])).toThrow("--source requires --run");
		expect(() => parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "b", "--run", "r1", "--source", "hyp"])).toThrow("--source requires --candidate");
		// BUG-P2-15: bare --source/--finding/--seed (no value) must error, not silently fall back to a default.
		expect(() => parseRepoSkillsCommand(["repo-skills", "evolve", "--propose", "--round", "r1", "--skill", "gget", "--hypothesis", "h", "--plan", "a", "--source"])).toThrow("--source requires a value");
		expect(() => parseRepoSkillsCommand(["repo-skills", "evolve", "--propose", "--round", "r1", "--skill", "gget", "--hypothesis", "h", "--plan", "a", "--finding"])).toThrow("--finding requires a value");
		expect(() => parseRepoSkillsCommand(["repo-skills", "baseline", "--benchmark", "b", "--seed"])).toThrow("--seed requires a value");
		// P1-01: benchmark freeze/verify/diff — an audited freeze is never silent.
		expect(parseRepoSkillsCommand(["repo-skills", "benchmark", "verify", "--root", "skills/tests/benchmark-v2"])).toEqual({
			type: "benchmark",
			action: "verify",
			root: "skills/tests/benchmark-v2",
			json: false,
			name: undefined,
			frozenAt: undefined,
			reason: undefined,
			from: undefined,
			dryRun: false,
		});
		expect(parseRepoSkillsCommand(["repo-skills", "benchmark", "diff", "--root", "b", "--json"])).toMatchObject({ action: "diff", root: "b", json: true });
		expect(
			parseRepoSkillsCommand([
				"repo-skills",
				"benchmark",
				"freeze",
				"--root",
				"skills/tests/benchmark-v2",
				"--from",
				"skills/tests/benchmark-v1",
				"--name",
				"pilot-v2",
				"--frozen-at",
				"2026-10-03T00:00:00Z",
				"--reason",
				"case-2 assertions corrected after review",
				"--dry-run",
			]),
		).toEqual({
			type: "benchmark",
			action: "freeze",
			root: "skills/tests/benchmark-v2",
			json: false,
			name: "pilot-v2",
			frozenAt: "2026-10-03T00:00:00Z",
			reason: "case-2 assertions corrected after review",
			from: "skills/tests/benchmark-v1",
			dryRun: true,
		});
		expect(() => parseRepoSkillsCommand(["repo-skills", "benchmark", "--root", "b"])).toThrow("benchmark requires an action: freeze | verify | diff.");
		expect(() => parseRepoSkillsCommand(["repo-skills", "benchmark", "verify"])).toThrow("benchmark verify: --root <benchmark-dir> is required.");
		// Re-freezing without a recorded reason is how an old experiment's identity gets lost.
		expect(() => parseRepoSkillsCommand(["repo-skills", "benchmark", "freeze", "--root", "b"])).toThrow('benchmark freeze requires --reason "<why>"');
		expect(() => parseRepoSkillsCommand(["repo-skills", "benchmark", "freeze", "--root", "b", "--reason", "  "])).toThrow('benchmark freeze requires --reason "<why>"');
		// verify/diff stay readable without a reason.
		expect(parseRepoSkillsCommand(["repo-skills", "benchmark", "verify", "--root", "b"])).toMatchObject({ reason: undefined });
		expect(() => parseRepoSkillsCommand(["repo-skills", "benchmark", "freeze", "--root", "b", "--reason"])).toThrow("--reason requires a value");
		expect(() => parseRepoSkillsCommand(["repo-skills", "benchmark", "freeze", "--root", "b", "--reason", "why", "--bogus"])).toThrow("Unknown option for benchmark: --bogus");
		expect(() => parseRepoSkillsCommand(["repo-skills", "benchmark", "seal", "--root", "b"])).toThrow("Unknown option for benchmark: seal");
		// P1-02: verify-archive replays a run's recorded verdict from its archived workspace evidence.
		expect(parseRepoSkillsCommand(["repo-skills", "verify-archive", "--run", "run-1"])).toEqual({ type: "verifyArchive", runId: "run-1", json: false });
		expect(parseRepoSkillsCommand(["repo-skills", "verify-archive", "--run", "run-1", "--json"])).toEqual({ type: "verifyArchive", runId: "run-1", json: true });
		expect(() => parseRepoSkillsCommand(["repo-skills", "verify-archive"])).toThrow("verify-archive requires --run <run-id>.");
		expect(() => parseRepoSkillsCommand(["repo-skills", "verify-archive", "--run"])).toThrow("verify-archive: --run requires a run-id.");
		expect(() => parseRepoSkillsCommand(["repo-skills", "verify-archive", "--run", "run-1", "--bogus"])).toThrow("Unknown option for verify-archive: --bogus");
		expect(() => parseRepoSkillsCommand(["repo-skills", "verify-archive", "--run", "../escape"])).toThrow("is not a valid id");
		// P1-04: episode run/status — the loop is one persistent, auditable episode.
		const episodeRun = parseRepoSkillsCommand([
			"repo-skills", "episode", "run", "--episode", "ep-1", "--skill", "gget", "--case", "case-1",
			"--skill-root", "skills", "--evidence", "ev.json", "--request", "req.txt", "--patch", "p.json",
			"--reference", "ref.md", "--assertions", "a.json", "--probe-pairs", "2",
		]);
		expect(episodeRun).toMatchObject({ type: "episode", action: "run", json: false, executor: "agent", episodeId: "ep-1", skillId: "gget", caseId: "case-1", skillRoot: "skills", evidenceFile: "ev.json", requestFile: "req.txt", patchFile: "p.json", referenceFile: "ref.md", assertionsFile: "a.json", probePairs: 2 });
		expect(parseRepoSkillsCommand(["repo-skills", "episode", "status", "--episode", "ep-1", "--json"])).toMatchObject({ type: "episode", action: "status", json: true });
		expect(parseRepoSkillsCommand(["repo-skills", "episode", "run", "--episode", "ep-1", "--skill", "gget", "--case", "case-1", "--skill-root", "skills", "--evidence", "ev.json", "--request", "req.txt", "--patch", "p.json", "--executor", "native", "--agent-provider", "openai-codex", "--agent-model", "gpt-5.5", "--session-mode", "researcher"])).toMatchObject({ executor: "native", agentProvider: "openai-codex", agentModel: "gpt-5.5", sessionMode: "researcher" });
		const extraCases = ["repo-skills", "episode", "run", "--episode", "ep-1", "--skill", "gget", "--case", "case-1", "--skill-root", "skills", "--evidence", "ev.json", "--request", "req.txt", "--patch", "p.json", "--cases", "case-2"];
		expect(() => parseRepoSkillsCommand(extraCases)).toThrow(/--cases-root/);
		expect(parseRepoSkillsCommand([...extraCases, "--cases-root", "cases"])).toMatchObject({ cases: ["case-2"], casesRoot: "cases" });
		expect(() => parseRepoSkillsCommand(["repo-skills", "episode"])).toThrow("episode requires an action: run | status.");
		expect(() => parseRepoSkillsCommand(["repo-skills", "episode", "run", "--skill", "gget"])).toThrow("episode requires --episode <id>.");
		// A partial episode would silently probe without a patch to apply, so the whole input set is required.
		expect(() => parseRepoSkillsCommand(["repo-skills", "episode", "run", "--episode", "ep-1", "--skill", "gget", "--case", "case-1"])).toThrow("episode run requires --skill, --case, --skill-root, --evidence, --request and --patch");
		expect(() => parseRepoSkillsCommand(["repo-skills", "episode", "run", "--episode", "ep-1", "--skill", "gget", "--case", "case-1", "--skill-root", "s", "--evidence", "e", "--request", "r", "--patch", "p", "--reference", "a", "--reference-text", "b"])).toThrow("--reference (file) and --reference-text are mutually exclusive");
		expect(() => parseRepoSkillsCommand(["repo-skills", "episode", "run", "--episode", "ep-1", "--skill", "gget", "--case", "case-1", "--skill-root", "s", "--evidence", "e", "--request", "r", "--patch", "p", "--probe-pairs", "-1"])).toThrow("--probe-pairs must be a non-negative integer");
		expect(() => parseRepoSkillsCommand(["repo-skills", "episode", "run", "--episode", "ep-1", "--skill", "gget", "--case", "case-1", "--skill-root", "s", "--evidence", "e", "--request", "r", "--patch", "p", "--bogus"])).toThrow("Unknown option for episode: --bogus");
		// P1-05: promotion is human-gated — an unreferenced approval is not an approval.
		expect(parseRepoSkillsCommand(["repo-skills", "promote", "--episode", "ep-1", "--approval", "review 2026-10-03", "--verify-request", "req.txt", "--verifier", "v.json", "--note", "reviewed the diff"])).toMatchObject({ type: "promote", episodeId: "ep-1", approval: "review 2026-10-03", approvalNote: "reviewed the diff", noVerify: false, verifyRequestFile: "req.txt", verifierFile: "v.json", executor: "agent" });
		expect(parseRepoSkillsCommand(["repo-skills", "promote", "--episode", "ep-1", "--approval", "ok", "--no-verify"])).toMatchObject({ type: "promote", noVerify: true });
		expect(() => parseRepoSkillsCommand(["repo-skills", "promote", "--episode", "ep-1"])).toThrow('promote requires --approval "<who approved and where>"');
		expect(() => parseRepoSkillsCommand(["repo-skills", "promote", "--episode", "ep-1", "--approval", "   "])).toThrow('promote requires --approval "<who approved and where>"');
		// Without a fresh-session verification the commit must not be reported as a success.
		expect(() => parseRepoSkillsCommand(["repo-skills", "promote", "--episode", "ep-1", "--approval", "ok"])).toThrow("promote: --verify-request <file> is required");
		expect(() => parseRepoSkillsCommand(["repo-skills", "promote", "--episode", "ep-1", "--approval", "ok", "--verify-request", "r"])).toThrow("promote: post-promotion verification needs --verifier <file>");
		expect(() => parseRepoSkillsCommand(["repo-skills", "promote", "--episode", "ep-1", "--approval", "ok", "--verify-request", "r", "--assertions", "assertions.json"])).toThrow(/text assertions alone are proxy/);
		expect(() => parseRepoSkillsCommand(["repo-skills", "promote", "--approval", "ok", "--no-verify"])).toThrow("promote requires --episode <id>.");
		expect(parseRepoSkillsCommand(["repo-skills", "rollback", "--episode", "ep-1", "--reason", "post-verify failed", "--json"])).toMatchObject({ type: "rollback", episodeId: "ep-1", reason: "post-verify failed", json: true });
		expect(() => parseRepoSkillsCommand(["repo-skills", "rollback", "--episode", "ep-1"])).toThrow('rollback requires --reason "<why>"');
		expect(() => parseRepoSkillsCommand(["repo-skills", "rollback", "--reason", "why"])).toThrow("rollback requires --episode <id>.");
		expect(() => parseRepoSkillsCommand(["repo-skills", "rollback", "--episode", "ep-1", "--reason", "why", "--bogus"])).toThrow("Unknown option for rollback: --bogus");
	});

	it("reads and validates the grade manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "arex-grade-"));
		try {
			const good = join(dir, "g.json");
			writeFileSync(good, JSON.stringify({ grades: [{ runId: "r", skillId: "s", caseId: "c", score: 0.5, gradedBy: "human" }] }), "utf8");
			const reqs = readGradeManifest(good);
			expect(reqs).toHaveLength(1);
			expect(reqs[0].score).toBe(0.5);
			expect(reqs[0].gradedBy).toBe("human");
			writeFileSync(join(dir, "bad.json"), "not json", "utf8");
			expect(() => readGradeManifest(join(dir, "bad.json"))).toThrow("not valid JSON");
			writeFileSync(join(dir, "empty.json"), "[]", "utf8");
			expect(() => readGradeManifest(join(dir, "empty.json"))).toThrow("at least one");
			writeFileSync(join(dir, "missing.json"), JSON.stringify([{ runId: "r" }]), "utf8");
			expect(() => readGradeManifest(join(dir, "missing.json"))).toThrow("requires");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads and validates the family candidates manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "arex-man-"));
		try {
			const good = join(dir, "good.json");
			writeFileSync(good, JSON.stringify({ runId: "r", candidates: [{ candidateId: "a", text: "t", generation: 0 }] }), "utf8");
			const m = readFamilyManifest(good);
			expect(m.runId).toBe("r");
			expect(m.candidates).toHaveLength(1);
			const bad = join(dir, "bad.json");
			writeFileSync(bad, "not json", "utf8");
			expect(() => readFamilyManifest(bad)).toThrow("not valid JSON");
			expect(() => readFamilyManifest(join(dir, "missing.json"))).toThrow("cannot read");
			writeFileSync(join(dir, "empty.json"), JSON.stringify({ candidates: [] }), "utf8");
			expect(() => readFamilyManifest(join(dir, "empty.json"))).toThrow("non-empty 'candidates'");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs install with force and reports preserved local skills", async () => {
		const manager = fakeManager();
		const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

		expect(await handleRepoSkillsCommand(["repo-skills", "install", "--force"], { manager })).toBe(true);

		expect(manager.install).toHaveBeenCalledWith({ force: true });
		expect(output.mock.calls.flat().join("\n")).toContain("Local skills preserved: 2");
	});

	it("reports drift through status and returns a failing exit code", async () => {
		const manager = fakeManager();
		manager.status.mockReturnValue(statusResult({ issues: ["alpha-skill: managed skill is modified"] }));
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleRepoSkillsCommand(["repo-skills", "status"], { manager });

		expect(process.exitCode).toBe(1);
	});

	it("disables automatic router selection while retaining explicit invocation guidance", async () => {
		const manager = fakeManager();
		const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleRepoSkillsCommand(["repo-skills", "router", "disable"], { manager });

		expect(manager.setRouterEnabled).toHaveBeenCalledWith(false);
		expect(output.mock.calls.flat().join("\n")).toContain("Explicit /skill:repo-skills-router invocation remains available");
	});

	it("rejects unknown nested commands with usage exit code 2", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(await handleRepoSkillsCommand(["repo-skills", "remove"])).toBe(true);

		expect(process.exitCode).toBe(2);
		expect(error.mock.calls.flat().join("\n")).toContain("Unknown repo-skills command");
	});

	it("maps conflicts to exit code 2 and operational failures to exit code 1", async () => {
		const manager = fakeManager();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		manager.install.mockRejectedValueOnce(new RepoSkillsLibraryConflictError(["alpha-skill: local drift"]));

		await handleRepoSkillsCommand(["repo-skills", "install"], { manager });
		expect(process.exitCode).toBe(2);

		process.exitCode = undefined;
		manager.update.mockRejectedValueOnce(new Error("Git fetch failed"));
		await handleRepoSkillsCommand(["repo-skills", "update"], { manager });
		expect(process.exitCode).toBe(1);
	});

	// BUG-P1-15: JSON output must not swallow the failure exit code.
	describe("JSON-mode exit codes stay fail-closed", () => {
		const originalAgentDir = process.env[ENV_AGENT_DIR];

		function brokenAuditDir(): { agentDir: string; quality: string } {
			const agentDir = mkdtempSync(join(tmpdir(), "arex-agent-json-"));
			const quality = join(agentDir, "rsi", "quality");
			// summary claims 5 ledger rows but we write only 1 -> ledger-self-consistent FAIL
			const runDir = join(quality, "audit", "r1");
			mkdirSync(runDir, { recursive: true });
			writeFileSync(
				join(runDir, "summary.json"),
				JSON.stringify({ runId: "r1", kind: "candidate-eval", ledgerRowCount: 5 }),
				"utf8",
			);
			writeFileSync(join(runDir, "ledger.jsonl"), JSON.stringify({ runId: "r1", skillId: "s", caseId: "c1", score: 0.5, gradedBy: "human", ts: "t", candidateSha256: "abcd1234" }) + "\n", "utf8");
			return { agentDir, quality };
		}

		afterEach(() => {
			process.exitCode = undefined;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
		});

		it("audit-consistency --json exits 1 on a failing audit", async () => {
			const { agentDir } = brokenAuditDir();
			try {
				process.env[ENV_AGENT_DIR] = agentDir;
				const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
				expect(await handleRepoSkillsCommand(["repo-skills", "audit-consistency", "--json", "--docs", join(agentDir, "docs")])).toBe(true);
				expect(output.mock.calls.flat().join("\n")).toContain("ledger-self-consistent");
				expect(process.exitCode).toBe(1);
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		});

		it("evalreport --json exits 1 when the baseline run is missing", async () => {
			const { agentDir } = brokenAuditDir();
			try {
				process.env[ENV_AGENT_DIR] = agentDir;
				vi.spyOn(console, "log").mockImplementation(() => undefined);
				expect(await handleRepoSkillsCommand(["repo-skills", "evalreport", "--json", "--baseline", "missing-run"])).toBe(true);
				expect(process.exitCode).toBe(1);
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		});

		it("evalreport --json includes the requested digest comparison", async () => {
			const agentDir = mkdtempSync(join(tmpdir(), "arex-eval-json-"));
			try {
				process.env[ENV_AGENT_DIR] = agentDir;
				const auditDir = join(agentDir, "rsi", "quality", "audit");
				for (const runId of ["base-1", "candidate-1"]) mkdirSync(join(auditDir, runId), { recursive: true });
				writeFileSync(join(auditDir, "base-1", "summary.json"), JSON.stringify({ runId: "base-1", kind: "baseline-plumbing", taskSuccessRate: 0.25, ledgerRowCount: 1 }), "utf8");
				writeFileSync(join(auditDir, "base-1", "ledger.jsonl"), JSON.stringify({ runId: "base-1", skillId: "chemprop", caseId: "root/case-a", score: 0.25, gradedBy: "assertion", candidateSha256: null }) + "\n", "utf8");
				writeFileSync(join(auditDir, "candidate-1", "summary.json"), JSON.stringify({ runId: "candidate-1", kind: "candidate-eval", taskSuccessRate: 0.75, ledgerRowCount: 1 }), "utf8");
				writeFileSync(join(auditDir, "candidate-1", "ledger.jsonl"), JSON.stringify({ runId: "candidate-1", skillId: "chemprop", caseId: "root/case-a", score: 0.75, gradedBy: "human", candidateSha256: "abcd1234", ts: "2026-01-01T00:00:00Z" }) + "\n", "utf8");
				const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
				expect(await handleRepoSkillsCommand(["repo-skills", "evalreport", "--json", "--baseline", "base-1", "--candidate", "abcd1234"])).toBe(true);
				const report = JSON.parse(output.mock.calls.at(-1)?.[0] as string);
				expect(report.candidateAnalysis).toMatchObject({ matchedRuns: 1, candidateCovered: 1, overlapped: 1, candidateOnly: 0, baselineOnly: 0 });
				expect(report.candidateAnalysis.skillDeltas[0]).toMatchObject({ skillId: "chemprop", meanDelta: 0.5 });
				expect(process.exitCode).toBeUndefined();
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		});
	});
});

describe("repo-skills CLI — P1-03 native session options", () => {
	it("parses the native audit executor with its session controls", () => {
		expect(parseRepoSkillsCommand([
			"repo-skills", "audit", "--benchmark", "bench", "--run", "run-1", "--executor", "native",
			"--skill", "chemprop", "--case", "case-1", "--tools", "read_file,write_file,execute_command",
			"--write-dirs", "@workspace/output,@workspace/scratch", "--session-mode", "researcher",
			"--acceptance", "heldout", "--agent-provider", "openai-codex", "--agent-model", "gpt-5.5",
		])).toEqual({
			type: "audit", json: false, benchmarkRoot: "bench", runId: "run-1", candidate: undefined, source: undefined,
			split: undefined, executor: "native", skillId: "chemprop", caseId: "case-1", skillRoot: undefined,
			candidateManifestFile: undefined, candidateRoot: undefined, verifierFile: undefined, agentBaseUrl: undefined,
			agentModel: "gpt-5.5", agentApiKeyEnv: undefined, agentProvider: "openai-codex", sessionMode: "researcher",
			tools: ["read_file", "write_file", "execute_command"], writeDirs: ["@workspace/output", "@workspace/scratch"],
			acceptance: "heldout",
		});
	});

	it("parses an ad-hoc native request instead of a benchmark case", () => {
		const parsed = parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "bench", "--run", "run-2", "--executor", "native", "--skill", "huggingface-hub", "--request", "req.txt"]);
		expect(parsed).toMatchObject({ type: "audit", executor: "native", requestFile: "req.txt", caseId: undefined });
	});

	it("parses the native execution budget overrides and rejects them on other executors", () => {
		expect(parseRepoSkillsCommand([
			"repo-skills", "audit", "--benchmark", "bench", "--run", "run-3", "--executor", "native",
			"--skill", "pycirclize", "--case", "integration/x", "--wall-ms", "900000", "--token-budget", "400000",
		])).toMatchObject({ type: "audit", executor: "native", wallMs: 900_000, tokenBudget: 400_000 });
		const exitCodeOf = (args: string[]): number | undefined => {
			try {
				parseRepoSkillsCommand(args);
				return undefined;
			} catch (error) {
				return (error as { exitCode?: number }).exitCode;
			}
		};
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--executor", "agent", "--skill", "s", "--case", "c-1", "--wall-ms", "1000"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--skill", "s", "--case", "c-1", "--token-budget", "0"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--skill", "s", "--case", "c-1", "--wall-ms", "soon"])).toBe(2);
	});

	it("rejects native misuse and agent-only options mixed with native", () => {
		const exitCodeOf = (args: string[]): number | undefined => {
			try {
				parseRepoSkillsCommand(args);
				return undefined;
			} catch (error) {
				return (error as { exitCode?: number }).exitCode;
			}
		};
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--case", "c-1"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--skill", "s"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--executor", "agent", "--skill", "s", "--case", "c-1", "--tools", "read_file"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--skill", "s", "--case", "c-1", "--request", "req.txt"])).toBe(2);
	});

	it("parses creator-researcher with and without a frozen case", () => {
		expect(parseRepoSkillsCommand([
			"repo-skills", "creator-researcher", "--source", "src", "--out", "out", "--skill", "huggingface-hub",
			"--request", "req.txt", "--run", "cr-1", "--model", "gpt-5.5", "--thinking", "low", "--wall-ms", "600000",
		])).toEqual({
			type: "creatorResearcher", json: false, source: "src", outputDir: "out", skillId: "huggingface-hub",
			requestFile: "req.txt", runId: "cr-1", model: "gpt-5.5", thinking: "low", wallMs: 600000,
		});
		expect(parseRepoSkillsCommand([
			"repo-skills", "creator-researcher", "--source", "src", "--out", "out", "--skill", "s", "--request", "req.txt",
			"--run", "cr-2", "--benchmark", "bench", "--case", "case-1", "--verifier", "v.json", "--acceptance", "heldout", "--skill-root", "root",
		])).toMatchObject({ type: "creatorResearcher", benchmarkRoot: "bench", caseId: "case-1", verifierFile: "v.json", acceptance: "heldout", skillRoot: "root" });
	});

	it("rejects an incomplete creator-researcher invocation", () => {
		const exitCodeOf = (args: string[]): number | undefined => {
			try {
				parseRepoSkillsCommand(args);
				return undefined;
			} catch (error) {
				return (error as { exitCode?: number }).exitCode;
			}
		};
		expect(exitCodeOf(["repo-skills", "creator-researcher", "--out", "out", "--skill", "s", "--request", "req.txt", "--run", "r"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "creator-researcher", "--source", "src", "--out", "out", "--skill", "s", "--request", "req.txt", "--run", "r", "--benchmark", "bench"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "creator-researcher", "--source", "src", "--out", "out", "--skill", "s", "--request", "req.txt", "--run", "r", "--wall-ms", "0"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "creator-researcher", "--source", "src", "--out", "out", "--skill", "s", "--request", "req.txt", "--run", "r", "--bogus"])).toBe(2);
	});
});

describe("repo-skills CLI — ad-hoc case assertions", () => {
	it("parses --assertions for a native ad-hoc audit and for creator-researcher", () => {
		expect(parseRepoSkillsCommand(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--skill", "s", "--request", "req.txt", "--assertions", "a.json"]))
			.toMatchObject({ type: "audit", executor: "native", requestFile: "req.txt", assertionsFile: "a.json" });
		expect(parseRepoSkillsCommand(["repo-skills", "creator-researcher", "--source", "s", "--out", "o", "--skill", "k", "--request", "req.txt", "--run", "r", "--assertions", "a.json"]))
			.toMatchObject({ type: "creatorResearcher", assertionsFile: "a.json" });
	});

	it("rejects --assertions without an ad-hoc request, on a non-native executor, or without a value", () => {
		const exitCodeOf = (args: string[]): number | undefined => {
			try {
				parseRepoSkillsCommand(args);
				return undefined;
			} catch (error) {
				return (error as { exitCode?: number }).exitCode;
			}
		};
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--skill", "s", "--case", "c-1", "--assertions", "a.json"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--executor", "agent", "--skill", "s", "--case", "c-1", "--assertions", "a.json"])).toBe(2);
		expect(exitCodeOf(["repo-skills", "audit", "--benchmark", "b", "--run", "r", "--executor", "native", "--skill", "s", "--request", "req.txt", "--assertions"])).toBe(2);
	});
});
