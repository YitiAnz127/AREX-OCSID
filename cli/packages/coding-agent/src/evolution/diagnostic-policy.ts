/** Frozen U0: selective, evidence-based decisions about persistent skill edits. */
import { createHash } from "node:crypto";

export const U0_POLICY = Object.freeze({
	schema: "ocsid.diagnostic-policy.v1",
	version: "u0-1",
	minimumPairedProbes: 2,
	minimumMeanGain: 0.25,
} as const);

export type Diagnosis = "skill_defect" | "non_skill" | "uncertain";
export type Decision = "patch" | "probe" | "abstain";
export type ProbeKind = "reference-addition" | "correct-skill-replay" | "same-environment-retry";

export interface DiagnosticEvidence {
	schema: "ocsid.diagnostic-evidence.v1";
	runId: string;
	caseId: string;
	skillId: string;
	skillDigest: string;
	/** The independently graded task score; null means the result is missing. */
	score: number | null;
	executionStatus: "succeeded" | "failed" | "timed-out" | "cancelled" | "not-attempted";
	/** Run/trace/verifier references available to the diagnosis; never hidden assertion text. */
	evidenceRefs: string[];
	probeBudgetAvailable: boolean;
	probe?: {
		kind: ProbeKind;
		controlled: boolean;
		evidenceRef: string;
		before: number[];
		after: number[];
	};
}

export interface DiagnosticDecision {
	schema: "ocsid.diagnostic-decision.v1";
	policyVersion: typeof U0_POLICY.version;
	policySha256: string;
	runId: string;
	caseId: string;
	skillId: string;
	skillDigest: string;
	diagnosis: Diagnosis;
	decision: Decision;
	evidenceRefs: string[];
	reason: string;
	probeKind?: ProbeKind;
	/** Observed paired-probe mean gain; a prediction for an unseen task is not implied. */
	observedProbeGain?: number;
}

function validScore(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Pure policy: a failed task alone never licenses a persistent patch. */
export function diagnoseWithU0(input: DiagnosticEvidence): DiagnosticDecision {
	if (input.schema !== "ocsid.diagnostic-evidence.v1" || !input.runId || !input.caseId || !input.skillId ||
		!/^[0-9a-f]{64}$/.test(input.skillDigest) || !Array.isArray(input.evidenceRefs) ||
		input.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim()) ||
		!["succeeded", "failed", "timed-out", "cancelled", "not-attempted"].includes(input.executionStatus) ||
		(input.score !== null && !validScore(input.score)) ||
		typeof input.probeBudgetAvailable !== "boolean") {
		throw new Error("invalid diagnostic evidence");
	}
	const base = {
		schema: "ocsid.diagnostic-decision.v1" as const,
		policyVersion: U0_POLICY.version,
		policySha256: createHash("sha256").update(JSON.stringify(U0_POLICY)).digest("hex"),
		runId: input.runId, caseId: input.caseId, skillId: input.skillId, skillDigest: input.skillDigest,
		evidenceRefs: [...input.evidenceRefs, ...(input.probe ? [input.probe.evidenceRef] : [])],
	};
	const decide = (diagnosis: Diagnosis, decision: Decision, reason: string, extra: Partial<DiagnosticDecision> = {}): DiagnosticDecision =>
		({ ...base, diagnosis, decision, reason, ...extra });

	if (input.executionStatus !== "succeeded") {
		return decide(input.executionStatus === "not-attempted" ? "uncertain" : "non_skill", "abstain", "execution did not complete; repair the run or environment first");
	}
	if (input.score === null) return decide("uncertain", "abstain", "independent task result is missing");
	if (input.score === 1) return decide("non_skill", "abstain", "independent verifier reports success");
	if (!input.probe) {
		return input.probeBudgetAvailable
			? decide("uncertain", "probe", "failure alone does not identify a skill defect", { probeKind: "reference-addition" })
			: decide("uncertain", "abstain", "failure is unassigned and no diagnostic probe budget remains");
	}
	const p = input.probe;
	if (!p.evidenceRef || !["reference-addition", "correct-skill-replay", "same-environment-retry"].includes(p.kind) ||
		!Array.isArray(p.before) || !Array.isArray(p.after) || p.before.length !== p.after.length ||
		p.before.some((x) => !validScore(x)) || p.after.some((x) => !validScore(x))) {
		throw new Error("invalid diagnostic probe");
	}
	if (!p.controlled || p.before.length < U0_POLICY.minimumPairedProbes) {
		return decide("uncertain", "abstain", "probe lacks controlled paired repeats");
	}
	const gains = p.after.map((score, i) => score - p.before[i]);
	const meanGain = gains.reduce((sum, gain) => sum + gain, 0) / gains.length;
	if (p.kind === "correct-skill-replay" && meanGain >= U0_POLICY.minimumMeanGain) {
		return decide("non_skill", "abstain", "correct-skill replay points to routing rather than skill content");
	}
	if (p.kind === "same-environment-retry" && meanGain >= U0_POLICY.minimumMeanGain) {
		return decide("uncertain", "abstain", "same-environment retries improve without a skill edit");
	}
	if (p.kind === "reference-addition" && gains.every((gain) => gain > 0) && meanGain >= U0_POLICY.minimumMeanGain) {
		return decide("skill_defect", "patch", "controlled reference-addition probe supports a local skill gap", { observedProbeGain: meanGain });
	}
	return decide("uncertain", "abstain", "controlled probe does not support a persistent skill edit");
}
