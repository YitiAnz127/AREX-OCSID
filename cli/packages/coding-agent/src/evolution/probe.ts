/**
 * P1-04: the controlled reference-addition probe.
 *
 * The audit found the probe leg of the loop had no executor at all: U0 could
 * only ever abstain (or ask for a probe) because nothing produced
 * `probe.before/after`. Existing helpers do not fill the gap — `runPairedAgentEval`
 * compares a parent skill against its candidate on ONE leg, and `runAgentEval`
 * writes `probeBudgetAvailable: false` and no `probe` block.
 *
 * This module runs the missing experiment: the same case, skill, model, config
 * and verifier, repeated N times with a reference added to the request in the
 * "after" leg only. Any difference between the legs is therefore attributable to
 * the added reference (that is the definition of "controlled" here), and the
 * result is written as a `ocsid.probe-report.v1` next to the episode.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../audit/atomic.ts";
import { assertCanonicalId, assertCaseId } from "../audit/id.ts";
import {
	type AgentDriver,
	type AgentEvalResult,
	type AgentExecutionConfig,
	runAgentEval,
	sumUsage,
} from "../audit/agent-executor.ts";
import type { ExecutionUsage } from "../audit/types.ts";
import { U0_POLICY, type DiagnosticEvidence } from "./diagnostic-policy.ts";
import { episodeDir } from "./episode.ts";

export const PROBE_REPORT_SCHEMA = "ocsid.probe-report.v1" as const;
export const REFERENCE_ADDITION_HEADING = "## Reference material (added probe)";

export interface ProbeLeg {
	role: "before" | "after";
	runId: string;
	score: number | null;
	status: AgentEvalResult["status"];
	configDigest: string | undefined;
	verifierSha256: string | null;
	diagnosticEvidencePath: string;
	ledgerPath: string;
}

export interface ProbePair {
	index: number;
	before: ProbeLeg;
	after: ProbeLeg;
	gain: number | null;
}

export interface ProbeReport {
	schema: typeof PROBE_REPORT_SCHEMA;
	episodeId: string;
	skillId: string;
	caseId: string;
	kind: "reference-addition";
	/** Every leg completed with the same config/verifier and a real score. */
	controlled: boolean;
	/** Why the probe is not controlled (empty when it is). */
	reason: string;
	pairs: ProbePair[];
	meanGain: number | null;
	minimumPairs: number;
	minimumMeanGain: number;
	before: number[];
	after: number[];
	evidenceRefs: string[];
}

export interface ReferenceAdditionProbeOptions {
	qualityDir: string;
	episodeId: string;
	skillId: string;
	caseId: string;
	skillRoot: string;
	/** The case's user request, verbatim. */
	request: string;
	/** Reference material appended for the "after" leg only. */
	reference: string;
	/** Number of paired repetitions; U0 needs at least `U0_POLICY.minimumPairedProbes`. */
	pairs: number;
	config: AgentExecutionConfig;
	/** A fresh driver per leg: a probe leg must not inherit another leg's session. */
	driverFactory: () => AgentDriver;
	assertionsFile?: string;
	assertionsText?: string;
	verifierFile?: string;
	now?: () => Date;
	/** Shared episode reservation and per-leg accounting; standalone probes omit it. */
	executionBudget?: {
		nextPairConfig(): AgentExecutionConfig | undefined;
		canRun(config: AgentExecutionConfig): boolean;
		startPair(): void;
		charge(usage: ExecutionUsage, config: AgentExecutionConfig): void;
	};
}

export interface ReferenceAdditionProbeResult {
	probe: NonNullable<DiagnosticEvidence["probe"]>;
	report: ProbeReport;
	reportPath: string;
	usage: ExecutionUsage;
	budgetStop?: string;
}

/** Append the reference material so the "after" leg is the only thing that differs. */
export function applyReference(request: string, reference: string): string {
	return `${request.trimEnd()}\n\n${REFERENCE_ADDITION_HEADING}\n\n${reference.trimEnd()}\n`;
}

function scoreOf(run: AgentEvalResult): number | null {
	if (!fs.existsSync(run.diagnosticEvidencePath)) return null;
	const evidence = JSON.parse(fs.readFileSync(run.diagnosticEvidencePath, "utf8")) as DiagnosticEvidence;
	return typeof evidence.score === "number" ? evidence.score : null;
}

function legOf(run: AgentEvalResult, role: "before" | "after"): ProbeLeg {
	return {
		role,
		runId: run.runId,
		score: scoreOf(run),
		status: run.status,
		configDigest: run.configDigest,
		verifierSha256: run.verifierSha256,
		diagnosticEvidencePath: run.diagnosticEvidencePath,
		ledgerPath: run.ledgerPath,
	};
}

export function probeReportPath(qualityDir: string, episodeId: string): string {
	return path.join(episodeDir(qualityDir, episodeId), "probe-report.json");
}

/**
 * Run `pairs` controlled repetitions. Each leg is a real agent evaluation that
 * persists its own run, so a probe is auditable rather than a bare number.
 */
export async function runReferenceAdditionProbes(
	options: ReferenceAdditionProbeOptions,
): Promise<ReferenceAdditionProbeResult> {
	assertCanonicalId(options.episodeId, "episodeId");
	assertCanonicalId(options.skillId, "skillId");
	assertCaseId(options.caseId);
	if (!Number.isInteger(options.pairs) || options.pairs < 1) {
		throw new Error(`a probe needs at least one paired repetition (got ${options.pairs})`);
	}
	if (options.reference.trim() === "") throw new Error("reference-addition probe needs non-empty reference material");
	const assertionsText = options.assertionsText ?? (options.assertionsFile
		? fs.readFileSync(path.resolve(options.assertionsFile), "utf8")
		: undefined);

	const pairs: ProbePair[] = [];
	const evidenceRefs: string[] = [];
	const usages: (ExecutionUsage | undefined)[] = [];
	let budgetStop: string | undefined;
	pairLoop: for (let index = 1; index <= options.pairs; index += 1) {
		const config = options.executionBudget ? options.executionBudget.nextPairConfig() : options.config;
		if (!config) {
			budgetStop = "shared budget cannot fund another paired probe";
			break;
		}
		options.executionBudget?.startPair();
		const legs: ProbeLeg[] = [];
		for (const role of ["before", "after"] as const) {
			if (options.executionBudget && !options.executionBudget.canRun(config)) {
				budgetStop = `shared budget spent before probe ${index} ${role}`;
				break pairLoop;
			}
			const run = await runAgentEval({
				qualityDir: options.qualityDir,
				runId: `${options.episodeId}-p${index}-${role}`,
				skillId: options.skillId,
				caseId: options.caseId,
				skillRoot: path.resolve(options.skillRoot),
				...(options.verifierFile ? { verifierFile: path.resolve(options.verifierFile) } : {}),
				config,
				driver: options.driverFactory(),
				adhocCase: {
					skillId: options.skillId,
					caseId: options.caseId,
					userRequest: role === "before" ? options.request : applyReference(options.request, options.reference),
					...(assertionsText !== undefined ? { assertionsText } : {}),
				},
			});
			usages.push(run.usage);
			options.executionBudget?.charge(run.usage, config);
			legs.push(legOf(run, role));
			evidenceRefs.push(run.diagnosticEvidencePath, run.ledgerPath);
		}
		const before = legs[0];
		const after = legs[1];
		if (!before || !after) throw new Error("probe leg bookkeeping failed");
		pairs.push({
			index,
			before,
			after,
			gain: before.score !== null && after.score !== null ? after.score - before.score : null,
		});
	}

	// Controlled means: every leg actually ran under the SAME configuration and
	// verifier and produced a score. A missing score is not a zero.
	const reasons: string[] = [];
	if (budgetStop) reasons.push(budgetStop);
	const notSucceeded = pairs.flatMap((pair) => [pair.before, pair.after]).filter((leg) => leg.status !== "succeeded");
	if (notSucceeded.length > 0) reasons.push(`${notSucceeded.length} leg(s) did not succeed (${notSucceeded[0]?.runId})`);
	const scoreless = pairs.flatMap((pair) => [pair.before, pair.after]).filter((leg) => leg.score === null);
	if (scoreless.length > 0) reasons.push(`${scoreless.length} leg(s) produced no graded score (${scoreless[0]?.runId})`);
	if (pairs.some((pair) => pair.before.configDigest !== pair.after.configDigest)) {
		reasons.push("paired legs ran under different execution configurations");
	}
	const verifiers = new Set(pairs.flatMap((pair) => [pair.before, pair.after]).map((leg) => leg.verifierSha256));
	if (verifiers.size !== 1 || verifiers.has(null)) reasons.push("independent workspace verifier is missing or changed");
	const controlled = reasons.length === 0;

	const before = pairs.map((pair) => pair.before.score).filter((score): score is number => score !== null);
	const after = pairs.map((pair) => pair.after.score).filter((score): score is number => score !== null);
	const gains = pairs.map((pair) => pair.gain).filter((gain): gain is number => gain !== null);
	const meanGain = controlled && gains.length > 0 ? gains.reduce((sum, gain) => sum + gain, 0) / gains.length : null;

	const report: ProbeReport = {
		schema: PROBE_REPORT_SCHEMA,
		episodeId: options.episodeId,
		skillId: options.skillId,
		caseId: options.caseId,
		kind: "reference-addition",
		controlled,
		reason: reasons.join("; "),
		pairs,
		meanGain,
		minimumPairs: U0_POLICY.minimumPairedProbes,
		minimumMeanGain: U0_POLICY.minimumMeanGain,
		before,
		after,
		evidenceRefs,
	};
	const reportPath = probeReportPath(options.qualityDir, options.episodeId);
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	atomicWriteFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	return {
		probe: { kind: "reference-addition", controlled, evidenceRef: reportPath, before, after },
		report,
		reportPath,
		usage: sumUsage(usages),
		...(budgetStop ? { budgetStop } : {}),
	};
}

/**
 * Attach a completed probe to the evidence a diagnosis runs on. The probe is an
 * observation about the skill under test, so it belongs in the same evidence
 * record U0 already reads — with `probeBudgetAvailable` telling the policy that
 * the budget question was actually answered.
 */
export function withProbe(evidence: DiagnosticEvidence, probe: DiagnosticEvidence["probe"]): DiagnosticEvidence {
	return { ...evidence, probeBudgetAvailable: true, ...(probe ? { probe } : {}) };
}
