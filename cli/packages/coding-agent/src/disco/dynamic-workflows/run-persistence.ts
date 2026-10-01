/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHistoryEntry } from "./agent-history.ts";
import type { AgentUsageRecord } from "./agent-usage.ts";
import type { WorkflowErrorCode } from "./errors.ts";
import { workflowProjectPaths } from "./workflow-paths.ts";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

/**
 * A run lease is held only for the lifetime of one executeRun() invocation. Any
 * lock older than this is treated as stale and reclaimed even if its pid appears
 * alive (SIGKILL + pid-reuse / zombie), so a wedged lock can't block a run forever.
 */
const LEASE_STALE_MS = 60 * 60 * 1000; // 60 minutes

/**
 * P0-02 (audit F1): runId is used to build filesystem paths (`${runId}.json` /
 * `${runId}.lock`). It must be strictly validated at every persistence boundary,
 * otherwise an unvalidated runId like "../../x" lets path.join escape runsDir and
 * read/delete arbitrary .json files in the workspace (reachable from the
 * /workflows rm & resume commands). Internal ids from generateRunId() are
 * base36 + "-", so this superset is safe.
 */
const SAFE_RUN_ID = /^[0-9a-z][0-9a-z-]{0,71}$/i;

/** Non-throwing form of the runId check, for filtering ids read off disk. */
export function isSafeRunId(runId: unknown): runId is string {
	return typeof runId === "string" && SAFE_RUN_ID.test(runId);
}

function assertSafeRunId(runId: string): void {
	if (!isSafeRunId(runId)) {
		throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
	}
}

export interface PersistedAgentAttempt {
	attempt: number;
	status: "done" | "error";
	tokens: number;
	usage?: AgentUsageRecord;
	error?: string;
	errorCode?: WorkflowErrorCode;
	recoverable?: boolean;
	startedAt?: string;
	endedAt?: string;
}

export interface PersistedRunLimits {
	maxAgents: number;
	concurrency: number;
	agentTimeoutMs: number | null;
	agentRetries: number;
	tokenBudget: number | null;
	maxRecoveryRounds: number;
}

export interface PersistedAgentState {
	id: number;
	/** Stable workflow identity (subSkill/job id, or deterministic agent-N). */
	stableId?: string;
	callIndex?: number;
	label: string;
	subSkill?: string;
	phase?: string;
	prompt: string;
	status: "queued" | "running" | "done" | "error" | "skipped";
	result?: unknown;
	resultPreview?: string;
	error?: string;
	errorCode?: WorkflowErrorCode;
	recoverable?: boolean;
	history?: AgentHistoryEntry[];
	startedAt?: string;
	endedAt?: string;
	/** The model this agent ran on (provider/id), when known. */
	model?: string;
	/** Finalized tokens accumulated across this agent's attempts. */
	tokens?: number;
	attempts?: PersistedAgentAttempt[];
}

export interface PersistedRunState {
	runId: string;
	workflowName: string;
	script: string;
	args?: unknown;
	/** The DisCo session this run belongs to. Runs persist on disk across sessions
	 * but the navigator shows only the current session's runs when this is set. */
	sessionId?: string;
	status: RunStatus;
	/** Execution semantics captured at run creation and reused on resume. */
	maxAgents?: number;
	concurrency?: number;
	agentTimeoutMs?: number | null;
	agentRetries?: number;
	tokenBudget?: number | null;
	/** Recovery lineage for an incomplete run. */
	recoveryOfRunId?: string;
	recoveryRound?: number;
	maxRecoveryRounds?: number;
	phases: string[];
	currentPhase?: string;
	agents: PersistedAgentState[];
	logs: string[];
	result?: unknown;
	complete?: boolean;
	missing?: string[];
	errors?: Array<{ id: string; error?: string }>;
	/** Root cause for failed/incomplete/aborted runs. */
	error?: string;
	errorCode?: WorkflowErrorCode;
	recoverable?: boolean;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	durationMs?: number;
	tokenUsage?: {
		input: number;
		output: number;
		total: number;
		cost?: number;
		cacheRead?: number;
		cacheWrite?: number;
		estimated?: boolean;
	};
	liveTokenUsage?: {
		input: number;
		output: number;
		total: number;
		cost?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	/** Cached agent results for resume, keyed by deterministic call index. */
	journal?: Array<{ index: number; hash: string; result: unknown }>;
}

export interface RunPersistence {
	/** Save current run state. */
	save(state: PersistedRunState): void;
	/** Load a persisted run by ID. */
	load(runId: string): PersistedRunState | null;
	/** List all persisted runs. */
	list(): PersistedRunState[];
	/** Delete a persisted run. */
	delete(runId: string): boolean;
	/**
	 * Acquire an exclusive cross-process lease for a run. Returns null when another
	 * live process owns the run; stale/corrupt lock files are removed and retried.
	 */
	acquireRunLease(runId: string): RunLease | null;
	/** Release a lease previously returned by acquireRunLease(). */
	releaseRunLease(lease: RunLease): void;
	/** Get runs directory path. */
	getRunsDir(): string;
}

export interface RunLease {
	runId: string;
	token: string;
}

interface LockFile {
	runId: string;
	runPath: string;
	pid: number;
	startedAt: string;
	token: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
	existsSync: typeof existsSync;
	mkdirSync: typeof mkdirSync;
	readdirSync: typeof readdirSync;
	readFileSync: typeof readFileSync;
	renameSync: typeof renameSync;
	unlinkSync: typeof unlinkSync;
	writeFileSync: typeof writeFileSync;
};

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>): RunPersistence {
	const _existsSync = fsOverride?.existsSync ?? existsSync;
	const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
	const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
	const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
	const _renameSync = fsOverride?.renameSync ?? renameSync;
	const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
	const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;

	const paths = workflowProjectPaths(cwd);
	const runsDir = paths.runsDir;

	const ensureDir = () => {
		if (!_existsSync(runsDir)) {
			_mkdirSync(runsDir, { recursive: true });
		}
	};

	const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
	const primaryRunPath = (runId: string) => runPath(runsDir, runId);
	const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
	const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
	const candidateRunPaths = (runId: string) => [primaryRunPath(runId)];

	const pidIsAlive = (pid: number): boolean => {
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			if ((err as { code?: string }).code === "EPERM") return true;
			return false;
		}
	};

	const readLockAt = (path: string): LockFile | null => {
		try {
			return JSON.parse(_readFileSync(path, "utf-8")) as LockFile;
		} catch {
			return null;
		}
	};

	const readLock = (runId: string): LockFile | null => readLockAt(primaryLockPath(runId));

	return {
		save(state: PersistedRunState) {
			assertSafeRunId(state.runId);
			ensureDir();
			state.updatedAt = new Date().toISOString();
			const path = primaryRunPath(state.runId);
			const json = JSON.stringify(state, null, 2);
			// Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
			// atomic on the same filesystem). A .bak holding the PREVIOUS good save is the
			// recovery fallback if the primary is later truncated.
			// BUG (.bak redundancy): the backup must be the previous committed state, not
			// a byte-identical copy of the new primary, or a primary corruption that also
			// strikes .bak loses the run. Rotate the current primary into .bak first.
			if (_existsSync(path)) {
				try {
					_writeFileSync(`${path}.bak`, _readFileSync(path, "utf8"));
				} catch {
					// best-effort; the primary publish below still succeeds
				}
			}
			_writeFileSync(`${path}.tmp`, json);
			_renameSync(`${path}.tmp`, path);
		},

		load(runId: string): PersistedRunState | null {
			assertSafeRunId(runId);
			// Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
			for (const path of candidateRunPaths(runId)) {
				for (const candidate of [path, `${path}.bak`]) {
					try {
						if (!_existsSync(candidate)) continue;
						return JSON.parse(_readFileSync(candidate, "utf-8")) as PersistedRunState;
					} catch {
						// corrupt candidate -> fall through to the next candidate
					}
				}
			}
			return null;
		},

		list(): PersistedRunState[] {
			const byRunId = new Map<string, PersistedRunState>();
			for (const dir of [runsDir]) {
				try {
					if (!_existsSync(dir)) continue;
					const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
					for (const file of files) {
						try {
							const state = JSON.parse(_readFileSync(join(dir, file), "utf-8")) as PersistedRunState;
							// runId comes from the FILE CONTENT, not the filename, so a
							// hand-edited/crafted run file can carry an unsafe id. Drop it
							// here rather than downstream: callers feed listed ids straight
							// back into load/acquireRunLease (e.g. recoverStaleRuns), where an
							// unsafe id now throws — and one such entry would abort the whole
							// recovery loop from its outer catch.
							if (!isSafeRunId(state.runId)) continue;
							if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
						} catch {
							// Skip corrupted files
						}
					}
				} catch {
					// Skip unreadable directories; another storage location may still work.
				}
			}
			// BUG (malformed updatedAt): a valid-JSON entry with an unparseable
			// updatedAt must not make the comparator return NaN (which leaves the sort
			// order unspecified). Coerce invalid dates to epoch 0.
			return [...byRunId.values()].sort((a, b) => {
				const at = a.updatedAt ? Date.parse(a.updatedAt) : NaN;
				const bt = b.updatedAt ? Date.parse(b.updatedAt) : NaN;
				const da = Number.isFinite(at) ? at : 0;
				const db = Number.isFinite(bt) ? bt : 0;
				const d = db - da;
				return Number.isNaN(d) ? 0 : d;
			});
		},

		delete(runId: string): boolean {
			assertSafeRunId(runId);
			let deleted = false;
			try {
				for (const path of candidateRunPaths(runId)) {
					// Best-effort cleanup of the sidecar files alongside the primary.
					for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(runsDir, runId)]) {
						try {
							if (_existsSync(sidecar)) _unlinkSync(sidecar);
						} catch {
							// ignore sidecar cleanup failures
						}
					}
					try {
						if (_existsSync(path)) {
							_unlinkSync(path);
							deleted = true;
						}
					} catch {
						// ignore per-file cleanup failures
					}
				}
				return deleted;
			} catch {
				return deleted;
			}
		},

		acquireRunLease(runId: string): RunLease | null {
			assertSafeRunId(runId);
			ensureDir();
			const path = primaryRunPath(runId);
			const lock = primaryLockPath(runId);
			for (let attempt = 0; attempt < 2; attempt++) {
				const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
				const payload: LockFile = {
					runId,
					runPath: path,
					pid: process.pid,
					startedAt: new Date().toISOString(),
					token,
				};
				try {
					_writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
					return { runId, token };
				} catch (err) {
					const code = (err as { code?: string }).code;
					if (code !== "EEXIST") throw err;
					const existing = readLock(runId);
					if (existing && existing.runPath === path && pidIsAlive(existing.pid)) {
						// BUG (stale-lock TTL): a lock whose pid is alive can permanently block a
						// run when the owning process was SIGKILLed and its pid was reused by an
						// unrelated long-lived process, or is a zombie on the same node. Without a
						// TTL every subsequent acquire returns null forever. Reclaim the lock when
						// it has outlived any plausible in-flight lease duration.
						const started = existing.startedAt ? Date.parse(existing.startedAt) : NaN;
						const ageMs = Number.isFinite(started) ? Date.now() - started : NaN;
						if (Number.isFinite(ageMs) && ageMs > LEASE_STALE_MS) {
							try {
								_unlinkSync(lock);
							} catch {
								return null;
							}
							continue;
						}
						return null;
					}
					try {
						_unlinkSync(lock);
					} catch {
						return null;
					}
				}
			}
			return null;
		},

		releaseRunLease(lease: RunLease): void {
			try {
				const existing = readLock(lease.runId);
				if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
			} catch {
				// Best-effort cleanup only.
			}
		},

		getRunsDir(): string {
			return runsDir;
		},
	};
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
	const timestamp = Date.now().toString(36);
	// BUG (collision): include the pid so two runs started in the same millisecond
	// by different processes can't share a runId (which would cross their saves/leases).
	const random = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	return `${timestamp}-${random}`;
}
