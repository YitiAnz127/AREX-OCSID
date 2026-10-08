/** Shared types for the Step 3 audit runner. */

import { createHash } from "node:crypto";
import type { GradedBy } from "../benchmark/schema.ts";

/** The three files a case must provide (paths resolved by the caller). */
export interface CaseFile {
	/** Raw user-request text. */
	userRequest: string;
	/** Raw assertions.json text. */
	assertionsText: string;
}

/** A benchmark case, addressed by skill + case id + files. */
export interface CaseRecord {
	skillId: string;
	caseId: string;
	files: CaseFile;
}

/** Per-assertion grading outcome. */
export interface GradeOutcome {
	assertion: string;
	outcome: "pass" | "partial" | "fail";
	/** 0..1 score; required for pass/partial, may be null for fail. */
	score: number | null;
}

/**
 * Grade metadata recorded alongside a real (non-proxy) grader's output so the
 * ledger can attribute a score not just to a coarse category but to the exact
 * judge that produced it (P0-3 step 2). A deterministic proxy omits this: it is
 * identical for every `(assertion, artifact)` pair and needs no version stamp. A
 * model judge MUST set `modelVersion` (the judge model id) and SHOULD set
 * `rubricVersion` (the grading-rubric version it executed); both are surfaced on
 * the ledger row / summary so a number is traceable to its grader implementation.
 */
export interface GradeJudgeMeta {
	/** Judge model id (e.g. "DeepSeek-V4-Flash-0731-W8A8"). */
	modelVersion?: string;
	/** Version of the grading rubric the judge executed. */
	rubricVersion?: string;
}

/** A full grade for one case's artifact. */
export interface GradeSpec {
	perAssertion: GradeOutcome[];
	/** Optional judge provenance for a real grader (see GradeJudgeMeta). */
	judge?: GradeJudgeMeta;
}

/** Case score (mean of assertion scores), null when ungradable. */
export type CaseScore = number | null;

/**
 * Execution status for one case within a run. These are mutually exclusive and
 * cover "not executed" through "executed but ungradeable" so a run summary can
 * report attempted/completed/graded/failed/missing without collapsing failures
 * into an over-optimistic mean (B1).
 */
export type ExecutionStatus = "not-attempted" | "succeeded" | "failed" | "timed-out" | "cancelled";

/**
 * One recorded tool invocation inside an agent loop (P0-2). This is the per-call
 * entry that makes a score attributable to a *tool trajectory*: a reader can see
 * which tool ran, with what arguments, and whether the sandbox admitted or
 * rejected it. `args` is intentionally compact (a short projection of the parsed
 * arguments, not the raw model payload) so the ledger stays greppable.
 */
export interface ToolTraceEntry {
	/** Tool name invoked, e.g. "read_file" | "write_file" | "execute_command". */
	name: string;
	/**
	 * Outcome of the invocation. "ok" = the sandbox admitted it and it ran;
	 * "error" = the sandbox rejected it (bad path / forbidden write / blocked
	 * tool) or execution failed. Errors are fed back to the model as a tool
	 * message so the agent can recover, so an "error" entry is NOT fatal.
	 */
	status: "ok" | "error";
	/**
	 * Compact argument projection: the path(s)/command the tool was asked to act
	 * on, sufficient to prove e.g. "the skilled read a file" or "a script ran".
	 */
	args?: string;
	/** Human-readable: which writeDir the write target resolved into, or the
	 * command that ran, or the rejection reason. Kept short. */
	detail?: string;
}

/**
 * Machine-observable cost/usage of one execution. Fields are intentionally
 * optional (a proxy adapter that never invoked a model reports none).
 */
export interface ExecutionUsage {
	/** Number of model calls made (e.g. API round-trips). */
	modelCalls?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/** Number of tool invocations. */
	toolCalls?: number;
	/** Number of agent turns (model calls) in a multi-round tool loop (P0-2). */
	rounds?: number;
	/**
	 * The per-round tool trajectory (P0-2), in execution order. Absent for a
	 * single shot that never used tools. This is what persistence writes into
	 * `traces.jsonl` so a score can be attributed to a tool trajectory.
	 */
	toolTrace?: ToolTraceEntry[];
	/** Wall-clock duration in milliseconds. */
	wallMs?: number;
}

/** Why an execution did not produce a gradeable artifact (status != succeeded). */
export type ExecutionErrorKind =
	| "timeout"
	| "tool-failure"
	| "cancelled"
	| "environment"
	| "model"
	| "other";

/**
 * Versioned execution result (B1). Replaces the bare `Promise<string>` so a
 * real agent executor can express failure, cost, provenance digests and timing
 * without a second schema migration. The legacy string executors are wrapped
 * by `proxyExecutor` and report a `succeeded` ExecutionResult with no usage.
 *
 * Versioning note: consumers must treat `schema` as the contract version. Any
 * future rupture in the fields here bumps `schema`; additive optional fields
 * keep the same version.
 */
export interface ExecutionResult {
	/** Contract version marker so downstream readers can branch on schema breaks. */
	schema: "ocsid.execution-result.v1";
	status: ExecutionStatus;
	/** The produced artifact (response text / produced file content), or null when no artifact exists. */
	artifact: string | null;
	/** sha256 hex digest of `artifact`, or null when artifact is null. */
	artifactSha256: string | null;
	/** Optional machine-readable cost/usage. */
	usage?: ExecutionUsage;
	/** ISO start time of execution. */
	startedAt?: string;
	/** ISO end time of execution. */
	endedAt?: string;
	/** Model identifier actually used (when a real agent ran). */
	model?: string;
	/** Digest of the executor/config snapshot the run was launched under. */
	configDigest?: string;
	/** Digest of the execution environment (tool allowlist, cwd snapshot, network policy). */
	environmentDigest?: string;
	/** Machine-readable failure category when status is failed/timed-out/cancelled. */
	errorKind?: ExecutionErrorKind;
	/** Human-readable failure detail (message), when applicable. */
	error?: string;
	/**
	 * P2-1: machine-readable reason an agent loop stopped against a hard budget
	 * cap. Present ONLY when the loop was cut short by a budget (maxRounds /
	 * maxToolCalls / tokenBudget), never on a normal completion. `rounds` is the
	 * number of model calls actually made before the stop, so the ledger's round
	 * attribution stays self-consistent with `usage.rounds`.
	 */
	budgetStop?: AgentBudgetStop;
}

/** P2-1: which hard budget cap stopped an agent loop. */
export type AgentBudgetReason = "maxRounds" | "maxToolCalls" | "tokenBudget";

/** P2-1: structured record of a hard budget-cap stop. */
export interface AgentBudgetStop {
	/** The cap that was hit. */
	reason: AgentBudgetReason;
	/** Model calls (rounds) actually performed before the stop; == usage.rounds. */
	rounds: number;
}

/**
 * Produces an execution result for a case. Real agents plug in here and return
 * a full `ExecutionResult`; legacy string-only executors are adapted with
 * `proxyExecutor` so the runner's contract stays uniform (B1).
 */
export interface CaseExecutor {
	execute(caseRecord: CaseRecord): Promise<ExecutionResult>;
}

/**
 * Wrap a legacy string artifact function into a `succeeded` ExecutionResult
 * (proxy adapter). Marks the result so downstream reports can tell "no agent ran"
 * apart from a real execution. The artifact is sha256-hashed for provenance.
 */
export function proxyExecutor(run: (caseRecord: CaseRecord) => string | Promise<string>): CaseExecutor {
	return {
		async execute(caseRecord: CaseRecord): Promise<ExecutionResult> {
			const artifact = await run(caseRecord);
			return artifactResult(artifact);
		},
	};
}

/** Build a successful ExecutionResult from a plain artifact string. */
export function artifactResult(artifact: string): ExecutionResult {
	// Imported lazily to avoid a node:crypto dependency at module-eval time in
	// environments that only touch types. (createHash is cheap; fine to eval here.)
	return {
		schema: "ocsid.execution-result.v1",
		status: "succeeded",
		artifact,
		artifactSha256: sha256Hex(artifact),
	};
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Scores an artifact against a case's assertions.
 *
 * `gradedBy` is the OPTIONAL coarse attribution category the grader declares for
 * its own output (one of "assertion" | "human" | "model_grader" | "token_overlap").
 * It is recorded
 * on every ledger row so output is never attributed to the wrong source.
 * BUG-P1-13: the runner must NOT hardcode "model_grader"; it reads the category
 * from the injected grader declaration. Ad-hoc test graders may omit it, in
 * which case the runner falls back to a default.
 */
export interface CaseGrader {
	grade(caseRecord: CaseRecord, artifact: string): Promise<GradeSpec>;
	/** Coarse attribution category this grader declares for its output. */
	gradedBy?: GradedBy;
}
