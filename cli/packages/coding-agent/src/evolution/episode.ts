/**
 * P1-04: the persistent RSI episode.
 *
 * Every piece of the loop already existed in isolation — a pure U0 decision
 * function, a probe shape nobody filled in, a candidate author that consumed an
 * externally supplied patch, a `--paired` run that scored exactly one
 * parent/candidate pair, a propose-only promotion transaction. What was missing
 * was a unit of work that carries the run across those steps: which step ran,
 * what it produced, how much of the shared budget it spent, and why it stopped.
 *
 * This module is that unit. It is deliberately inert: no model calls, no
 * workspace writes outside the episode's own directory. `probe.ts` measures,
 * `episode-run.ts` orchestrates, `promotion.ts` is the only module that may
 * touch the live library.
 */
import fs from "node:fs";
import path from "node:path";
import { assertCanonicalId, assertCaseId } from "../audit/id.ts";
import { atomicWriteFileSync } from "../audit/atomic.ts";
import type { DiagnosticDecision, DiagnosticEvidence } from "./diagnostic-policy.ts";
import type { CandidateManifest } from "./skill-patch.ts";
import type { AgentExecutionConfig } from "../audit/agent-executor.ts";
import type { ExecutionUsage } from "../audit/types.ts";

export const EPISODE_SCHEMA = "ocsid.rsi-episode.v1" as const;

export const EPISODE_PHASES = [
	"evidence",
	"probe",
	"diagnosis",
	"candidate",
	"regression",
	"acceptance",
	"awaiting-approval",
	"promotion",
	"post-verification",
	"verified",
	"abstained",
	"failed",
] as const;
export type EpisodePhase = (typeof EPISODE_PHASES)[number];

export const EPISODE_TERMINAL_PHASES: readonly EpisodePhase[] = ["verified", "abstained", "failed"];

/**
 * The single legal transition table. `awaiting-approval -> abstained` is the
 * rejection branch: a human saying no must be a recorded outcome, never a silent
 * no-op, and it never reaches the live library.
 */
const EPISODE_TRANSITIONS: Record<EpisodePhase, readonly EpisodePhase[]> = {
	evidence: ["probe", "abstained", "failed"],
	probe: ["diagnosis", "abstained", "failed"],
	diagnosis: ["candidate", "abstained", "failed"],
	candidate: ["regression", "abstained", "failed"],
	regression: ["acceptance", "abstained", "failed"],
	acceptance: ["awaiting-approval", "abstained", "failed"],
	"awaiting-approval": ["promotion", "abstained", "failed"],
	promotion: ["post-verification", "failed"],
	"post-verification": ["verified", "failed"],
	verified: [],
	abstained: [],
	failed: [],
};

export interface EpisodeBudget {
	/** Paired reference-addition probes spent / allowed. */
	probePairs: number;
	maxProbePairs: number;
	candidates: number;
	maxCandidates: number;
	/** Model wall time spent / allowed, summed across every step. */
	wallMs: number;
	maxWallMs: number;
	/** Tokens spent / allowed, summed across every step. */
	tokens: number;
	maxTokens: number;
}

export interface EpisodeStepRecord {
	step: string;
	at: string;
	status: "started" | "succeeded" | "failed" | "skipped";
	detail?: string;
	evidenceRef?: string;
}

export interface EpisodeProbe {
	kind: DiagnosticEvidence["probe"] extends undefined ? never : NonNullable<DiagnosticEvidence["probe"]>["kind"];
	controlled: boolean;
	evidenceRef: string;
	before: number[];
	after: number[];
	meanGain: number | null;
}

export interface EpisodeCandidate {
	candidateId: string;
	stagedRoot: string;
	manifestFile: string;
	manifest: CandidateManifest;
}

/** One paired parent/candidate case measurement (the real regression unit). */
export interface EpisodeCaseDelta {
	caseId: string;
	parentStatus?: string;
	candidateStatus?: string;
	parentScore: number | null;
	candidateScore: number | null;
	parentRunId: string;
	candidateRunId: string;
	verifierSha256: string | null;
}

export interface EpisodeRegression {
	runId: string;
	cases: EpisodeCaseDelta[];
	parentMean: number | null;
	candidateMean: number | null;
	delta: number | null;
	/** Cases whose candidate score dropped below the parent score. */
	regressedCases: string[];
}

export interface EpisodeAcceptance {
	verdict: "accepted" | "rejected";
	/** Absent on legacy/proxy acceptances, which cannot authorize promotion. */
	scoreSource?: "workspace-verifier";
	reasons: string[];
	parentMean: number | null;
	candidateMean: number | null;
	delta: number | null;
	regressedCases: string[];
}

export interface EpisodePromotion {
	approvalRef: string;
	note?: string;
	at: string;
	recordId: string;
	previousDigest?: string;
	installedDigest: string;
	backupPath?: string;
	postVerification?: {
		at: string;
		runId: string;
		status: string;
		score: number | null;
		verdict: "pass" | "fail";
		recordId: string;
	};
}

export interface EpisodeStop {
	kind: "abstain" | "budget" | "failure" | "completed";
	reason: string;
	at: string;
}

export interface RsiEpisode {
	schema: typeof EPISODE_SCHEMA;
	episodeId: string;
	skillId: string;
	caseId: string;
	createdAt: string;
	updatedAt: string;
	phase: EpisodePhase;
	budget: EpisodeBudget;
	steps: EpisodeStepRecord[];
	probeEvidence?: DiagnosticEvidence;
	probe?: EpisodeProbe;
	diagnosis?: DiagnosticDecision;
	candidate?: EpisodeCandidate;
	regression?: EpisodeRegression;
	acceptance?: EpisodeAcceptance;
	promotion?: EpisodePromotion;
	stop?: EpisodeStop;
}

export function defaultEpisodeBudget(overrides: Partial<EpisodeBudget> = {}): EpisodeBudget {
	return {
		probePairs: 0,
		maxProbePairs: 4,
		candidates: 0,
		maxCandidates: 1,
		wallMs: 0,
		maxWallMs: 30 * 60_000,
		tokens: 0,
		maxTokens: 400_000,
		...overrides,
	};
}

export function episodeDir(qualityDir: string, episodeId: string): string {
	assertCanonicalId(episodeId, "episodeId");
	return path.join(path.resolve(qualityDir), "episodes", episodeId);
}

export function episodeStatePath(qualityDir: string, episodeId: string): string {
	return path.join(episodeDir(qualityDir, episodeId), "episode.json");
}

export function episodeLogPath(qualityDir: string, episodeId: string): string {
	return path.join(episodeDir(qualityDir, episodeId), "episode-log.jsonl");
}

export function createEpisode(options: {
	qualityDir: string;
	episodeId: string;
	skillId: string;
	caseId: string;
	budget?: Partial<EpisodeBudget>;
	now?: () => Date;
}): RsiEpisode {
	const at = (options.now ?? (() => new Date()))().toISOString();
	const state: RsiEpisode = {
		schema: EPISODE_SCHEMA,
		episodeId: options.episodeId,
		skillId: options.skillId,
		caseId: options.caseId,
		createdAt: at,
		updatedAt: at,
		phase: "evidence",
		budget: defaultEpisodeBudget(options.budget),
		steps: [{ step: "evidence", at, status: "started", detail: "episode opened" }],
	};
	const target = episodeStatePath(options.qualityDir, options.episodeId);
	if (fs.existsSync(target)) throw new Error(`episode already exists: ${target}`);
	assertEpisode(state, target);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteFileSync(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	return state;
}

export function readEpisode(qualityDir: string, episodeId: string): RsiEpisode {
	const target = episodeStatePath(qualityDir, episodeId);
	if (!fs.existsSync(target)) throw new Error(`episode not found: ${target}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(target, "utf8"));
	} catch (error) {
		throw new Error(`invalid episode state ${target}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return assertEpisode(parsed, target);
}

export function assertEpisode(value: unknown, source = "episode"): RsiEpisode {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid episode state ${source}: not an object`);
	const state = value as RsiEpisode;
	if (state.schema !== EPISODE_SCHEMA) throw new Error(`invalid episode state ${source}: unsupported schema ${String(state.schema)}`);
	assertCanonicalId(state.episodeId, "episodeId");
	assertCanonicalId(state.skillId, "skillId");
	assertCaseId(state.caseId);
	if (!EPISODE_PHASES.includes(state.phase)) throw new Error(`invalid episode state ${source}: unknown phase ${String(state.phase)}`);
	if (!state.budget || typeof state.budget !== "object") throw new Error(`invalid episode state ${source}: missing budget`);
	if (!Array.isArray(state.steps)) throw new Error(`invalid episode state ${source}: missing steps`);
	return state;
}

export function saveEpisode(qualityDir: string, state: RsiEpisode, now: () => Date = () => new Date()): RsiEpisode {
	const target = episodeStatePath(qualityDir, state.episodeId);
	const next: RsiEpisode = { ...state, updatedAt: now().toISOString() };
	assertEpisode(next, target);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

/** Append-only transition/step log next to the state file (survives a hand-edited state). */
export function appendEpisodeLog(qualityDir: string, state: RsiEpisode, record: EpisodeStepRecord): void {
	const target = episodeLogPath(qualityDir, state.episodeId);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.appendFileSync(target, `${JSON.stringify({ episodeId: state.episodeId, phase: state.phase, ...record })}\n`, "utf8");
}

export function recordEpisodeStep(state: RsiEpisode, record: Omit<EpisodeStepRecord, "at"> & { at?: string }): RsiEpisode {
	const entry: EpisodeStepRecord = { ...record, at: record.at ?? new Date().toISOString() };
	return { ...state, steps: [...state.steps, entry] };
}

export function canTransition(from: EpisodePhase, to: EpisodePhase): boolean {
	return EPISODE_TRANSITIONS[from].includes(to);
}

/**
 * Move the episode to `next` and record the transition. An illegal move (for
 * example `evidence -> promotion`, or anything out of a terminal phase) throws
 * instead of being written, so a corrupted step order cannot be persisted.
 */
export function transitionEpisode(state: RsiEpisode, next: EpisodePhase, detail?: string): RsiEpisode {
	if (!canTransition(state.phase, next)) {
		throw new Error(`illegal episode transition ${state.phase} -> ${next} (terminal: ${String(EPISODE_TERMINAL_PHASES.includes(state.phase))})`);
	}
	const at = new Date().toISOString();
	const moved: RsiEpisode = {
		...state,
		phase: next,
		steps: [...state.steps, { step: next, at, status: "started", ...(detail ? { detail } : {}) }],
	};
	return moved;
}

/** Sum spent budget. Never throws: exhaustion is a stop condition, not a crash. */
export function chargeEpisodeBudget(
	state: RsiEpisode,
	spend: { probePairs?: number; candidates?: number; wallMs?: number; tokens?: number },
): RsiEpisode {
	const budget: EpisodeBudget = {
		...state.budget,
		probePairs: state.budget.probePairs + (spend.probePairs ?? 0),
		candidates: state.budget.candidates + (spend.candidates ?? 0),
		wallMs: state.budget.wallMs + (spend.wallMs ?? 0),
		tokens: state.budget.tokens + (spend.tokens ?? 0),
	};
	return { ...state, budget };
}

/** The reason the shared budget forbids another step, or undefined while it holds. */
export function episodeBudgetStop(state: RsiEpisode): string | undefined {
	const b = state.budget;
	if (b.probePairs >= b.maxProbePairs) return `probe budget spent (${b.probePairs}/${b.maxProbePairs} paired probes)`;
	if (b.candidates >= b.maxCandidates) return `candidate budget spent (${b.candidates}/${b.maxCandidates})`;
	if (b.wallMs >= b.maxWallMs) return `wall-time budget spent (${b.wallMs}ms/${b.maxWallMs}ms)`;
	if (b.tokens >= b.maxTokens) return `token budget spent (${b.tokens}/${b.maxTokens})`;
	return undefined;
}

/** Reserve the same remaining allowance for both legs before starting a pair. */
export function pairedEpisodeConfig(state: RsiEpisode, config: AgentExecutionConfig): AgentExecutionConfig | undefined {
	const tokenBudget = Math.min(config.tokenBudget, Math.floor((state.budget.maxTokens - state.budget.tokens) / 2));
	const wallMs = Math.min(config.wallMs, Math.floor((state.budget.maxWallMs - state.budget.wallMs) / 2));
	if (tokenBudget < 1 || wallMs < 1) return undefined;
	return { ...config, tokenBudget, wallMs };
}

export function canFundEpisodeRun(state: RsiEpisode, config: AgentExecutionConfig): boolean {
	return state.budget.maxTokens - state.budget.tokens >= config.tokenBudget &&
		state.budget.maxWallMs - state.budget.wallMs >= config.wallMs;
}

/** Missing usage cannot buy free extra runs; consume the reserved allowance. */
export function chargeEpisodeRun(state: RsiEpisode, usage: ExecutionUsage, config: AgentExecutionConfig): RsiEpisode {
	const tokens = usage.totalTokens ??
		(usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : config.tokenBudget);
	return chargeEpisodeBudget(state, {
		tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : config.tokenBudget,
		wallMs: usage.wallMs !== undefined && Number.isFinite(usage.wallMs) && usage.wallMs >= 0 ? usage.wallMs : config.wallMs,
	});
}

/** Stop the episode. `abstain`/`budget` land in `abstained`, `failure` in `failed`. */
export function stopEpisode(state: RsiEpisode, kind: EpisodeStop["kind"], reason: string): RsiEpisode {
	const phase: EpisodePhase = kind === "failure" ? "failed" : kind === "completed" ? "verified" : "abstained";
	const rest = { ...state };
	delete rest.stop;
	return { ...rest, phase, stop: { kind, reason, at: new Date().toISOString() } };
}
