/** P1-04: the controlled reference-addition probe (real runs, deterministic driver). */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, type AgentDriver } from "../audit/agent-executor.ts";
import { REFERENCE_ADDITION_HEADING, applyReference, probeReportPath, runReferenceAdditionProbes, withProbe } from "./probe.ts";

let root: string;
let skillRoot: string;
let assertionsFile: string;
let verifierFile: string;

const REFERENCE = "REFERENCE-MATERIAL: use the reference material verbatim.";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-probe-"));
	// `skillRoot` is the parent of the skill packages (as in the benchmark tree):
	// runAgentEval snapshots `<skillRoot>/<skillId>`.
	skillRoot = root;
	fs.mkdirSync(path.join(root, "skill-a"), { recursive: true });
	fs.writeFileSync(path.join(root, "skill-a", "SKILL.md"), "---\nname: skill-a\n---\n\nA skill under test.\n", "utf8");
	verifierFile = path.join(root, "verifier.json");
	fs.writeFileSync(verifierFile, JSON.stringify({ schema: "ocsid.workspace-verifier.v1", checks: [{ type: "json-number-range", path: "output/result.json", key: "value", min: 1, max: 1 }] }));
	assertionsFile = path.join(root, "assertions.json");
	fs.writeFileSync(
		assertionsFile,
		`${JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["Contains: REFERENCE-MATERIAL", "Exists: answer.md"] }, null, 2)}\n`,
		"utf8",
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function options(pairs = 2) {
	return {
		qualityDir: root,
		episodeId: "ep-1",
		skillId: "skill-a",
		caseId: "case-1",
		skillRoot,
		request: "Answer the question.",
		reference: REFERENCE,
		pairs,
		assertionsFile,
		verifierFile,
		config: { ...DEFAULT_AGENT_CONFIG, model: "test/model", wallMs: 60_000, tokenBudget: 100_000 },
	};
}

/**
 * A driver that behaves like a real agent only in the "after" leg: the added
 * reference is what changes its output, which is exactly what a controlled
 * reference-addition probe is supposed to measure.
 */
function referenceDriver(seen: string[]): () => AgentDriver {
	return () => ({
		name: "test-reference-driver",
		async run({ workspace, caseInput, startedAt }) {
			const withReference = caseInput.userRequest.includes(REFERENCE_ADDITION_HEADING);
			seen.push(withReference ? "after" : "before");
			fs.mkdirSync(path.join(workspace.root, "output"), { recursive: true });
			// The reference material names every required token, so an agent that
			// actually used it satisfies the case's assertions; one that ignored it
			// produces an unrelated blob (which the deterministic grader fails).
			const text = withReference ? "Contains: REFERENCE-MATERIAL\nExists: answer.md\n" : "unrelated output\n";
			fs.writeFileSync(path.join(workspace.root, "output", "answer.md"), text, "utf8");
			fs.writeFileSync(path.join(workspace.root, "output", "result.json"), JSON.stringify({ value: withReference ? 1 : 0 }));
			return {
				schema: "ocsid.execution-result.v1" as const,
				status: "succeeded" as const,
				artifact: text,
				artifactSha256: createHash("sha256").update(text).digest("hex"),
				usage: { modelCalls: 1, totalTokens: 12, toolCalls: 1, wallMs: 5 },
				startedAt,
				endedAt: new Date().toISOString(),
			};
		},
	});
}

describe("reference-addition probe", () => {
	it("runs paired before/after legs and reports the gain U0 reads", async () => {
		const seen: string[] = [];
		const result = await runReferenceAdditionProbes({ ...options(), driverFactory: referenceDriver(seen) });
		expect(seen).toEqual(["before", "after", "before", "after"]);
		expect(result.report.schema).toBe("ocsid.probe-report.v1");
		expect(result.report.controlled).toBe(true);
		expect(result.report.reason).toBe("");
		// The added reference is the only difference between the legs, and the
		// grader is deterministic, so the before score is a fixed number — but the
		// assertion here is the RELATION (the reference strictly helped), not a
		// magic constant borrowed from the grader's token arithmetic.
		expect(result.report.before).toEqual([0, 0]);
		expect(result.report.after).toEqual([1, 1]);
		expect(result.report.meanGain).toBe(1);
		expect(result.report.pairs.map((pair) => pair.gain)).toEqual([1, 1]);
		expect(result.report.minimumPairs).toBe(2);
		expect(result.report.minimumMeanGain).toBe(0.25);
		expect(result.probe).toMatchObject({ kind: "reference-addition", controlled: true, before: [0, 0], after: [1, 1] });
		expect(result.reportPath).toBe(probeReportPath(root, "ep-1"));
		expect(JSON.parse(fs.readFileSync(result.reportPath, "utf8"))).toEqual(result.report);
		// Each leg is a real persisted run: a diagnostic evidence file and a ledger row.
		expect(result.report.evidenceRefs).toHaveLength(8);
		for (const ref of result.report.evidenceRefs) expect(fs.existsSync(ref)).toBe(true);
		expect(result.usage.totalTokens).toBe(48);
	});

	it("marks the probe uncontrolled when a leg dies instead of inventing a zero", async () => {
		let call = 0;
		const result = await runReferenceAdditionProbes({
			...options(1),
			driverFactory: () => ({
				name: "flaky-driver",
				async run() {
					call += 1;
					throw new Error(`endpoint refused (call ${call})`);
				},
			}),
		});
		expect(result.report.controlled).toBe(false);
		expect(result.report.meanGain).toBeNull();
		expect(result.report.reason).toMatch(/did not succeed/);
		expect(result.report.before).toEqual([]);
		expect(result.report.after).toEqual([]);
	});

	it("marks the probe uncontrolled when a leg produces no graded score", async () => {
		const result = await runReferenceAdditionProbes({
			...options(1),
			driverFactory: () => ({
				name: "silent-driver",
				async run({ startedAt }) {
					return {
						schema: "ocsid.execution-result.v1" as const,
						status: "succeeded" as const,
						artifact: null,
						artifactSha256: null,
						usage: { modelCalls: 1 },
						startedAt,
						endedAt: new Date().toISOString(),
					};
				},
			}),
		});
		expect(result.report.controlled).toBe(false);
		expect(result.report.reason).toMatch(/no graded score|did not succeed/);
	});

	it("refuses nonsense probe requests instead of writing a meaningless report", async () => {
		await expect(runReferenceAdditionProbes({ ...options(1), reference: "   ", driverFactory: referenceDriver([]) })).rejects.toThrow(/non-empty reference/);
		await expect(runReferenceAdditionProbes({ ...options(0), driverFactory: referenceDriver([]) })).rejects.toThrow(/at least one paired repetition/);
		await expect(runReferenceAdditionProbes({ ...options(1), episodeId: "not an id", driverFactory: referenceDriver([]) })).rejects.toThrow(/episodeId/);
		expect(fs.existsSync(probeReportPath(root, "ep-1"))).toBe(false);
	});

	it("appends the reference so the after leg differs only by that material", () => {
		const before = "Do the task.";
		const after = applyReference(before, REFERENCE);
		expect(after.startsWith("Do the task.\n\n")).toBe(true);
		expect(after).toContain(REFERENCE_ADDITION_HEADING);
		expect(after.endsWith(`${REFERENCE}\n`)).toBe(true);
	});

	it("attaches the probe to the diagnosis evidence", () => {
		const evidence = {
			schema: "ocsid.diagnostic-evidence.v1" as const,
			runId: "run-1",
			caseId: "case-1",
			skillId: "skill-a",
			skillDigest: "a".repeat(64),
			score: 0.5,
			executionStatus: "succeeded" as const,
			evidenceRefs: ["ledger.jsonl"],
			probeBudgetAvailable: false,
		};
		const withProbeEvidence = withProbe(evidence, { kind: "reference-addition", controlled: true, evidenceRef: "probe-report.json", before: [0.5], after: [1] });
		expect(withProbeEvidence.probeBudgetAvailable).toBe(true);
		expect(withProbeEvidence.probe?.after).toEqual([1]);
		expect(evidence.probeBudgetAvailable).toBe(false);
	});
});
