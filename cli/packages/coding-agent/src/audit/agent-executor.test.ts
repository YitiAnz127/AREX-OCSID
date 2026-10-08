/**
 * B2 — agent-executor contract tests (interface + fake-executor path).
 *
 * These exercise the vertical-slice contract without a real model: workspace
 * isolation, skill snapshot, honest fake usage, cleanup, and write-dir escape
 * rejection. They deliberately do NOT claim a real closed loop (plan line 194).
 */

import { describe, expect, it, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentDriver,
	assertWorkspaceWritable,
	configDigest,
	FakeAgentDriver,
	makeAgentExecutor,
	prepareCaseWorkspace,
	runAgentEval,
	runPairedAgentEval,
} from "./agent-executor.ts";
import { artifactResult, proxyExecutor } from "./types.ts";
import { replayWorkspaceVerifier } from "./workspace-evidence.ts";
import { executeToolCall } from "./agent-tools.ts";
import { applyPatchToTree, buildManifest as buildCandidateManifest, makePatch, skillTreeDigest } from "../evolution/skill-patch.ts";
import { computeBenchmarkContentDigest, computeBenchmarkSplitDigests } from "./loader.ts";
import { buildManifest as buildBenchmarkManifest } from "../benchmark/schema.ts";
import { NativeSessionDriver } from "./native-session-driver.ts";

/** A fake `--mode json` stream from one native session run. */
const NATIVE_STREAM = [
	JSON.stringify({ type: "session", id: "session-1", ocsidMode: "researcher" }),
	JSON.stringify({
		type: "agent_end",
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: "candidate guidance" }],
			provider: "openai-codex",
			model: "gpt-5.5",
			usage: { input: 10, output: 5, totalTokens: 15 },
		}],
	}),
].join("\n") + "\n";

function nativeFixtureDriver(): NativeSessionDriver {
	return new NativeSessionDriver({
		launcher: { launch: async () => ({ code: 0, timedOut: false, aborted: false, stdout: NATIVE_STREAM, stderr: "" }) },
	});
}

/** One native session run against a real benchmark tree, labelled as its own run kind. */
test("native session driver runs score as native run kinds with session identity in the ledger", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-eval-"));
	const benchmarkRoot = path.join(root, "bench");
	const skillRoot = root;
	const qualityDir = path.join(root, "quality");
	try {
		const caseDir = path.join(skillRoot, "skill-a", "test-cases", "c1");
		fs.mkdirSync(caseDir, { recursive: true });
		fs.mkdirSync(benchmarkRoot, { recursive: true });
		fs.writeFileSync(path.join(skillRoot, "skill-a", "SKILL.md"), "guide\n");
		fs.writeFileSync(path.join(caseDir, "user_request.txt"), "Use the skill.\n");
		fs.writeFileSync(path.join(caseDir, "assertions.json"), JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["candidate guidance"] }));
		const splits = { train: ["skill-a"], dev: [], heldout: [] };
		fs.writeFileSync(path.join(benchmarkRoot, "manifest.json"), JSON.stringify({
			...buildBenchmarkManifest("native-fixture", "2026-01-01T00:00:00Z", [{ skillId: "skill-a", split: "train" }]),
			contentHash: computeBenchmarkContentDigest(skillRoot, splits),
			contentHashes: computeBenchmarkSplitDigests(skillRoot, splits),
		}));
		const config = {
			model: "gpt-5.5", maxRounds: 1, maxToolCalls: 1, wallMs: 1000, tokenBudget: 1000,
			toolAllowlist: ["read_file" as const], writeDirs: ["@workspace/output"], networkPolicy: "all" as const,
		};
		const result = await runAgentEval({
			benchmarkRoot, qualityDir, runId: "native-run", skillId: "skill-a", caseId: "c1",
			skillRoot, driver: nativeFixtureDriver(), config,
		});
		expect(result.runKind).toBe("native-agent-eval");
		expect(result.executor).toBe("agent-native");
		expect(result.nativeSession).toEqual({ sessionId: "session-1", mode: "researcher", provider: "openai-codex", model: "gpt-5.5" });
		const summary = JSON.parse(fs.readFileSync(result.summaryPath, "utf8"));
		expect(summary.kind).toBe("native-agent-eval");
		expect(summary.note).toContain("runtime=native-session");
		expect(summary.note).toContain("nativeSession=session-1 mode=researcher runtime=openai-codex/gpt-5.5");

		// Held-out acceptance needs the native runtime, and is labelled separately.
		const heldoutSplits = { train: [], dev: [], heldout: ["skill-a"] };
		fs.writeFileSync(path.join(benchmarkRoot, "manifest.json"), JSON.stringify({
			...buildBenchmarkManifest("native-fixture", "2026-01-01T00:00:00Z", [{ skillId: "skill-a", split: "heldout" }]),
			contentHash: computeBenchmarkContentDigest(skillRoot, heldoutSplits),
			contentHashes: computeBenchmarkSplitDigests(skillRoot, heldoutSplits),
		}));
		const heldout = await runAgentEval({
			benchmarkRoot, qualityDir, runId: "native-heldout-run", skillId: "skill-a", caseId: "c1",
			skillRoot, driver: nativeFixtureDriver(), config, acceptance: "heldout",
		});
		expect(heldout.runKind).toBe("native-heldout-acceptance");
		expect(JSON.parse(fs.readFileSync(heldout.summaryPath, "utf8")).note).toContain("POST-FREEZE HELD-OUT ACCEPTANCE");
		await expect(runAgentEval({
			benchmarkRoot, qualityDir, runId: "api-heldout-run", skillId: "skill-a", caseId: "c1", skillRoot,
			acceptance: "heldout", config,
			driver: { name: "api", async run({ workspace }) {
				fs.writeFileSync(path.join(workspace.root, "output", "r.txt"), "x");
				return artifactResult("candidate guidance");
			} },
		})).rejects.toThrow(/heldout.*native-session runtime/);

		// An ad-hoc native case needs no benchmark tree at all; assertions come from
		// the caller, so a graded L3 row still exists (an empty assertions list would
		// leave the ledger empty — an L2 smoke, not a scored run).
		const adhoc = await runAgentEval({
			qualityDir, runId: "native-adhoc-run", skillId: "skill-a", caseId: "creator-case", skillRoot,
			driver: nativeFixtureDriver(), config,
			adhocCase: { skillId: "skill-a", caseId: "creator-case", userRequest: "Use the skill.\n", assertionsText: JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["candidate guidance"] }) },
		});
		expect(adhoc.runKind).toBe("native-agent-eval");
		expect(fs.readFileSync(adhoc.ledgerPath, "utf8").trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(fs.readFileSync(adhoc.ledgerPath, "utf8").trim()).score).toBe(1);
		const unasserted = await runAgentEval({
			qualityDir, runId: "native-unasserted-run", skillId: "skill-a", caseId: "creator-case", skillRoot,
			driver: nativeFixtureDriver(), config,
			adhocCase: { skillId: "skill-a", caseId: "creator-case", userRequest: "Use the skill.\n" },
		});
		expect(fs.readFileSync(unasserted.ledgerPath, "utf8")).toBe("");
		await expect(runAgentEval({
			qualityDir, runId: "no-benchmark-run", skillId: "skill-a", caseId: "c1", skillRoot,
			driver: nativeFixtureDriver(), config,
		})).rejects.toThrow(/benchmarkRoot is required unless adhocCase is provided/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** Build a tiny local skill tree with one case + one skill file. */
function makeSkillFixture(): { skillRoot: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-fixture-"));
	const skillDir = path.join(root, "skill-a");
	const casesDir = path.join(skillDir, "test-cases", "c1");
	const srcDir = path.join(skillDir, "src");
	fs.mkdirSync(casesDir, { recursive: true });
	fs.mkdirSync(srcDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), "guide: do the thing\n");
	fs.writeFileSync(path.join(srcDir, "helper.js"), "export const ok = 1;\n");
	fs.writeFileSync(path.join(casesDir, "user_request.txt"), "Make it work.\n");
	fs.writeFileSync(path.join(casesDir, "assertions.json"), JSON.stringify({ assertions: [] }));
	return {
		skillRoot: root,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

const caseRecord = {
	skillId: "skill-a",
	caseId: "c1",
	files: {
		userRequest: "Make it work.\n",
		assertionsText: JSON.stringify({ assertions: [] }),
	},
};

test("prepareCaseWorkspace copies a skill snapshot and excludes test-cases", () => {
	const fx = makeSkillFixture();
	try {
		const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
		try {
			expect(fs.existsSync(path.join(ws.skillSnapshotDir, "SKILL.md"))).toBe(true);
			expect(fs.existsSync(path.join(ws.skillSnapshotDir, "src", "helper.js"))).toBe(true);
			// Test material is never snapshotted.
			expect(fs.existsSync(path.join(ws.skillSnapshotDir, "test-cases"))).toBe(false);
			// The case's user request is injected.
			expect(fs.readFileSync(ws.userRequestPath, "utf8")).toBe("Make it work.\n");
			expect(ws.environmentDigest).toMatch(/^[a-f0-9]{64}$/);
			// Each case gets an independent root.
			const ws2 = prepareCaseWorkspace(fx.skillRoot, caseRecord);
			try {
				expect(ws2.root).not.toBe(ws.root);
			} finally {
				ws2.cleanup();
			}
		} finally {
			ws.cleanup();
		}
	} finally {
		fx.cleanup();
	}
});

test("cleanup removes the workspace root", () => {
	const fx = makeSkillFixture();
	try {
		const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
		expect(fs.existsSync(ws.root)).toBe(true);
		ws.cleanup();
		expect(fs.existsSync(ws.root)).toBe(false);
	} finally {
		fx.cleanup();
	}
});

test("prepareCaseWorkspace refuses a benchmark-only tree without a skill definition", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-cases-only-"));
	try {
		fs.mkdirSync(path.join(root, "skill-a", "test-cases", "c1"), { recursive: true });
		expect(() => prepareCaseWorkspace(root, caseRecord)).toThrow(/SKILL\.md/);
		fs.mkdirSync(path.join(root, "skill-a", "SKILL.md"));
		expect(() => prepareCaseWorkspace(root, caseRecord)).toThrow(/SKILL\.md.*file/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("prepareCaseWorkspace copies the verified candidate snapshot, not the parent skill", () => {
	const fx = makeSkillFixture();
	const candidateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-candidate-"));
	try {
		fs.writeFileSync(path.join(candidateRoot, "SKILL.md"), "candidate: new guidance\n");
		const candidateDigest = skillTreeDigest(candidateRoot);
		const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord, {
			sourceSkillDir: candidateRoot,
			expectedSkillDigest: candidateDigest,
		});
		try {
			expect(fs.readFileSync(path.join(ws.skillSnapshotDir, "SKILL.md"), "utf8")).toBe("candidate: new guidance\n");
			expect(skillTreeDigest(ws.skillSnapshotDir)).toBe(candidateDigest);
		} finally {
			ws.cleanup();
		}
		fs.writeFileSync(path.join(candidateRoot, "SKILL.md"), "tampered\n");
		expect(() => prepareCaseWorkspace(fx.skillRoot, caseRecord, {
			sourceSkillDir: candidateRoot,
			expectedSkillDigest: candidateDigest,
		})).toThrow(/digest/i);
	} finally {
		fx.cleanup();
		fs.rmSync(candidateRoot, { recursive: true, force: true });
	}
});

test("an AgentDriver receives only the public case input, never assertions", async () => {
	const fx = makeSkillFixture();
	try {
		const driver: AgentDriver = {
			name: "input-boundary-test",
			async run(opts) {
				expect(opts).not.toHaveProperty("caseRecord");
				expect(opts.caseInput).toEqual({ skillId: "skill-a", caseId: "c1", userRequest: "Make it work.\n" });
				return artifactResult("done");
			},
		};
		const executor = makeAgentExecutor(fx.skillRoot, driver, {
			model: "fake/test", maxRounds: 1, maxToolCalls: 1, wallMs: 1000, tokenBudget: 1000,
			toolAllowlist: [], writeDirs: [], networkPolicy: "none",
		});
		await executor.execute(caseRecord);
	} finally {
		fx.cleanup();
	}
});

test("wallMs is enforced: a hung driver yields a timed-out result instead of hanging the run", async () => {
	const fx = makeSkillFixture();
	try {
		let sawSignal: AbortSignal | undefined;
		let aborted = false;
		const driver: AgentDriver = {
			name: "hanging-driver",
			// Never resolves: the interface cannot force a driver to stop, so the
			// executor must stop WAITING on its own.
			run(opts) {
				sawSignal = opts.signal;
				opts.signal?.addEventListener("abort", () => {
					aborted = true;
				});
				return new Promise<never>(() => {});
			},
		};
		const executor = makeAgentExecutor(fx.skillRoot, driver, {
			model: "fake/test", maxRounds: 1, maxToolCalls: 1, wallMs: 50, tokenBudget: 1000,
			toolAllowlist: [], writeDirs: [], networkPolicy: "none",
		});

		const started = Date.now();
		const result = await executor.execute(caseRecord);
		// Must not wait for the driver: wallMs is documented as a HARD budget and is
		// hashed into configDigest, so an unenforced value was an attested lie.
		expect(Date.now() - started).toBeLessThan(5000);
		expect(result.status).toBe("timed-out");
		expect(result.errorKind).toBe("timeout");
		expect(result.artifact).toBeNull();
		expect(result.error).toMatch(/wall-clock budget/);
		// The optional signal is offered so a cooperative driver can stop cleanly.
		expect(sawSignal).toBeInstanceOf(AbortSignal);
		expect(aborted).toBe(true);
	} finally {
		fx.cleanup();
	}
});

test("a run reporting usage over its declared budget is flagged, not filed as a clean success", async () => {
	const fx = makeSkillFixture();
	try {
		const budgetConfig = {
			model: "fake/test", maxRounds: 1, maxToolCalls: 4, wallMs: 1000, tokenBudget: 100,
			toolAllowlist: [], writeDirs: [], networkPolicy: "none" as const,
		};

		// Over budget on both enforceable axes.
		const overDriver: AgentDriver = {
			name: "over-budget-driver",
			async run() {
				return { ...artifactResult("done"), usage: { modelCalls: 1, toolCalls: 99, inputTokens: 10, outputTokens: 200 } };
			},
		};
		const over = await makeAgentExecutor(fx.skillRoot, overDriver, budgetConfig).execute(caseRecord);
		// maxToolCalls/tokenBudget are hashed into configDigest as sampling
		// constraints; a run that broke one is not a compliant sample.
		expect(over.status).toBe("failed");
		expect(over.errorKind).toBe("other");
		expect(over.error).toMatch(/toolCalls 99 > maxToolCalls 4/);
		expect(over.error).toMatch(/totalTokens 210 > tokenBudget 100/);

		// Same driver, within budget → still a success (no false positive).
		const okDriver: AgentDriver = {
			name: "in-budget-driver",
			async run() {
				return { ...artifactResult("done"), usage: { modelCalls: 1, toolCalls: 3, inputTokens: 10, outputTokens: 10 } };
			},
		};
		const ok = await makeAgentExecutor(fx.skillRoot, okDriver, budgetConfig).execute(caseRecord);
		expect(ok.status).toBe("succeeded");
	} finally {
		fx.cleanup();
	}
});

test("agent evaluation executes the candidate tree named by its manifest and records its digest", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-candidate-run-"));
	try {
		const benchmarkRoot = path.join(root, "benchmark-v1");
		const caseDir = path.join(root, "skill-a", "test-cases", "c1");
		const liveParent = path.join(root, "live");
		const liveSkill = path.join(liveParent, "skill-a");
		const stagedRoot = path.join(root, "staged");
		const qualityDir = path.join(root, "quality");
		fs.mkdirSync(caseDir, { recursive: true });
		fs.mkdirSync(benchmarkRoot, { recursive: true });
		fs.mkdirSync(liveSkill, { recursive: true });
		fs.writeFileSync(path.join(caseDir, "user_request.txt"), "Use the skill.\n");
		fs.writeFileSync(path.join(caseDir, "assertions.json"), JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["candidate guidance"] }));
		fs.writeFileSync(path.join(liveSkill, "SKILL.md"), "parent guidance\n");
		const splits = { train: ["skill-a"], dev: [], heldout: [] };
		const manifest = buildBenchmarkManifest("candidate-fixture", "2026-01-01T00:00:00Z", [{ skillId: "skill-a", split: "train" }]);
		fs.writeFileSync(path.join(benchmarkRoot, "manifest.json"), JSON.stringify({
			...manifest,
			contentHash: computeBenchmarkContentDigest(root, splits),
			contentHashes: computeBenchmarkSplitDigests(root, splits),
		}));
		const parentSkillDigest = skillTreeDigest(liveSkill);
		const patch = makePatch([{ kind: "write", path: "SKILL.md", content: "candidate guidance\n" }]);
		const applied = applyPatchToTree(liveSkill, patch.ops, parentSkillDigest, stagedRoot);
		const candidate = buildCandidateManifest({
			targetSkillId: "skill-a", parentSkillDigest, patchDigest: patch.patchDigest,
			resultSkillDigest: applied.resultSkillDigest, author: "test", reason: "candidate test",
		});
		const manifestFile = path.join(root, "candidate.json");
		fs.writeFileSync(manifestFile, JSON.stringify(candidate));
		let gradedWorkspace: string | undefined;
		const driver: AgentDriver = {
			name: "snapshot-reader",
			async run({ workspace }) {
				const skillText = fs.readFileSync(path.join(workspace.skillSnapshotDir, "SKILL.md"), "utf8");
				fs.writeFileSync(path.join(workspace.root, "output", "result.json"), JSON.stringify({ count: skillText.includes("candidate") ? 3 : 0 }));
				gradedWorkspace = workspace.root;
				return artifactResult(skillText);
			},
		};
		const verifierFile = path.join(root, "private-verifier.json");
		fs.writeFileSync(verifierFile, JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [
			{ type: "file-exists", path: "output/result.json" },
			{ type: "json-number-range", path: "output/result.json", key: "count", min: 2, max: 4 },
		] }));
		const opts = {
			benchmarkRoot, qualityDir, runId: "candidate-run", skillId: "skill-a", caseId: "c1",
			skillRoot: liveParent, candidate: { manifestFile, stagedRoot }, driver, verifierFile,
			config: { model: "fake/test", maxRounds: 1, maxToolCalls: 1, wallMs: 1000, tokenBudget: 1000,
				toolAllowlist: [], writeDirs: [], networkPolicy: "none" as const },
		};
		const result = await runAgentEval(opts);
		expect(result.runKind).toBe("candidate-agent-eval");
		expect(result.candidateId).toBe(candidate.candidateId);
		expect(result.candidateSha256).toBe(candidate.resultSkillDigest);
		const ledger = JSON.parse(fs.readFileSync(result.ledgerPath, "utf8").trim());
		expect(ledger.candidateSha256).toBe(candidate.resultSkillDigest);
		expect(ledger.artifactSha256).toBe(artifactResult("candidate guidance\n").artifactSha256);
		expect(ledger.gradedBy).toBe("assertion");
		expect(ledger.score).toBe(1);
		expect(result.verifierSha256).toMatch(/^[0-9a-f]{64}$/);
		const evidence = JSON.parse(fs.readFileSync(result.diagnosticEvidencePath, "utf8"));
		expect(evidence).toMatchObject({ runId: "candidate-run", caseId: "c1", skillDigest: candidate.resultSkillDigest, score: 1 });
		// P1-02: the graded output/ is archived, and the verdict replays after the
		// temporary workspace that produced it has been deleted.
		expect(result.workspaceEvidencePath).toBeDefined();
		expect(evidence.evidenceRefs).toContain(result.workspaceEvidencePath);
		expect(gradedWorkspace).toBeDefined();
		expect(fs.existsSync(gradedWorkspace as string)).toBe(false);
		const replay = replayWorkspaceVerifier(path.dirname(result.ledgerPath));
		expect(replay.consistent).toBe(true);
		expect(replay.mismatches).toEqual([]);
		expect(replay.replayed).toEqual(replay.recorded);
		expect(replay.fileCount).toBe(1);
		const paired = await runPairedAgentEval({ ...opts, runId: "paired-run" });
		expect([paired.parentScore, paired.candidateScore, paired.delta]).toEqual([0.5, 1, 0.5]);
		expect(paired.parent.configDigest).toBe(paired.candidate.configDigest);
		const failed = await runAgentEval({ ...opts, runId: "failed-model-run", driver: {
			name: "failing-model",
			async run() { throw new Error("model endpoint returned HTTP 401: Invalid token"); },
		} });
		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("HTTP 401: Invalid token");
		expect(JSON.parse(fs.readFileSync(failed.diagnosticEvidencePath, "utf8")).score).toBeNull();
		const summary = JSON.parse(fs.readFileSync(result.summaryPath, "utf8"));
		expect(summary.kind).toBe("candidate-agent-eval");
		expect(summary.perSplit["skill-a:train"]).toBe(1);
		await expect(runAgentEval({ ...opts, runId: "fake-run", driver: new FakeAgentDriver() })).rejects.toThrow(/real AgentDriver/);
		fs.writeFileSync(path.join(stagedRoot, "SKILL.md"), "tampered\n");
		await expect(runAgentEval({ ...opts, runId: "tampered-run" })).rejects.toThrow(/digest/i);
		expect(fs.existsSync(path.join(qualityDir, "audit", "tampered-run"))).toBe(false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("workspace output token permits a file and rejects a symlinked parent", async () => {
	const fx = makeSkillFixture();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-outside-"));
	try {
		const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
		try {
			const config = { model: "test", maxRounds: 1, maxToolCalls: 1, wallMs: 1000, tokenBudget: 1000,
				toolAllowlist: ["write_file"], writeDirs: ["@workspace/output"], networkPolicy: "none" as const };
			const context = { workspace: ws, config };
			const good = await executeToolCall("write_file", JSON.stringify({ path: "output/result.json", content: "ok" }), context);
			expect(good.trace.status).toBe("ok");
			expect(fs.readFileSync(path.join(ws.root, "output", "result.json"), "utf8")).toBe("ok");
			let linked = false;
			try {
				fs.symlinkSync(outside, path.join(ws.root, "output", "linked"), "junction");
				linked = true;
			} catch { /* symlink creation may be unavailable */ }
			if (linked) {
				const bad = await executeToolCall("write_file", JSON.stringify({ path: "output/linked/escape.txt", content: "no" }), context);
				expect(bad.trace.status).toBe("error");
				expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
			}
		} finally { ws.cleanup(); }
	} finally {
		fx.cleanup();
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("FakeAgentDriver returns a succeeded result with honest simulated usage", async () => {
	const fx = makeSkillFixture();
	try {
		const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
		try {
			const driver = new FakeAgentDriver();
			const res = await driver.run({
				workspace: ws,
				caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "Make it work.\n" },
				config: {
					model: "fake/test",
					maxRounds: 1,
					maxToolCalls: 1,
					wallMs: 1,
					tokenBudget: 1000,
					toolAllowlist: [],
					writeDirs: [],
					networkPolicy: "none",
				},
				startedAt: "2026-01-01T00:00:00.000Z",
			});
			expect(res.schema).toBe("ocsid.execution-result.v1");
			expect(res.status).toBe("succeeded");
			expect(res.artifact).toBe("Make it work.\n");
			expect(res.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(res.usage).toMatchObject({
				modelCalls: 1,
				inputTokens: 512,
				outputTokens: 128,
				totalTokens: 640,
			});
			expect(res.model).toBe("fake/test");
			expect(res.configDigest).toBeDefined();
			expect(res.environmentDigest).toBe(ws.environmentDigest);
		} finally {
			ws.cleanup();
		}
	} finally {
		fx.cleanup();
	}
});

test("makeAgentExecutor runs the fake driver through the CaseExecutor contract", async () => {
	const fx = makeSkillFixture();
	try {
		const executor = makeAgentExecutor(fx.skillRoot, new FakeAgentDriver(), {
			model: "fake/exec",
			maxRounds: 4,
			maxToolCalls: 4,
			wallMs: 5000,
			tokenBudget: 8000,
			toolAllowlist: [],
			writeDirs: [],
			networkPolicy: "none",
		});
		const res = await executor.execute(caseRecord);
		expect(res.status).toBe("succeeded");
		expect(res.usage?.modelCalls).toBe(1);
		// The executor cleans up the workspace after running; nothing leaks.
		expect(fs.readdirSync(fx.skillRoot).filter((n) => n.startsWith("arex-ocsid-case-"))).toEqual([]);
	} finally {
		fx.cleanup();
	}
});

test("makeAgentExecutor rejects a driver whose write dir escapes the workspace", async () => {
	const fx = makeSkillFixture();
	try {
		const executor = makeAgentExecutor(fx.skillRoot, new FakeAgentDriver(), {
			model: "fake/exec",
			maxRounds: 1,
			maxToolCalls: 1,
			wallMs: 1000,
			tokenBudget: 1000,
			toolAllowlist: [],
			writeDirs: [path.join(os.tmpdir(), "elsewhere")],
			networkPolicy: "none",
		});
		await expect(executor.execute(caseRecord)).rejects.toThrow(/escapes the case workspace/);
		// On rejection the temp workspace must still be cleaned up.
		expect(fs.readdirSync(fx.skillRoot).filter((n) => n.startsWith("arex-ocsid-case-"))).toEqual([]);
	} finally {
		fx.cleanup();
	}
});

test("makeAgentExecutor rejects a `..` traversal write dir that lexically stays under root", async () => {
	const fx = makeSkillFixture();
	try {
		const executor = makeAgentExecutor(fx.skillRoot, new FakeAgentDriver(), {
			model: "fake/exec",
			maxRounds: 1,
			maxToolCalls: 1,
			wallMs: 1000,
			tokenBudget: 1000,
			toolAllowlist: [],
			// <workspace>\..\secret lexically starts with root but resolves outside it.
			writeDirs: [path.join("fake-placeholder", "..", "secret")],
			networkPolicy: "none",
		});
		if (executor.execute && typeof executor.execute === "function") {
			// Drive a real prepare to get the temp root, then assert a traversal
			// entry resolves outside it and is rejected.
			const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
			try {
				const traversal = path.join(ws.root, "..", "secret-dir");
				expect(() => assertWorkspaceWritable(ws, {
					model: "m",
					maxRounds: 1,
					maxToolCalls: 1,
					wallMs: 1000,
					tokenBudget: 1000,
					toolAllowlist: [],
					writeDirs: [traversal],
					networkPolicy: "none",
				})).toThrow(/escapes the case workspace/);
				// A normal in-root subdir is still accepted.
				expect(() => assertWorkspaceWritable(ws, {
					model: "m",
					maxRounds: 1,
					maxToolCalls: 1,
					wallMs: 1000,
					tokenBudget: 1000,
					toolAllowlist: [],
					writeDirs: [path.join(ws.root, "output")],
					networkPolicy: "none",
				})).not.toThrow();
				// The literal root itself is accepted.
				expect(() => assertWorkspaceWritable(ws, {
					model: "m",
					maxRounds: 1,
					maxToolCalls: 1,
					wallMs: 1000,
					tokenBudget: 1000,
					toolAllowlist: [],
					writeDirs: [ws.root],
					networkPolicy: "none",
				})).not.toThrow();
				// The snapshot is INSIDE root but is documented as "read-only for the
				// agent" — granting it as a write dir would let the agent rewrite the
				// tree that the recorded environmentDigest attests to.
				expect(() => assertWorkspaceWritable(ws, {
					model: "m",
					maxRounds: 1,
					maxToolCalls: 1,
					wallMs: 1000,
					tokenBudget: 1000,
					toolAllowlist: [],
					writeDirs: [ws.skillSnapshotDir],
					networkPolicy: "none",
				})).toThrow(/frozen skill snapshot/);
				// A subdirectory of the snapshot is equally refused.
				expect(() => assertWorkspaceWritable(ws, {
					model: "m",
					maxRounds: 1,
					maxToolCalls: 1,
					wallMs: 1000,
					tokenBudget: 1000,
					toolAllowlist: [],
					writeDirs: [path.join(ws.skillSnapshotDir, "sub-skills")],
					networkPolicy: "none",
				})).toThrow(/frozen skill snapshot/);
			} finally {
				ws.cleanup();
			}
		}
	} finally {
		fx.cleanup();
	}
});

test("configDigest is stable across identical configs", () => {
	const a = {
		model: "m",
		maxRounds: 2,
		maxToolCalls: 2,
		wallMs: 10,
		tokenBudget: 100,
		toolAllowlist: [],
		writeDirs: [],
		networkPolicy: "none" as const,
	};
	expect(configDigest(a)).toBe(configDigest({ ...a }));
	expect(configDigest(a)).not.toBe(configDigest({ ...a, model: "n" }));
});

test("proxyExecutor vs agent-flow both satisfy the CaseExecutor contract (B1 seam)", async () => {
	const proxy = proxyExecutor(() => "proxy-artifact");
	const res = await proxy.execute(caseRecord);
	expect(res.status).toBe("succeeded");
	expect(res.artifact).toBe("proxy-artifact");
	// The agent executor exposes the same seam, so the audit runner is agnostic.
	const agentDrives: AgentDriver = new FakeAgentDriver();
	expect(typeof agentDrives.run).toBe("function");
});

// Keep the interface import live for typecheck even if unused at runtime.
describe("interface shape", () => {
	it("exposes a driver name", () => {
		expect(new FakeAgentDriver().name).toBe("fake-agent-driver");
	});
});
