/**
 * P1-04: the episode runner as a whole — evidence -> probe -> diagnosis ->
 * candidate -> regression -> acceptance -> awaiting-approval.
 *
 * The driver here is deterministic but NOT a stub of the pipeline: it runs the
 * real `runAgentEval`/`runReferenceAdditionProbes` path (workspaces, ledgers,
 * diagnostic evidence, candidate snapshots). It only decides what text to emit,
 * based on the skill snapshot and the probe reference it is handed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, type AgentDriver } from "../audit/agent-executor.ts";
import type { DiagnosticEvidence } from "./diagnostic-policy.ts";
import { runEpisode, episodeProbeEvidencePath } from "./episode-run.ts";
import { readEpisode } from "./episode.ts";
import { REFERENCE_ADDITION_HEADING } from "./probe.ts";
import { skillTreeDigest } from "./skill-patch.ts";

let root: string;
let skillRoot: string;
let liveSkillRoot: string;
let assertionsFile: string;
let patchFile: string;
let verifierFile: string;
let evidence: DiagnosticEvidence;

const REFERENCE = "REFERENCE-MATERIAL: the reference material names the required tokens.";
const ASSERTED_TEXT = "Contains: REFERENCE-MATERIAL\nExists: answer.md\n";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-episode-run-"));
	// runAgentEval snapshots <skillRoot>/<skillId>.
	skillRoot = root;
	liveSkillRoot = path.join(root, "skill-a");
	fs.mkdirSync(liveSkillRoot, { recursive: true });
	fs.writeFileSync(
		path.join(liveSkillRoot, "SKILL.md"),
		["---", "name: skill-a", 'description: "A skill under test."', "---", "", "# skill-a", "", "source-v1", ""].join("\n"),
		"utf8",
	);
	assertionsFile = path.join(root, "assertions.json");
	fs.writeFileSync(
		assertionsFile,
		`${JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["Contains: REFERENCE-MATERIAL", "Exists: answer.md"] }, null, 2)}\n`,
		"utf8",
	);
	verifierFile = path.join(root, "verifier.json");
	fs.writeFileSync(verifierFile, JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [{ type: "json-number-range", path: "output/result.json", key: "value", min: 1, max: 1 }] }));
	patchFile = path.join(root, "patch.json");
	fs.writeFileSync(
		patchFile,
		`${JSON.stringify({ ops: [{ kind: "write", path: "SKILL.md", content: ["---", "name: skill-a", 'description: "A skill under test."', "---", "", "# skill-a", "", "candidate-v1", ""].join("\n") }] }, null, 2)}\n`,
		"utf8",
	);
	evidence = {
		schema: "ocsid.diagnostic-evidence.v1",
		runId: "audit-1",
		caseId: "case-1",
		skillId: "skill-a",
		skillDigest: skillTreeDigest(liveSkillRoot),
		score: 0.25,
		executionStatus: "succeeded",
		evidenceRefs: ["ledger.jsonl"],
		probeBudgetAvailable: false,
	};
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function options(extra: Record<string, unknown> = {}) {
	return {
		qualityDir: root,
		episodeId: "ep-1",
		skillId: "skill-a",
		caseId: "case-1",
		skillRoot,
		evidence,
		request: "Answer the question about the skill.",
		reference: REFERENCE,
		assertionsFile,
		verifierFile,
		patchFile,
		config: { ...DEFAULT_AGENT_CONFIG, model: "test/model", wallMs: 60_000, tokenBudget: 100_000 },
		...extra,
	};
}

interface DriverOptions {
	/** Make the probe's "after" leg fail (empty output) so the probe is uncontrolled. */
	breakProbeLeg?: boolean;
	/** Make the candidate leg score worse than the parent (regression rejection). */
	candidateIsWorse?: boolean;
	/** Score the regression PARENT leg high, to model a true regression. */
	parentRegresses?: boolean;
	/** Mutate the live skill on the first probe leg (the live skill changes mid-episode). */
	mutateLiveOnProbe?: boolean;
}

function drivers(seen: string[], opts: DriverOptions = {}): () => AgentDriver {
	let mutated = false;
	return () => ({
		name: "test-episode-driver",
		async run({ workspace, caseInput, startedAt }) {
			const withReference = caseInput.userRequest.includes(REFERENCE_ADDITION_HEADING);
			const snapshot = fs.readFileSync(path.join(workspace.skillSnapshotDir, "SKILL.md"), "utf8");
			const candidate = snapshot.includes("candidate-v1");
			seen.push(withReference ? "probe-after" : candidate ? "candidate" : "parent");
			if (opts.mutateLiveOnProbe && withReference && !mutated) {
				mutated = true;
				fs.writeFileSync(
					path.join(liveSkillRoot, "SKILL.md"),
					["---", "name: skill-a", 'description: "A skill under test."', "---", "", "# skill-a", "", "moved-on-v2", ""].join("\n"),
					"utf8",
				);
			}
			fs.mkdirSync(path.join(workspace.root, "output"), { recursive: true });
			let text = "unrelated output\n";
			if (withReference) text = opts.breakProbeLeg ? "" : ASSERTED_TEXT;
			else if (candidate) text = opts.candidateIsWorse ? "unrelated output\n" : ASSERTED_TEXT;
			// With two probe pairs the 5th run is the regression parent leg.
			else if (opts.parentRegresses && seen.length === 5) text = ASSERTED_TEXT;
			fs.writeFileSync(path.join(workspace.root, "output", "answer.md"), text, "utf8");
			fs.writeFileSync(path.join(workspace.root, "output", "result.json"), JSON.stringify({ value: text === ASSERTED_TEXT ? 1 : 0 }));
			return {
				schema: "ocsid.execution-result.v1" as const,
				status: "succeeded" as const,
				artifact: text,
				artifactSha256: createHash("sha256").update(text).digest("hex"),
				usage: { modelCalls: 1, totalTokens: 10, toolCalls: 1, wallMs: 5 },
				startedAt,
				endedAt: new Date().toISOString(),
			};
		},
	});
}

describe("RSI episode runner", () => {
	it("walks evidence -> probe -> diagnosis -> candidate -> regression -> awaiting-approval", async () => {
		const seen: string[] = [];
		const result = await runEpisode({ ...options(), driverFactory: drivers(seen) });
		// Two controlled probe pairs, then the paired parent/candidate regression.
		expect(seen).toEqual(["parent", "probe-after", "parent", "probe-after", "parent", "candidate"]);
		expect(result.episode.phase).toBe("awaiting-approval");
		expect(result.episode.terminal).not.toBe(true);
		expect(result.episode.probe).toMatchObject({ kind: "reference-addition", controlled: true, meanGain: 1 });
		expect(result.diagnosis).toMatchObject({ diagnosis: "skill_defect", decision: "patch" });
		expect(result.candidate?.manifest.parentSkillDigest).toBe(evidence.skillDigest);
		expect(result.regression).toMatchObject({ parentMean: 0, candidateMean: 1, delta: 1, regressedCases: [] });
		expect(result.episode.acceptance).toMatchObject({ verdict: "accepted", reasons: [] });
		expect(result.probeReportPath).toBeDefined();
		const probeEvidence = JSON.parse(fs.readFileSync(episodeProbeEvidencePath(root, "ep-1"), "utf8")) as DiagnosticEvidence;
		expect(probeEvidence.probeBudgetAvailable).toBe(true);
		expect(probeEvidence.probe?.controlled).toBe(true);
		// The state on disk is the state we returned, so a crash cannot lose the episode.
		const persisted = readEpisode(root, "ep-1");
		expect(persisted.phase).toBe("awaiting-approval");
		expect(persisted.regression?.delta).toBe(1);
		expect(persisted.budget).toMatchObject({ probePairs: 2, candidates: 1 });
		expect(persisted.steps.map((step) => step.step)).toContain("acceptance");
	});

	it("abstains when the probe is not controlled, without authoring a candidate", async () => {
		const seen: string[] = [];
		const result = await runEpisode({ ...options({ probePairs: 1 }), driverFactory: drivers(seen, { breakProbeLeg: true }) });
		expect(result.episode.phase).toBe("abstained");
		expect(result.episode.stop?.kind).toBe("abstain");
		expect(result.episode.stop?.reason).toMatch(/probe is not controlled/);
		expect(result.candidate).toBeUndefined();
		expect(result.diagnosis).toBeUndefined();
		expect(readEpisode(root, "ep-1").phase).toBe("abstained");
	});

	it("abstains when the acceptance gate rejects a regression", async () => {
		const seen: string[] = [];
		const result = await runEpisode({ ...options(), driverFactory: drivers(seen, { parentRegresses: true, candidateIsWorse: true }) });
		expect(result.regression).toMatchObject({ parentMean: 1, candidateMean: 0, delta: -1, regressedCases: ["case-1"] });
		expect(result.episode.acceptance?.verdict).toBe("rejected");
		expect(result.episode.phase).toBe("abstained");
		expect(result.episode.stop?.reason).toMatch(/acceptance gate rejected the candidate: candidate regressed on case-1/);
	});

	it("abstains when the candidate does not improve the mean score", async () => {
		const seen: string[] = [];
		const result = await runEpisode({ ...options(), driverFactory: drivers(seen, { candidateIsWorse: true }) });
		expect(result.regression).toMatchObject({ parentMean: 0, candidateMean: 0, delta: 0, regressedCases: [] });
		expect(result.episode.acceptance?.verdict).toBe("rejected");
		expect(result.episode.stop?.reason).toMatch(/did not improve the mean score/);
	});

	it("fails when the live skill changes while the episode runs", async () => {
		const seen: string[] = [];
		const result = await runEpisode({ ...options(), driverFactory: drivers(seen, { mutateLiveOnProbe: true }) });
		expect(result.episode.phase).toBe("failed");
		expect(result.episode.stop?.reason).toMatch(/the live skill changed while the episode ran/);
		expect(result.candidate).toBeUndefined();
	});

	it("stops before probing when the episode has no probe budget left", async () => {
		const seen: string[] = [];
		const result = await runEpisode({
			...options({ budget: { maxProbePairs: 0 } }),
			driverFactory: drivers(seen),
		});
		expect(seen).toEqual([]);
		expect(result.episode.stop?.kind).toBe("budget");
		expect(result.episode.stop?.reason).toMatch(/no probe budget left/);
	});
});

function writeRegressionCases(): string {
	const casesRoot = path.join(root, "cases");
	for (const caseId of ["case-1", "case-2"]) {
		const dir = path.join(casesRoot, caseId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "user_request.txt"), `task ${caseId}`);
		fs.copyFileSync(assertionsFile, path.join(dir, "assertions.json"));
		fs.writeFileSync(path.join(dir, "verifier.json"), JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [{ type: "json-number-range", path: "output/result.json", key: "value", min: caseId === "case-1" ? 1 : 2, max: caseId === "case-1" ? 1 : 2 }] }));
	}
	return casesRoot;
}

describe("episode acceptance and execution budget regressions", () => {
	it("rejects an incomplete candidate pair instead of dropping its missing score", async () => {
		const casesRoot = writeRegressionCases();
		const driverFactory = drivers([]);
		const result = await runEpisode({ ...options({ cases: ["case-2"], casesRoot }), driverFactory: () => ({ name: "incomplete-case-driver", async run(input) {
					if (input.caseInput.caseId === "case-2" && fs.readFileSync(path.join(input.workspace.skillSnapshotDir, "SKILL.md"), "utf8").includes("candidate-v1"))
						throw new Error("case-2 failed");
					return driverFactory().run(input);
				} }) });
		expect(result.episode.phase).not.toBe("awaiting-approval");
		expect(result.episode.acceptance?.verdict).toBe("rejected");
		expect(result.episode.acceptance?.reasons.join(" ")).toMatch(/case-2.*(missing|failed|incomplete)/);
	});
	it("does not authorize a patch with proxy-only text scores", async () => {
		const result = await runEpisode({ ...options({ verifierFile: undefined }), driverFactory: drivers([]) });
		expect(result.episode.phase).not.toBe("awaiting-approval");
		expect(result.candidate).toBeUndefined();
		expect(result.episode.stop?.reason).toMatch(/(independent|verifier|score)/);
	});
	it("loads distinct requests and verifier rules for each regression case", async () => {
		const requests: string[] = [];
		const casesRoot = writeRegressionCases();
		const factory = drivers([]);
		const result = await runEpisode({ ...options({ cases: ["case-2"], casesRoot }), driverFactory: () => ({ name: "distinct-case-driver", async run(input) {
					requests.push(input.caseInput.userRequest);
					const output = await factory().run(input);
					return output;
				} }) });
		expect(requests).toContain("task case-1");
		expect(requests).toContain("task case-2");
		expect(result.regression?.cases.find(c => c.caseId === "case-2")?.candidateScore).toBe(0);
	});
	it("refuses extra case IDs without actual case files before spending", async () => {
		const seen: string[] = [];
		await expect(runEpisode({ ...options({ cases: ["case-2"] }), driverFactory: drivers(seen) })).rejects.toThrow(/cases.root/i);
		expect(seen).toEqual([]);
	});
	it("does not start a pair when the shared token budget cannot fund both legs", async () => {
		const seen: string[] = [];
		const result = await runEpisode({ ...options({ budget: { maxTokens: 1 } }), driverFactory: drivers(seen) });
		expect(seen).toEqual([]);
		expect(result.episode.stop?.kind).toBe("budget");
	});
	it("rejects a requested probe count above its remaining allowance before running", async () => {
		const seen: string[] = [];
		const result = await runEpisode({ ...options({ probePairs: 2, budget: { maxProbePairs: 1 } }), driverFactory: drivers(seen) });
		expect(seen).toEqual([]);
		expect(result.episode.stop?.kind).toBe("budget");
	});
	it("can continue after exactly using the allocated probe pairs", async () => {
		const result = await runEpisode({ ...options({ budget: { maxProbePairs: 2 } }), driverFactory: drivers([]) });
		expect(result.episode.phase).toBe("awaiting-approval");
	});
	it("charges each leg and stops before a further regression pair after exhaustion", async () => {
		const configs: Array<{
			tokens: number;
			wallMs: number;
		}> = [];
		const seen: string[] = [];
		const factory = drivers(seen);
		const result = await runEpisode({ ...options({ cases: ["case-2"], casesRoot: writeRegressionCases(), budget: { maxTokens: 60 } }), driverFactory: () => ({ name: "budget-driver", async run(input) {
					configs.push({ tokens: input.config.tokenBudget, wallMs: input.config.wallMs });
					const output = await factory().run(input);
					return { ...output, usage: { ...output.usage, totalTokens: 10 } };
				} }) });
		expect(seen).toHaveLength(6);
		expect(result.episode.budget.tokens).toBe(60);
		expect(configs[4]?.tokens).toBe(10);
		expect(configs[5]?.tokens).toBe(10);
		expect(result.episode.stop?.kind).toBe("budget");
	});
});
