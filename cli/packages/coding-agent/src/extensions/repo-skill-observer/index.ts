/**
 * Repo Skill Observer — records runtime skill usage evidence.
 *
 * This is the "sensor" of the RSI loop (方向 A). It subscribes to already-
 * existing DisCo extension events and translates them into privacy-safe
 * `RepoSkillEvent` rows:
 *
 *   - read/grep/ls/find `tool_call` path  -> router/taxonomy/skill reads
 *   - bash `tool_result` referencing a skill script -> script_call
 *   - `agent_settled` -> run_settled (technical status only)
 *
 * It NEVER stores prompts, response bodies, API keys, absolute working
 * directories or raw tool stdout. It never infers task success: success
 * metrics stay null until a task_judgement source exists.
 */

import { getRepoSkillsRoot, getRsiEventsDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionHandler } from "../../core/extensions/types.ts";
import type {
	AgentSettledEvent,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
} from "../../core/extensions/types.ts";
import { posix } from "node:path";
import type { RepoSkillEvent, RepoSkillEventType, TechnicalStatus } from "./events.ts";
import { classifySkillPath } from "./classifier.ts";
import { ObserverWriter } from "./storage.ts";

export interface RepoSkillObserverOptions {
	/** Dir the writer persists into. */
	eventsDir: string;
	/** Root containing repo-skills/ and repo-skills-router/. */
	repoSkillsRoot: string;
	/** Injectable writer for tests. */
	writer?: ObserverWriter;
	/** Flush interval in ms; 0 disables the timer and relies on flush() calls. */
	flushIntervalMs?: number;
}

type ToolCallInput = Record<string, unknown>;

export class RepoSkillObserver {
	readonly writer: ObserverWriter;
	private readonly repoSkillsRoot: string;
	private readonly sessionId: string;
	private turnId = 0;
	/** Latch: any script error seen since the last run_settled. */
	private scriptErrorSinceSettle = false;

	constructor(options: RepoSkillObserverOptions) {
		this.writer =
			options.writer ??
			new ObserverWriter({ dir: options.eventsDir, flushIntervalMs: options.flushIntervalMs ?? 2000 });
		this.repoSkillsRoot = options.repoSkillsRoot;
		this.sessionId = newSessionId();
	}

	/** Handle a tool_call: classify read/grep/ls/find paths. */
	onToolCall(event: ToolCallEvent, cwd?: string): void {
		const input = event.input as ToolCallInput;
		let candidatePath: unknown;
		switch (event.toolName) {
			case "read":
			case "grep":
			case "ls":
			case "find":
				candidatePath = input.path;
				break;
			default:
				return;
		}
		if (typeof candidatePath !== "string" || !candidatePath) return;
		// BUG-P1-06: resolve relative paths against the handler's cwd so the
		// classifier sees an absolute path instead of missing the skill tree.
		const abs = toAbsolute(candidatePath, cwd);
		const cls = classifySkillPath(abs, this.repoSkillsRoot);
		if (!cls.matched || !cls.eventType) return;
		this.record(cls.eventType, cls.skillId, cls.subSkillId);
	}

	/** Handle a tool_result: detect script execution from bash commands. */
	onToolResult(event: ToolResultEvent, cwd?: string): void {
		if (event.toolName !== "bash") return;
		const command = (event.input as ToolCallInput).command;
		if (typeof command !== "string" || !command) return;
		const cls = classifyBashScript(command, this.repoSkillsRoot, cwd);
		if (!cls.matched) return;
		this.record("script_call", cls.skillId, cls.subSkillId, { isError: Boolean(event.isError) });
		if (event.isError) this.scriptErrorSinceSettle = true;
	}

	/** Handle agent_settled: record a run boundary with a technical status. */
	onRunSettled(_event: AgentSettledEvent): void {
		const status: TechnicalStatus = this.scriptErrorSinceSettle ? "tool_error" : "completed";
		this.record("run_settled", undefined, undefined, { technicalStatus: status });
		this.scriptErrorSinceSettle = false;
	}

	/** Advance the turn counter on turn boundaries. */
	onTurnEnd(event: TurnEndEvent): void {
		if (typeof event.turnIndex === "number" && event.turnIndex >= 0) {
			this.turnId = event.turnIndex + 1;
		} else {
			this.turnId += 1;
		}
	}

	/** Build a full row and enqueue it. */
	private record(
		eventType: RepoSkillEventType,
		skillId: string | undefined,
		subSkillId: string | undefined,
		extra?: Partial<Pick<RepoSkillEvent, "isError" | "technicalStatus">>,
	): void {
		const row: RepoSkillEvent = {
			schemaVersion: 1,
			eventId: newEventId(),
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			turnId: String(this.turnId),
			eventType,
		};
		if (skillId) row.skillId = skillId;
		if (subSkillId) row.subSkillId = subSkillId;
		if (extra?.isError !== undefined) row.isError = extra.isError;
		if (extra?.technicalStatus) row.technicalStatus = extra.technicalStatus;
		this.writer.enqueue(row);
	}

	/** Flush + persist the current buffer. Idempotent; safe to call on shutdown. */
	close(): void {
		this.writer.close();
	}
}

/** Fresh local session id — never a user account id. */
function newSessionId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function newEventId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Scan a bash command string for a path under a skill's `scripts/` dir.
 * Splits on quotes/whitespace, normalizes backslashes, and returns the first
 * path segment that classifies as a skill script.
 */
function classifyBashScript(
	command: string,
	repoSkillsRoot: string,
	cwd?: string,
): { matched: boolean; skillId?: string; subSkillId?: string } {
	const segments = command.split(/["'\s]/).map((p) => p.replace(/\\/g, "/"));
	for (const seg of segments) {
		if (!seg.includes("/scripts/")) continue;
		// BUG-P1-06: resolve relative script paths against cwd (e.g.
		// `python ../skills/.../script.py` executed from a project dir).
		const abs = toAbsolute(seg, cwd);
		const cls = classifySkillPath(abs, repoSkillsRoot);
		// A `scripts/` path classifies as script_read (a file read per the
		// classifier); inside a bash command that is evidence of EXECUTION, so
		// onToolResult turns it into a script_call.
		if (cls.matched && (cls.eventType === "script_read" || cls.eventType === "script_call")) {
			return { matched: true, skillId: cls.skillId, subSkillId: cls.subSkillId };
		}
	}
	return { matched: false };
}

/**
 * Resolve a path to absolute, joining against `cwd` when it is relative.
 * Backslashes are normalized to forward slashes; POSIX resolution is used so
 * behaviour is identical on Windows and Linux (the classifier speaks forward
 * slashes regardless of host platform).
 */
function toAbsolute(p: string, cwd?: string): string {
	const withSlashes = p.replace(/\\/g, "/");
	if (posix.isAbsolute(withSlashes)) return withSlashes;
	// A Windows drive/UNC root is already absolute; leave it untouched.
	if (/^[A-Za-z]:\//.test(withSlashes) || withSlashes.startsWith("//")) return withSlashes;
	if (cwd) return posix.resolve(cwd.replace(/\\/g, "/"), withSlashes);
	return withSlashes;
}

/**
 * Build the DisCo inline-extension factory for the repo-skill observer.
 * It wires the observer to existing agent events and never throws on load.
 */
export function createRepoSkillObserverExtension(disco: ExtensionAPI): void {
	const observer = new RepoSkillObserver({
		eventsDir: getRsiEventsDir(),
		repoSkillsRoot: getRepoSkillsRoot(),
	});

	const onToolCall: ExtensionHandler<ToolCallEvent, ToolCallEventResult> = (event, ctx) => {
		try {
			observer.onToolCall(event, ctx.cwd);
		} catch {
			// Observation must never break the agent turn.
		}
	};
	const onToolResult: ExtensionHandler<ToolResultEvent, ToolResultEventResult> = (event, ctx) => {
		try {
			observer.onToolResult(event, ctx.cwd);
		} catch {
			// Observation must never break the agent turn.
		}
	};
	const onTurnEnd: ExtensionHandler<TurnEndEvent> = (event) => {
		try {
			observer.onTurnEnd(event);
		} catch {
			// no-op
		}
	};
	// Deliberately void return: settle flushes, the timer owns periodic flush.
	const onAgentSettled: ExtensionHandler<AgentSettledEvent> = () => {
		try {
			observer.onRunSettled({ type: "agent_settled" });
		} catch {
			// no-op
		}
	};

	// BUG-P1-02: flush+close on any session teardown (quit/reload/new/resume/fork)
	// so a short session never loses buffered events attach to a stale timer.
	const onSessionShutdown: ExtensionHandler<SessionShutdownEvent> = () => {
		try {
			observer.close();
		} catch {
			// Observation must never break session shutdown.
		}
	};

	disco.on("tool_call", onToolCall);
	disco.on("tool_result", onToolResult);
	disco.on("turn_end", onTurnEnd);
	disco.on("agent_settled", onAgentSettled);
	disco.on("session_shutdown", onSessionShutdown);
}
