/**
 * B2 — single-case agent execution with a real-driver research entry point.
 *
 * This module supplies the "1 skill × 1 case" execution contract. FakeAgentDriver
 * remains for interface tests; runAgentEval rejects it. Research results also
 * require a separate verifier over the actual workspace output.
 *
 * The contract (guaranteed here and exercised by tests, plan lines 88–94):
 *  1. Every case executes in an independent temporary workspace with a frozen
 *     skill snapshot (case attachments are treated as untrusted input).
 *  2. Fixed model + sampling config is carried by the caller (seed/temp/model).
 *  3. Constraints are explicit and code-readable: tool allowlist, write-directory
 *     restriction, network policy, max rounds / tool calls / wall-clock / token
 *     budget, plus a cancellation and cleanup path.
 *  4. Secrets never touch logs or artifacts — only the process environment
 *     (callers pass a driver; this module never serializes secrets).
 *  5. Real execution is opt-in via `--executor agent`; it must use a DIFFERENT
 *     runKind and metric names from the proxy path so proxy vs agent numbers
 *     are never conflated.
 *
 * The execution result is a versioned `ExecutionResult` (B1) with usage,
 * config/environment digests and timing, so the ledger can later explain the
 * number as a task-success rate with real cost, not a proxy.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getRepoSkillsRoot } from "../config.ts";
import type { CaseRecord, CaseExecutor, ExecutionResult, ExecutionUsage } from "./types.ts";
import type { SplitIndex } from "./runner.ts";
import { candidateIdFor, skillTreeDigest, type CandidateManifest } from "../evolution/skill-patch.ts";
import { assertCanonicalId, assertCaseId } from "./id.ts";
import { loadWorkspaceVerifier, verifyWorkspace, type WorkspaceVerifier } from "./workspace-verifier.ts";
import { captureWorkspaceEvidence, writeWorkspaceEvidence, type WorkspaceEvidence } from "./workspace-evidence.ts";
import { atomicWriteFileSync } from "./atomic.ts";
import type { DiagnosticEvidence } from "../evolution/diagnostic-policy.ts";

/** Sampling / constraint-relevant fixed execution config (B2: fixed per run). */
export interface AgentExecutionConfig {
	/** Model identifier this execution is fixed to (e.g. "provider/model@revision"). */
	model: string;
	/** Fixed sampling temperature (when the backend supports it). */
	temperature?: number;
	/** Fixed random seed for reproducible sampling where supported. */
	seed?: number;
	/** Maximum agent turns. */
	maxRounds: number;
	/** Maximum tool invocations. */
	maxToolCalls: number;
	/** Hard wall-clock budget in milliseconds. */
	wallMs: number;
	/** Token budget (total). */
	tokenBudget: number;
	/** Allowed tools. Empty means no tools. */
	toolAllowlist: readonly string[];
	/** Absolute paths or the stable @workspace/output token the agent may WRITE to. */
	writeDirs: readonly string[];
	/** Network policy: "none" (offline) | "allowlist" (hosts) | "all". */
	networkPolicy: "none" | "allowlist" | "all";
	/** Network allowlist hosts, used when networkPolicy === "allowlist". */
	networkAllowlist?: readonly string[];
}

/**
 * Default constraints for a no-tools, offline single-case probe (fake path).
 *
 * PROVISIONAL: these values have not been calibrated on the pilot's real
 * scientific cases. Re-derive them from a real driver's reported `usage` before
 * treating any of these as a calibrated budget; `maxToolCalls`/`tokenBudget`/
 * `wallMs` are enforced (see `budgetViolations` and the deadline race), so a
 * wrong value shows up as failed runs rather than as silently-truncated ones.
 */
export const DEFAULT_AGENT_CONFIG: AgentExecutionConfig = {
	model: "fake/default",
	temperature: 0,
	seed: 0,
	maxRounds: 16,
	maxToolCalls: 32,
	wallMs: 10 * 60 * 1000,
	tokenBudget: 64_000,
	toolAllowlist: [],
	writeDirs: [],
	networkPolicy: "none",
};

/** The case-relevant top-level dirs inside a skill that are never snapshotted. */
const NON_CASE_DIRS = new Set([".git", "node_modules", "test-cases"]);

/**
 * A low-level "agent driver": the seam where a real model agent would be wired
 * in. `run` receives the frozen workspace + the case prompt + the config that
 * the caller already validated. It MUST return an ExecutionResult whose
 * status/configDigest/environmentDigest mirror the caller's snapshot.
 *
 * In the fake path, `FakeAgentDriver` stands in because credentials/sandbox are
 * unavailable — it never calls a model and reports an explicit simulated cost.
 * A real driver (e.g. wrapping a model/sandbox API) is the external prerequisite.
 */
export interface AgentDriver {
	readonly name: string;
	/**
	 * P1-03: which runtime produced the score. Absent means the direct
	 * OpenAI-compatible model-API driver (`ModelAgentDriver`); `"native-session"`
	 * means a real `ocsid` session ran the case. The audit ledger labels the two
	 * classes separately so a native session score is never silently compared
	 * against a pasted-snapshot API score.
	 */
	readonly runtime?: AgentDriverRuntime;
	/** P1-03: identity of the session behind the last score, when it is a session. */
	sessionEvidence?(): NativeSessionIdentity | null;
	run(opts: {
		workspace: CaseWorkspace;
		caseInput: AgentCaseInput;
		config: AgentExecutionConfig;
		startedAt: string;
		/**
		 * Aborts once `config.wallMs` has elapsed. OPTIONAL and additive — existing
		 * drivers may ignore it. The executor enforces the deadline itself (racing
		 * the run), so an ignoring driver still cannot hang the audit; honouring the
		 * signal just lets a cooperative driver stop cleanly instead of being
		 * abandoned mid-flight.
		 */
		signal?: AbortSignal;
	}): Promise<ExecutionResult>;
}

/** The only case data an agent driver may see; assertions stay with the grader. */
export interface AgentCaseInput {
	skillId: string;
	caseId: string;
	userRequest: string;
}

/** P1-03: which runtime an agent score came from. */
export type AgentDriverRuntime = "model-api" | "native-session";

/** P1-03: the native session that produced a score (audit evidence). */
export interface NativeSessionIdentity {
	sessionId: string | null;
	mode: string | null;
	provider: string | null;
	model: string | null;
}

export interface SkillSnapshotOptions {
	/** Exact skill tree to execute instead of skillRoot/<skillId>. */
	sourceSkillDir?: string;
	/** Verify the copied tree before injecting the user request. */
	expectedSkillDigest?: string;
}

/** A prepared independent temporary workspace + skill snapshot for one case. */
export interface CaseWorkspace {
	/** Absolute path of the temp work root (agent runs here). */
	root: string;
	/** Absolute path of the frozen skill snapshot (read-only for the agent). */
	skillSnapshotDir: string;
	/** Absolute path of the case user-request file beside the skill snapshot. */
	userRequestPath: string;
	/** Digest of the environment the case was launched under. */
	environmentDigest: string;
	/** Delete the work root + snapshot (call when done / on cancellation). */
	cleanup(): void;
}

/**
 * Build an independent temp workspace for one case:
 *  - A per-case temp root (unique).
 *  - A frozen skill snapshot: a recursive copy of the skill's files EXCLUDING
 *    its test-cases tree (test material is never given to the agent; only THIS
 *    case's user request is injected). Symlinks are rejected.
 *  - The case's `user_request.txt` is written beside the snapshot, keeping the
 *    skill tree byte-identical to the candidate manifest at execution time.
 *
 * Case attachments ("skill files") are treated as untrusted input: they are
 * copied into a sandbox-owned dir only, and never executed outside it.
 */
export function prepareCaseWorkspace(skillRoot: string, caseRecord: CaseRecord, options: SkillSnapshotOptions = {}): CaseWorkspace {
	// skillId becomes a filesystem component below. It is normally taken from the
	// manifest (digest-verified), and the CLI asserts it — but this function is
	// exported, and without the same check a library caller passing
	// skillId: "../../../Users" would have an arbitrary host directory recursively
	// copied into the agent's workspace. id.ts is the shared choke point for this.
	assertCanonicalId(caseRecord.skillId, "skillId");
	const srcSkill = path.resolve(options.sourceSkillDir ?? path.join(skillRoot, caseRecord.skillId));
	if (!fs.existsSync(srcSkill) || !fs.lstatSync(srcSkill).isDirectory()) {
		throw new Error(`skill not found or not a directory: ${srcSkill}`);
	}
	const skillDefinition = path.join(srcSkill, "SKILL.md");
	if (!fs.existsSync(skillDefinition) || !fs.lstatSync(skillDefinition).isFile()) {
		throw new Error(`skill definition SKILL.md must be a regular file: ${srcSkill}`);
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "arex-ocsid-case-"));
	const snapshotDir = path.join(root, "skill-snapshot");
	const userRequestPath = path.join(root, "user_request.txt");
	const cleanup = () => {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup during test tear-down / cancellation */
		}
	};
	try {
		fs.mkdirSync(path.join(root, "output"), { recursive: true });
		copySkillTree(srcSkill, snapshotDir);
		if (options.expectedSkillDigest && skillTreeDigest(snapshotDir) !== options.expectedSkillDigest) {
			throw new Error(`skill snapshot digest mismatch: ${srcSkill}`);
		}
		// The agent is handed only the case request; assertions remain outside.
		fs.writeFileSync(userRequestPath, caseRecord.files.userRequest, "utf8");
		return {
			root,
			skillSnapshotDir: snapshotDir,
			userRequestPath,
			environmentDigest: digestEnvironment(root),
			cleanup,
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}

/** Recursively copy a skill tree into a snapshot dir, skipping symlinks + test-cases. */
function copySkillTree(src: string, dest: string): void {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (NON_CASE_DIRS.has(entry.name)) continue;
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`skill tree contains a symbolic link: ${s}`);
		if (entry.isDirectory()) {
			copySkillTree(s, d);
		} else if (entry.isFile()) {
			fs.copyFileSync(s, d);
		}
	}
}

/** sha256 over snapshot file paths + contents (the environment the agent sees). */
function digestEnvironment(root: string): string {
	const h = createHash("sha256");
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isFile()) {
				h.update(path.relative(root, full));
				h.update("\n");
				h.update(fs.readFileSync(full));
				h.update("\n");
			} else if (entry.isDirectory()) {
				walk(full);
			}
		}
	};
	walk(root);
	return h.digest("hex");
}

/** Digest of the fixed execution config (what the run was launched under). */
export function configDigest(config: AgentExecutionConfig): string {
	return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

/**
 * Budgets the executor cannot enforce by itself, checked against the usage the
 * driver REPORTS.
 *
 * `wallMs` is enforced directly (deadline race). `maxToolCalls` and
 * `tokenBudget` are not: the executor does not own the agent loop, so it cannot
 * stop a driver from exceeding them. All of them are hashed into `configDigest`
 * as sampling constraints, though, so accepting an over-budget run as a normal
 * success would attest to a constraint that was not actually held. Flag the
 * overrun instead — a run that broke its declared budget is not a clean sample.
 *
 * `maxRounds` (P0-2): with `ExecutionUsage.rounds` reported by the tool loop,
 * an over-round run is flagged exactly like an over-tool-call one.
 */
function budgetViolations(usage: ExecutionUsage | undefined, config: AgentExecutionConfig): string[] {
	if (!usage) return [];
	const violations: string[] = [];
	if (typeof usage.rounds === "number" && Number.isFinite(usage.rounds) && usage.rounds > config.maxRounds) {
		violations.push(`rounds ${usage.rounds} > maxRounds ${config.maxRounds}`);
	}
	if (typeof usage.toolCalls === "number" && Number.isFinite(usage.toolCalls) && usage.toolCalls > config.maxToolCalls) {
		violations.push(`toolCalls ${usage.toolCalls} > maxToolCalls ${config.maxToolCalls}`);
	}
	const total =
		typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
			? usage.totalTokens
			: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	if (total > config.tokenBudget) {
		violations.push(`totalTokens ${total} > tokenBudget ${config.tokenBudget}`);
	}
	return violations;
}

/** Validate the case's write dirs are absolute + inside the temp workspace root. */
export function assertWorkspaceWritable(workspace: CaseWorkspace, config: AgentExecutionConfig): void {
	const root = path.resolve(workspace.root);
	const snapshot = path.resolve(workspace.skillSnapshotDir);
	for (const dir of config.writeDirs) {
		if (dir === "@workspace/output") continue;
		if (!path.isAbsolute(dir)) throw new Error(`write dir must be absolute or @workspace/output: ${dir}`);
		// Resolve FIRST so `..` / `.` components are normalized: a non-resolved
		// prefix check can be bypassed by e.g. `<root>\..\secret`, which lexically
		// starts with root but resolves outside it.
		const resolved = path.resolve(dir);
		if (resolved !== root && !resolved.startsWith(root + path.sep)) {
			throw new Error(
				`write dir escapes the case workspace: ${dir} (workspace ${workspace.root})`,
			);
		}
		// Inside-root is not enough for the snapshot: it is documented as the
		// "frozen skill snapshot (read-only for the agent)", and nothing re-hashes it
		// after the driver returns — so granting write access there would let the
		// agent rewrite the very tree the recorded environmentDigest attests to.
		if (resolved === snapshot || resolved.startsWith(snapshot + path.sep)) {
			throw new Error(
				`write dir must not be the frozen skill snapshot: ${dir}`,
			);
		}
	}
}

/** Fake execution cost figures used to make the fake path's usage honest + stable. */
export interface FakeAgentMetrics {
	modelCalls: number;
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
	/** Agent turns reported by the fake driver (defaults to modelCalls). */
	rounds?: number;
	wallMs: number;
}

/**
 * A deterministic stand-in driver used when model credentials / a hardened
 * sandbox are unavailable (plan line 194). It never calls a model; it returns a
 * succeeded result whose artifact echoes the (already-injected) user request,
 * so the grader can exercise the full audit path. Usage is a stable, explicit
 * simulation — never mistaken for a real-model call.
 */
export class FakeAgentDriver implements AgentDriver {
	readonly name = "fake-agent-driver";
	readonly metrics: FakeAgentMetrics;

	constructor(metrics: FakeAgentMetrics = {
		modelCalls: 1,
		inputTokens: 512,
		outputTokens: 128,
		toolCalls: 0,
		wallMs: 100,
	}) {
		this.metrics = metrics;
	}

	async run(opts: {
		workspace: CaseWorkspace;
		caseInput: AgentCaseInput;
		config: AgentExecutionConfig;
		startedAt: string;
	}): Promise<ExecutionResult> {
		const artifact = fs.readFileSync(opts.workspace.userRequestPath, "utf8");
		const usage: ExecutionUsage = {
			modelCalls: this.metrics.modelCalls,
			rounds: this.metrics.rounds ?? this.metrics.modelCalls,
			inputTokens: this.metrics.inputTokens,
			outputTokens: this.metrics.outputTokens,
			totalTokens: this.metrics.inputTokens + this.metrics.outputTokens,
			toolCalls: this.metrics.toolCalls,
			wallMs: this.metrics.wallMs,
		};
		return {
			schema: "ocsid.execution-result.v1",
			status: "succeeded",
			artifact,
			artifactSha256: createHash("sha256").update(artifact, "utf8").digest("hex"),
			usage,
			startedAt: opts.startedAt,
			endedAt: new Date().toISOString(),
			model: opts.config.model,
			configDigest: configDigest(opts.config),
			environmentDigest: opts.workspace.environmentDigest,
		};
	}
}

/**
 * Build a `CaseExecutor` that runs the given driver inside a fresh per-case
 * workspace + skill snapshot. This is what a `--executor agent` run plugs into
 * the audit runner (B1 contract). Each `execute` prepares its own workspace,
 * validates writable dirs, runs the driver, captures the result (optional),
 * and cleans up.
 */
export function makeAgentExecutor(
	skillRoot: string,
	driver: AgentDriver,
	config: AgentExecutionConfig,
	options: SkillSnapshotOptions & { captureResult?: (result: ExecutionResult) => void; inspectWorkspace?: (workspace: CaseWorkspace) => void } = {},
): CaseExecutor {
	return {
		async execute(caseRecord: CaseRecord): Promise<ExecutionResult> {
			const startedAt = new Date().toISOString();
			const workspace = prepareCaseWorkspace(skillRoot, caseRecord, options);
			// Cleanup is idempotent, and AFTER a timeout it is deferred to the
			// driver's settlement: the driver interface cannot force a hung run to
			// stop, so deleting the workspace underneath it would race a live run.
			let workspaceReleased = false;
			const releaseWorkspace = () => {
				if (workspaceReleased) return;
				workspaceReleased = true;
				workspace.cleanup();
			};
			let deferCleanup = false;
			try {
				assertWorkspaceWritable(workspace, config);
				const caseInput: AgentCaseInput = {
					skillId: caseRecord.skillId,
					caseId: caseRecord.caseId,
					userRequest: caseRecord.files.userRequest,
				};

				// `wallMs` is documented as a HARD wall-clock budget and is hashed into
				// configDigest as a sampling constraint, so it has to actually bind.
				// Nothing enforced it before: a hung driver never returned, the finally
				// never ran, and the per-case temp workspace leaked for the life of the
				// process. ExecutionStatus/ExecutionErrorKind already carry
				// "timed-out"/"timeout", so this is wiring an existing contract.
				const controller = new AbortController();
				let timedOut = false;
				const timeoutMessage = `agent execution exceeded its ${config.wallMs}ms wall-clock budget`;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const deadline = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
						reject(new Error(timeoutMessage));
					}, Math.max(1, config.wallMs));
				});

				const tracked = driver.run({ workspace, caseInput, config, startedAt, signal: controller.signal });
				// The abandoned run must never surface as an unhandled rejection once we
				// have stopped waiting for it.
				void tracked.catch(() => {});

				try {
					const result = await Promise.race([tracked, deadline]);
					const frozen = {
						...result,
						environmentDigest: result.environmentDigest ?? workspace.environmentDigest,
						configDigest: result.configDigest ?? configDigest(config),
					} as ExecutionResult;
					// A "succeeded" run that reports exceeding a declared budget is not a
					// clean sample. The executor cannot prevent the overrun (it does not
					// own the agent loop) but it must not file one as a success either —
					// see budgetViolations.
					const overruns = frozen.status === "succeeded" ? budgetViolations(frozen.usage, config) : [];
					const finalResult: ExecutionResult =
						overruns.length > 0
							? {
									...frozen,
									status: "failed",
									errorKind: "other",
									error: `execution exceeded its declared budget: ${overruns.join("; ")}`,
								}
							: frozen;
					if (finalResult.status === "succeeded") options.inspectWorkspace?.(workspace);
					if (options.captureResult) options.captureResult(finalResult);
					return finalResult;
				} catch (error) {
					if (!timedOut) throw error;
					// Deadline hit: report a distinct machine-readable status rather than
					// hanging or masquerading as a failure, and hand the workspace to the
					// still-running driver's settlement.
					deferCleanup = true;
					void tracked.catch(() => {}).then(releaseWorkspace);
					const timedOutResult: ExecutionResult = {
						schema: "ocsid.execution-result.v1",
						status: "timed-out",
						artifact: null,
						artifactSha256: null,
						startedAt,
						endedAt: new Date().toISOString(),
						model: config.model,
						configDigest: configDigest(config),
						environmentDigest: workspace.environmentDigest,
						errorKind: "timeout",
						error: timeoutMessage,
					};
					if (options.captureResult) options.captureResult(timedOutResult);
					return timedOutResult;
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			} finally {
				if (!deferCleanup) releaseWorkspace();
			}
		},
	};
}

/**
 * B2 — a focused, runnable agent-eval: exactly ONE skill × ONE case through a
 * real agent driver. An authored candidate uses its own runKind and
 * the digest of the staged skill tree, never a digest of candidate text.
 *
 * The fake driver remains available for isolated executor tests, but this
 * research evaluation entry point rejects it.
 */
export interface AgentEvalOptions {
	benchmarkRoot?: string;
	qualityDir: string;
	runId: string;
	skillId: string;
	caseId: string;
	/** Parent of live <skillId> trees; defaults to the managed repo-skills dir. */
	skillRoot?: string;
	/** Evaluate exactly this authored candidate tree rather than the live skill. */
	candidate?: { manifestFile: string; stagedRoot: string };
	/** Hidden, independent file/numeric verifier. Omit for proxy-only diagnostics. */
	verifierFile?: string;
	config: AgentExecutionConfig;
	/** A real driver must be supplied by the caller; fake drivers are test-only. */
	driver: AgentDriver;
	runAt?: string;
	/**
	 * P1-03: run one case from the post-freeze HELD-OUT split as a real acceptance
	 * measurement. Only the native-session runtime may do this (the direct API
	 * driver can only score a pasted snapshot proxy), and the run is persisted
	 * under its own label so it can never be folded into the improvement loop as
	 * if it were a train/dev measurement.
	 */
	acceptance?: "heldout";
	/**
	 * P1-03: score a case that is NOT part of any frozen benchmark — the
	 * Creator→Researcher flow grades the skill a native Creator session just
	 * produced. The recorded split label is `adhoc`, so such a score can never be
	 * counted as a frozen-split (train/dev/heldout) measurement.
	 */
	adhocCase?: { skillId: string; caseId: string; userRequest: string; assertionsText?: string };
}

export interface AgentEvalResult {
	runId: string;
	skillId: string;
	caseId: string;
	/** P1-03: "agent" is the pasted-snapshot model-API driver, "agent-native" a real OCSID session. */
	executor: "agent" | "agent-native";
	runKind: "agent-eval" | "candidate-agent-eval" | "native-agent-eval" | "native-candidate-agent-eval" | "native-heldout-acceptance";
	/** P1-03: the real session behind a native score (absent for model-API runs). */
	nativeSession?: NativeSessionIdentity;
	candidateId?: string;
	candidateSha256: string | null;
	status: ExecutionResult["status"];
	errorKind?: ExecutionResult["errorKind"];
	error?: string;
	artifactSha256: string | null;
	usage: ExecutionUsage;
	model: string | undefined;
	configDigest: string | undefined;
	environmentDigest: string | undefined;
	ledgerPath: string;
	summaryPath: string;
	driver: string;
	verifierSha256: string | null;
	/** P1-02: archived graded workspace files, absent without a workspace verifier. */
	workspaceEvidencePath?: string;
	diagnosticEvidencePath: string;
	note: string;
}

function readCandidateSnapshot(input: NonNullable<AgentEvalOptions["candidate"]>, skillId: string): { manifest: CandidateManifest; root: string } {
	const manifest = JSON.parse(fs.readFileSync(input.manifestFile, "utf8")) as CandidateManifest;
	const digest = /^[0-9a-f]{64}$/;
	if (manifest.enc !== "ocsid.candidate-manifest.v1" || manifest.targetSkillId !== skillId ||
		!digest.test(manifest.candidateId) || !digest.test(manifest.parentSkillDigest) ||
		!digest.test(manifest.patchDigest) || !digest.test(manifest.resultSkillDigest) ||
		candidateIdFor(manifest.parentSkillDigest, manifest.patchDigest) !== manifest.candidateId) {
		throw new Error("candidate manifest identity or target skill is invalid");
	}
	const root = path.resolve(input.stagedRoot);
	if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
		throw new Error(`candidate staged skill tree is not a regular directory: ${root}`);
	}
	if (skillTreeDigest(root) !== manifest.resultSkillDigest) {
		throw new Error(`candidate staged skill tree digest mismatch: ${root}`);
	}
	return { manifest, root };
}

/**
 * Run a single-skill single-case agent evaluation and persist it as `agent-eval`.
 * The run is filtered to EXACTLY the requested (skill, case); a mismatch (missing
 * skill, missing case, or a held-out case) throws so an operator never
 * accidentally scores held-out via this path.
 */
export async function runAgentEval(opts: AgentEvalOptions): Promise<AgentEvalResult> {
	assertCanonicalId(opts.runId, "runId");
	assertCanonicalId(opts.skillId, "skillId");
	assertCaseId(opts.caseId);
	const { loadBenchmark } = await import("./loader.ts");
	const { runAudit } = await import("./runner.ts");
	const { persistAuditRun } = await import("./records.ts");
	const { modelGrader } = await import("./model-grader.ts");

	// P1-03: the runtime decides the label, and only the native runtime may run a
	// held-out acceptance case (the model-API driver has no native heldout route).
	const nativeRuntime = opts.driver.runtime === "native-session";
	if (opts.acceptance === "heldout" && !nativeRuntime) {
		throw new Error('agent-eval: acceptance "heldout" requires the native-session runtime; the model-API driver cannot execute a real held-out case');
	}

	// P0-04 / B2 isolation: only load train+dev, never held-out — except for an
	// explicit native acceptance run, which loads held-out ONLY. A P1-03 ad-hoc
	// case (the Creator→Researcher flow scores a freshly created skill that is not
	// in any frozen benchmark) bypasses the benchmark lookup entirely and is
	// labelled `adhoc` so it can never be mistaken for a frozen-split measurement.
	const splits: Array<"train" | "dev" | "heldout"> = opts.acceptance === "heldout" ? ["heldout"] : ["train", "dev"];
	let target: CaseRecord;
	let splitIndex: SplitIndex;
	if (opts.adhocCase) {
		const adhoc = opts.adhocCase;
		target = { skillId: adhoc.skillId, caseId: adhoc.caseId, files: { userRequest: adhoc.userRequest,
			assertionsText: adhoc.assertionsText ?? (opts.verifierFile ? JSON.stringify({ schema: "ocsid.usability-case.v1", assertions: ["Independent workspace verifier"] }) : "") } };
		splitIndex = { [`${adhoc.skillId}:${adhoc.caseId}`]: "adhoc" };
	} else {
		if (!opts.benchmarkRoot) throw new Error("agent-eval: benchmarkRoot is required unless adhocCase is provided");
		const loaded = loadBenchmark(opts.benchmarkRoot, splits);
		const found = loaded.cases.find((c) => c.skillId === opts.skillId && c.caseId === opts.caseId);
		if (!found) {
			throw new Error(`agent-eval: no case ${opts.skillId}:${opts.caseId} in ${splits.join("/")} of ${opts.benchmarkRoot}`);
		}
		target = found;
		splitIndex = loaded.splitIndex;
	}

	const skillRoot = path.resolve(opts.skillRoot ?? path.join(getRepoSkillsRoot(), "repo-skills"));
	const candidate = opts.candidate ? readCandidateSnapshot(opts.candidate, opts.skillId) : null;
	const skillSha256 = candidate?.manifest.resultSkillDigest ?? skillTreeDigest(path.join(skillRoot, opts.skillId));
	if (opts.verifierFile) {
		const verifierPath = path.resolve(opts.verifierFile);
		for (const exposedRoot of [path.join(skillRoot, opts.skillId), candidate?.root].filter((root): root is string => !!root)) {
			if (verifierPath === exposedRoot || verifierPath.startsWith(exposedRoot + path.sep)) {
				throw new Error("verifier file must be outside the agent-visible skill tree");
			}
		}
	}
	const runKind = opts.acceptance === "heldout"
		? "native-heldout-acceptance"
		: candidate
			? (nativeRuntime ? "native-candidate-agent-eval" : "candidate-agent-eval")
			: (nativeRuntime ? "native-agent-eval" : "agent-eval");
	const driver = opts.driver;
	if (!driver || driver instanceof FakeAgentDriver || driver.name === "fake-agent-driver") {
		throw new Error("agent-eval requires a real AgentDriver; fake execution cannot produce research scores");
	}
	const verifier: WorkspaceVerifier | null = opts.verifierFile ? loadWorkspaceVerifier(opts.verifierFile) : null;
	let verified: ReturnType<typeof verifyWorkspace> | undefined;
	let captured: ExecutionResult | undefined;
	// P1-02: the temp workspace (and with it the graded output/) is deleted in
	// `finally`, so seal the graded files + verifier + verdict while they exist.
	let sealed: WorkspaceEvidence | undefined;
	const caseExecutor = makeAgentExecutor(skillRoot, driver, opts.config, {
		sourceSkillDir: candidate?.root,
		expectedSkillDigest: skillSha256,
		captureResult: (r) => {
			captured = r;
		},
		inspectWorkspace: verifier ? (workspace) => {
			const verdict = verifyWorkspace(workspace.root, verifier);
			verified = verdict;
			sealed = captureWorkspaceEvidence({
				workspaceRoot: workspace.root,
				runId: opts.runId,
				skillId: opts.skillId,
				caseId: opts.caseId,
				verifier,
				verdict,
			});
		} : undefined,
	});

	// Single-case audit through the agent executor. The ledger/kind is genuinely
	// distinct from the proxy path (`agent-eval`), and usage is captured above.
	const run = await runAudit(
		[target],
		{ runId: opts.runId, runAt: opts.runAt ?? new Date().toISOString(), candidateSha256: candidate?.manifest.resultSkillDigest ?? null },
		{ executor: caseExecutor, grader: verifier ? { gradedBy: "assertion", async grade() {
			if (!verified) throw new Error("workspace verifier did not run");
			return verified;
		} } : modelGrader(), splitIndex },
	);
	// P1-03: the real session that produced this score, recorded as ledger note
	// evidence (a native score must be attributable to a session, not just a model).
	const session: NativeSessionIdentity | null = nativeRuntime ? driver.sessionEvidence?.() ?? null : null;
	const sessionNote = session
		? ` nativeSession=${session.sessionId ?? "unknown"} mode=${session.mode ?? "unknown"} runtime=${session.provider ?? "unknown"}/${session.model ?? "unknown"};`
		: "";
	const persisted = persistAuditRun(run, {
		qualityDir: opts.qualityDir,
		kind: runKind,
		note: `${runKind}: single-case (${opts.skillId}:${opts.caseId}) via driver "${driver.name}" (runtime=${driver.runtime ?? "model-api"}) over model ${opts.config.model}; candidateId=${candidate?.manifest.candidateId ?? "none"};${sessionNote} ${verifier ? `workspace verifier ${verifier.sha256}` : "deterministic proxy grader (NOT a task-quality claim)"}.${opts.acceptance === "heldout" ? " POST-FREEZE HELD-OUT ACCEPTANCE: not an improvement signal and never fed back into the loop." : ""}`,
	});

	const row = run.cases[0];
	// P1-02: archive the graded workspace files so the verdict survives the
	// deletion of the temp workspace and can be replayed (`verify-archive`).
	const sealedEvidencePath = sealed ? writeWorkspaceEvidence(persisted.dir, sealed) : undefined;
	const diagnosticEvidence: DiagnosticEvidence = {
		schema: "ocsid.diagnostic-evidence.v1",
		runId: opts.runId,
		caseId: opts.caseId,
		skillId: opts.skillId,
		skillDigest: skillSha256,
		// Text-token proxy grades remain in the audit ledger for plumbing checks,
		// but cannot authorize a persistent skill edit.
		score: verifier ? row?.score ?? null : null,
		executionStatus: row?.execStatus ?? "not-attempted",
		evidenceRefs: [persisted.ledgerPath, persisted.summaryPath, persisted.tracesPath, ...(sealedEvidencePath ? [sealedEvidencePath] : [])],
		probeBudgetAvailable: false,
	};
	const diagnosticEvidencePath = path.join(persisted.dir, "diagnostic-evidence.json");
	atomicWriteFileSync(diagnosticEvidencePath, JSON.stringify(diagnosticEvidence, null, 2) + "\n", "utf8");
	return {
		runId: run.runId,
		skillId: opts.skillId,
		caseId: opts.caseId,
		executor: nativeRuntime ? "agent-native" : "agent",
		runKind,
		...(session ? { nativeSession: session } : {}),
		candidateId: candidate?.manifest.candidateId,
		candidateSha256: candidate?.manifest.resultSkillDigest ?? null,
		status: row?.execStatus ?? "not-attempted",
		...(row?.execStatus !== "succeeded" && row?.execStatus !== "not-attempted" ? {
			errorKind: captured?.errorKind ?? row?.errorKind,
			error: captured?.error ?? row?.blocker,
		} : {}),
		artifactSha256: row && "artifactSha256" in row ? row.artifactSha256 ?? null : null,
		usage: captured?.usage ?? {},
		model: captured?.model ?? opts.config.model,
		configDigest: captured?.configDigest ?? configDigest(opts.config),
		environmentDigest: captured?.environmentDigest,
		ledgerPath: persisted.ledgerPath,
		summaryPath: persisted.summaryPath,
		driver: driver.name,
		verifierSha256: verifier?.sha256 ?? null,
		...(sealedEvidencePath ? { workspaceEvidencePath: sealedEvidencePath } : {}),
		diagnosticEvidencePath,
		note: `${runKind} persisted; ${row?.row ? 1 : 0} ledger row(s); ${verifier ? "programmatic workspace verifier" : "deterministic proxy grader"}; driver=${driver.name}.`,
	};
}

/** Execute a parent and its authored candidate on the same case, model, budget and private verifier. */
export async function runPairedAgentEval(
	opts: AgentEvalOptions & { candidate: NonNullable<AgentEvalOptions["candidate"]>; verifierFile: string },
): Promise<{ parent: AgentEvalResult; candidate: AgentEvalResult; parentScore: number | null; candidateScore: number | null; delta: number | null }> {
	assertCanonicalId(opts.runId, "runId");
	assertCanonicalId(`${opts.runId}-parent`, "parent runId");
	assertCanonicalId(`${opts.runId}-candidate`, "candidate runId");
	const skillRoot = path.resolve(opts.skillRoot ?? path.join(getRepoSkillsRoot(), "repo-skills"));
	const manifest = readCandidateSnapshot(opts.candidate, opts.skillId).manifest;
	if (skillTreeDigest(path.join(skillRoot, opts.skillId)) !== manifest.parentSkillDigest) {
		throw new Error("paired evaluation parent skill does not match candidate manifest");
	}
	const parent = await runAgentEval({ ...opts, runId: `${opts.runId}-parent`, candidate: undefined });
	const candidate = await runAgentEval({ ...opts, runId: `${opts.runId}-candidate` });
	if (parent.configDigest !== candidate.configDigest || parent.verifierSha256 !== candidate.verifierSha256) {
		throw new Error("paired evaluation configuration or verifier changed between runs");
	}
	const scoreOf = (run: AgentEvalResult): number | null => {
		const evidence = JSON.parse(fs.readFileSync(run.diagnosticEvidencePath, "utf8")) as DiagnosticEvidence;
		return evidence.score;
	};
	const parentScore = scoreOf(parent);
	const candidateScore = scoreOf(candidate);
	return { parent, candidate, parentScore, candidateScore,
		delta: parentScore === null || candidateScore === null ? null : candidateScore - parentScore };
}

/** Aggregated usage across an audit run's execution results (summed where present). */
export function sumUsage(usage: readonly (ExecutionUsage | undefined)[]): ExecutionUsage {
	const out: ExecutionUsage = {};
	for (const u of usage) {
		if (!u) continue;
		for (const key of ["modelCalls", "rounds", "inputTokens", "outputTokens", "totalTokens", "toolCalls", "wallMs"] as const) {
			if (typeof u[key] === "number") out[key] = (out[key] ?? 0) + (u[key] as number);
		}
	}
	return out;
}
