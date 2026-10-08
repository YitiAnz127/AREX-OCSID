/**
 * P1-03 鈥?the native OCSID session driver.
 *
 * The `--executor agent` path uses `ModelAgentDriver`, which POSTs straight to an
 * OpenAI-compatible endpoint with a skill snapshot pasted into the prompt. That
 * path never exercises the native OCSID architecture: skill discovery, the
 * router, or the dynamic-workflow tool surface. This driver is the missing
 * adapter 鈥?it runs a REAL `ocsid` session as a child process, inside the case
 * workspace, with the frozen skill snapshot loaded through `--skill`.
 *
 * Design constraints (every one of them is testable through the `launcher` seam):
 *  - The session is EPHEMERAL (`--no-session`): an evaluation must never write
 *    into the operator's session store and must never resume a human session.
 *  - The child's cwd is the case workspace root, and only `./output` is graded,
 *    so the prompt states that contract explicitly.
 *  - The prompt travels as a `@file` attachment, so a case request containing
 *    dashes or newlines can never be re-parsed as CLI flags.
 *  - The tool allowlist and write dirs come from the validated
 *    `AgentExecutionConfig`; the CLI's `["read_file","write_file"]` becomes a
 *    call-site default instead of a hard architectural limit (a scientific case
 *    can ask for `execute_command`, which maps to the native `bash` tool).
 *  - The audit-side tool vocabulary is mapped explicitly onto native tool names;
 *    an unknown audit tool is REJECTED rather than silently dropped (a session
 *    that quietly ran without the tools a case asked for would still attest to
 *    the requested allowlist).
 *  - A deadline (or abort) kills the whole child process tree, so no orphaned
 *    `ocsid` process survives a timed-out evaluation.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCaseInput, AgentDriver, AgentExecutionConfig, CaseWorkspace } from "./agent-executor.ts";
import type { ExecutionResult, ExecutionUsage } from "./types.ts";

export const NATIVE_SESSION_DRIVER_NAME = "ocsid-native-session";

/** How much child output is retained (truncated from the FRONT, keeping the tail). */
export const NATIVE_SESSION_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Name of the prompt attachment written inside the run directory. */
export const NATIVE_SESSION_PROMPT_FILE = ".ocsid-native-prompt.txt";

/**
 * Audit-side tool names mapped onto the native CLI's tool names. `undefined`
 * means "not an audit tool this driver can translate".
 */
const NATIVE_TOOL_ALIASES: Record<string, string> = {
	read_file: "read",
	write_file: "write",
	execute_command: "bash",
};

export function nativeToolNames(allowlist: readonly string[]): string[] {
	return allowlist.map((tool) => {
		const mapped = NATIVE_TOOL_ALIASES[tool];
		if (mapped === undefined) {
			throw new Error(`native session driver cannot translate audit tool "${tool}" (known: ${Object.keys(NATIVE_TOOL_ALIASES).join(", ")})`);
		}
		return mapped;
	});
}

export interface NativeLaunchRequest {
	command: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface NativeLaunchResult {
	code: number | null;
	timedOut: boolean;
	aborted: boolean;
	stdout: string;
	stderr: string;
}

/** The process seam. Tests inject a fake; production uses the real spawner. */
export interface NativeSessionLauncher {
	launch(request: NativeLaunchRequest): Promise<NativeLaunchResult>;
}

function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		// A native session spawns tool children of its own; /T kills the tree.
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

/** The production launcher: spawn, capture, deadline/abort, process-tree kill. */
export function createNativeSessionLauncher(): NativeSessionLauncher {
	return {
		launch(request: NativeLaunchRequest): Promise<NativeLaunchResult> {
			return new Promise<NativeLaunchResult>((resolve) => {
				const child = spawn(request.command, [...request.args], {
					cwd: request.cwd,
					env: request.env,
					stdio: ["ignore", "pipe", "pipe"],
					detached: process.platform !== "win32",
					windowsHide: true,
				});
				let settled = false;
				let timedOut = false;
				let aborted = false;
				const stdoutCapture = createStreamCapture();
				const stderrCapture = createStreamCapture();
				child.stdout?.setEncoding("utf8");
				child.stderr?.setEncoding("utf8");
				child.stdout?.on("data", (chunk: string) => { stdoutCapture.push(chunk); });
				child.stderr?.on("data", (chunk: string) => { stderrCapture.push(chunk); });
				const timer = setTimeout(() => {
					timedOut = true;
					killTree(child.pid);
				}, Math.max(1, request.timeoutMs));
				const onAbort = (): void => {
					aborted = true;
					killTree(child.pid);
				};
				request.signal?.addEventListener("abort", onAbort, { once: true });
				const finish = (code: number | null): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					request.signal?.removeEventListener("abort", onAbort);
					resolve({ code, timedOut, aborted, stdout: stdoutCapture.value(), stderr: stderrCapture.value() });
				};
				child.on("error", (error: Error) => {
					stderrCapture.push(`${error.message}\n`);
					finish(null);
				});
				child.on("close", (code: number | null) => finish(code));
			});
		},
	};
}

/** Bytes of stream HEAD kept when the stream overflows the retention window. */
export const NATIVE_SESSION_HEAD_BYTES = 256 * 1024;

/**
 * Bounded stdout/stderr retention that keeps BOTH ends. The session identity and
 * mode are in the first event of the stream, while the final assistant artifact is
 * in the last one, so a tail-only window can lose the identity of a chatty session.
 */
export function createStreamCapture(limit = NATIVE_SESSION_MAX_OUTPUT_BYTES, headLimit = NATIVE_SESSION_HEAD_BYTES): { push(chunk: string): void; value(): string } {
	let head = "";
	let tail = "";
	let truncated = false;
	const tailOf = (text: string): string => (text.length > limit ? text.slice(-limit) : text);
	return {
		push(chunk: string): void {
			if (head.length < headLimit) {
				const room = headLimit - head.length;
				head += chunk.slice(0, room);
				const rest = chunk.slice(room);
				if (rest.length === 0) return;
				truncated = true;
				tail = tailOf(tail + rest);
				return;
			}
			truncated = true;
			tail = tailOf(tail + chunk);
		},
		value(): string {
			if (!truncated) return head;
			const marker = JSON.stringify({
				type: "ocsid_native_stream_truncated",
				note: `stream exceeded the retention window; the first ${headLimit} bytes and the last ${limit} bytes are kept`,
			});
			return `${head}\n${marker}\n${tail}`;
		},
	};
}

/**
 * What one native session stream revealed. `artifact` is the FINAL assistant
 * text; usage is summed over the assistant messages in `agent_end` (each message
 * is one model round, and the event stream repeats partial updates, so counting
 * events would over-report).
 */
export interface NativeSessionTrace {
	sessionId: string | null;
	mode: string | null;
	provider: string | null;
	model: string | null;
	artifact: string;
	usage: ExecutionUsage;
	eventCount: number;
	malformedLines: number;
	toolNames: string[];
	/**
	 * Why the provider gave up, when it did. A session that dies inside the
	 * provider (transport/rate-limit/auth) produces no assistant text at all, and
	 * "no assistant text" alone is indistinguishable from a driver bug — so the
	 * first provider-reported error is carried out of the stream.
	 */
	providerError: string | null;
	budgetStop?: string;
}

interface JsonRecord {
	[k: string]: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const record = asRecord(part);
		if (record && record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("");
}

function toolNamesOfContent(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const part of content) {
		const record = asRecord(part);
		if (!record) continue;
		if ((record.type === "toolCall" || record.type === "tool_use" || record.type === "tool-call") && typeof record.name === "string") {
			names.push(record.name);
		}
	}
	return names;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The provider-side reason for an errored assistant turn. PI records the raw
 * message (`errorMessage`) and, for classified failures, a diagnostic list whose
 * first entry names the failure type (e.g. `provider_transport_failure`).
 */
function providerErrorOf(message: JsonRecord): string {
	if (typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0) {
		return message.errorMessage.trim();
	}
	const diagnostics = message.diagnostics;
	if (Array.isArray(diagnostics)) {
		for (const raw of diagnostics) {
			const diagnostic = asRecord(raw);
			if (diagnostic && typeof diagnostic.type === "string" && diagnostic.type.length > 0) return diagnostic.type;
		}
	}
	return "provider error";
}

/**
 * Parse the `--mode json` JSONL stream of one session run. Unknown event types
 * and malformed lines are counted, never fatal: a session that died mid-stream
 * must still yield whatever usage/artifact it did emit.
 */
export function parseNativeSessionJsonl(stdout: string): NativeSessionTrace {
	const trace: NativeSessionTrace = {
		sessionId: null,
		mode: null,
		provider: null,
		model: null,
		artifact: "",
		usage: {},
		eventCount: 0,
		malformedLines: 0,
		toolNames: [],
		providerError: null,
	};
	let inputTokens = 0;
	let outputTokens = 0;
	let totalTokens = 0;
	let tokensSeen = false;
	let rounds = 0;
	let toolCalls = 0;
	const toolNames = new Set<string>();
	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			trace.malformedLines += 1;
			continue;
		}
		const event = asRecord(parsed);
		if (!event) {
			trace.malformedLines += 1;
			continue;
		}
		trace.eventCount += 1;
		if (event.type === "session") {
			if (typeof event.id === "string") trace.sessionId = event.id;
			if (typeof event.ocsidMode === "string") trace.mode = event.ocsidMode;
			continue;
		}
		if (event.type === "ocsid_native_budget_stop" && typeof event.reason === "string") {
			trace.budgetStop = event.reason;
			continue;
		}
		if (event.type === "turn_end") {
			const results = event.toolResults;
			if (Array.isArray(results)) toolCalls += results.length;
			continue;
		}
		if (event.type !== "agent_end") continue;
		const messages = event.messages;
		if (!Array.isArray(messages)) continue;
		for (const raw of messages) {
			const message = asRecord(raw);
			if (!message || message.role !== "assistant") continue;
			rounds += 1;
			if (typeof message.provider === "string") trace.provider = message.provider;
			if (typeof message.model === "string") trace.model = message.model;
			if (trace.providerError === null && message.stopReason === "error") {
				trace.providerError = providerErrorOf(message);
			}
			for (const name of toolNamesOfContent(message.content)) toolNames.add(name);
			const text = textOfContent(message.content);
			if (text.trim().length > 0) trace.artifact = text;
			const usage = asRecord(message.usage);
			if (usage) {
				const input = numberOf(usage.input);
				const output = numberOf(usage.output);
				const total = numberOf(usage.totalTokens);
				if (input !== undefined) { inputTokens += input; tokensSeen = true; }
				if (output !== undefined) { outputTokens += output; tokensSeen = true; }
				if (total !== undefined) { totalTokens += total; tokensSeen = true; }
			}
		}
	}
	trace.toolNames = [...toolNames];
	trace.usage = {
		modelCalls: rounds,
		rounds,
		toolCalls,
		...(tokensSeen ? { inputTokens, outputTokens, totalTokens } : {}),
	};
	return trace;
}

/** The workspace contract every native case run states to the session. */
export function buildNativeCasePrompt(userRequest: string): string {
	return [
		"You are executing ONE frozen OCSID use case inside an isolated workspace.",
		"",
		"Contracts:",
		"  - The working directory is the case workspace. Write every deliverable under ./output (relative to the working directory).",
		"  - Files outside ./output are ignored when the result is graded.",
		"  - ./skill-snapshot holds the frozen skill for this case and is READ-ONLY.",
		"",
		"Use case request:",
		userRequest.trim(),
		"",
	].join("\n");
}

/** The Creator鈫扲esearcher (P1-03) prompt for the Creator phase. */
export function buildCreatorPrompt(opts: { sourceDir: string; outputDir: string; skillId: string; request?: string }): string {
	return [
		`Create an OCSID skill package for the repository material at ${opts.sourceDir}.`,
		"",
		"Contracts:",
		`  - Write the skill to ${opts.outputDir} (create the directory if needed).`,
		"  - The package MUST contain a SKILL.md with YAML frontmatter whose `name` field is exactly \"" + opts.skillId + "\".",
		"  - Keep it minimal but executable: SKILL.md plus at most a few reference files.",
		"  - Do not write outside the output directory.",
		...(opts.request ? ["", "The skill must be able to serve this request:", opts.request.trim()] : []),
		"",
	].join("\n");
}

export interface NativeSessionArgsOptions {
	promptPath: string;
	/**
	 * A read-only skill snapshot to load. Optional: the Creator phase gets its
	 * source material from the prompt (the source directory is not a skill
	 * package), so `--skill` is omitted rather than pointed at an empty tree.
	 */
	skillSnapshotDir?: string;
	config: AgentExecutionConfig;
	sessionMode: "researcher" | "creator";
	provider?: string;
	model?: string;
	thinking?: string;
	extraArgs?: readonly string[];
}

/** Build the argv for one native session run (exported so tests pin the contract). */
export function nativeSessionArgs(opts: NativeSessionArgsOptions): string[] {
	const tools = nativeToolNames(opts.config.toolAllowlist);
	const args: string[] = [
		"-p",
		"--mode", "json",
		"--no-session",
		"--no-context-files",
		opts.sessionMode === "creator" ? "--creator" : "--researcher",
	];
	if (opts.skillSnapshotDir !== undefined) args.push("--skill", opts.skillSnapshotDir);
	if (tools.length === 0) args.push("--no-tools");
	else args.push("--tools", tools.join(","));
	if (opts.provider !== undefined) args.push("--provider", opts.provider);
	if (opts.model !== undefined) args.push("--model", opts.model);
	if (opts.thinking !== undefined) args.push("--thinking", opts.thinking);
	if (opts.extraArgs) args.push(...opts.extraArgs);
	// The prompt is an @file attachment: flags can never be forged from case text.
	args.push(`@${opts.promptPath}`);
	return args;
}

function defaultCliEntry(): string {
	// Compiled layout: dist/audit/native-session-driver.js -> dist/cli.js
	return fileURLToPath(new URL("../cli.js", import.meta.url));
}

/** Prompts live in a temp directory, never inside a graded workspace or skill tree. */
function tempPromptPath(label: string): string {
	return path.join(os.tmpdir(), "ocsid-native-prompts", `${label}-${process.pid}-${Date.now()}.txt`);
}

/** Keep the informative END of a stream/message: the head is scaffolding. */
function tailText(text: string, limit = 600): string {
	const trimmed = text.trim();
	return trimmed.length > limit ? `...${trimmed.slice(-limit)}` : trimmed;
}

export interface NativeSessionRunOptions {
	prompt: string;
	cwd: string;
	sessionMode: "researcher" | "creator";
	wallMs: number;
	skillSnapshotDir?: string;
	config?: AgentExecutionConfig;
	/**
	 * Where the `@file` prompt attachment is written. Defaults to the run cwd,
	 * but the driver and the Creator phase send it to a temp directory so the
	 * graded workspace (and a produced skill tree) never contains harness files.
	 */
	promptPath?: string;
	cliEntry?: string;
	nodePath?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	extraArgs?: readonly string[];
	env?: Record<string, string>;
	launcher?: NativeSessionLauncher;
	signal?: AbortSignal;
}

export interface NativeSessionRunOutcome {
	args: readonly string[];
	promptPath: string;
	launched: NativeLaunchResult;
	trace: NativeSessionTrace;
}

/**
 * Run one native session (no audit machinery): write the prompt, launch the
 * real CLI, parse the stream. Shared by the audit driver and the Creator phase.
 */
export async function runNativeSession(options: NativeSessionRunOptions): Promise<NativeSessionRunOutcome> {
	const config = options.config ?? {
		model: options.model ?? "native/default",
		maxRounds: 0,
		maxToolCalls: 0,
		wallMs: options.wallMs,
		tokenBudget: 0,
		toolAllowlist: [],
		writeDirs: [],
		networkPolicy: "all" as const,
	};
	const promptPath = options.promptPath ?? path.join(options.cwd, NATIVE_SESSION_PROMPT_FILE);
	fs.mkdirSync(options.cwd, { recursive: true });
	fs.mkdirSync(path.dirname(promptPath), { recursive: true });
	fs.writeFileSync(promptPath, options.prompt, "utf8");
	// The child is `node <cli entry> <session argv>`: running the built CLI is
	// what makes this the NATIVE path (its own skill discovery + router + tools)
	// rather than a hand-rolled API loop.
	const args = [
		options.cliEntry ?? defaultCliEntry(),
		...nativeSessionArgs({
			promptPath,
			...(options.skillSnapshotDir !== undefined ? { skillSnapshotDir: options.skillSnapshotDir } : {}),
			config,
			sessionMode: options.sessionMode,
			...(options.provider !== undefined ? { provider: options.provider } : {}),
			...(options.model !== undefined ? { model: options.model } : {}),
			...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
			...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
		}),
	];
	const launcher = options.launcher ?? createNativeSessionLauncher();
	const bounded = config.tokenBudget > 0 && config.maxRounds > 0;
	if (bounded) {
		const extension = fileURLToPath(new URL(`./native-budget-extension${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
		args.splice(args.length - 1, 0, "--extension", extension);
	}
	const launched = await launcher.launch({
		command: options.nodePath ?? process.execPath,
		args,
		cwd: options.cwd,
		env: { ...process.env, ...(options.env ?? {}), ...(bounded ? {
			OCSID_EVAL_BUDGET: JSON.stringify({ tokenBudget: config.tokenBudget, maxRounds: config.maxRounds, maxToolCalls: config.maxToolCalls }),
		} : {}) },
		timeoutMs: options.wallMs,
		...(options.signal ? { signal: options.signal } : {}),
	});
	return { args, promptPath, launched, trace: parseNativeSessionJsonl(launched.stdout) };
}

export interface NativeSessionDriverOptions {
	cliEntry?: string;
	nodePath?: string;
	sessionMode?: "researcher" | "creator";
	provider?: string;
	model?: string;
	thinking?: string;
	extraArgs?: readonly string[];
	env?: Record<string, string>;
	launcher?: NativeSessionLauncher;
	/** Overrides `config.wallMs` when set. */
	timeoutMs?: number;
	name?: string;
	/** Receives the raw `--mode json` stream so the caller can archive it. */
	onStream?: (stdout: string, stderr: string) => void;
}

/**
 * The `AgentDriver` that runs a real OCSID session. It declares
 * `runtime: "native-session"`, which is what makes the audit ledger label its
 * scores differently from the direct model-API driver.
 */
export class NativeSessionDriver implements AgentDriver {
	readonly name: string;
	readonly runtime = "native-session" as const;
	private readonly options: NativeSessionDriverOptions;
	private trace: NativeSessionTrace | null = null;
	private promptPath: string | null = null;

	constructor(options: NativeSessionDriverOptions = {}) {
		this.options = options;
		this.name = options.name ?? `${NATIVE_SESSION_DRIVER_NAME}:${options.sessionMode ?? "researcher"}`;
	}

	/** Identity of the session that produced the last score (P1-03 evidence). */
	sessionEvidence(): { sessionId: string | null; mode: string | null; provider: string | null; model: string | null } | null {
		if (!this.trace) return null;
		return {
			sessionId: this.trace.sessionId,
			mode: this.trace.mode ?? this.options.sessionMode ?? null,
			provider: this.trace.provider,
			model: this.trace.model ?? this.options.model ?? null,
		};
	}

	get lastTrace(): NativeSessionTrace | null {
		return this.trace;
	}

	/** Absolute path of the prompt attachment used by the last run (evidence). */
	get lastPromptPath(): string | null {
		return this.promptPath;
	}

	async run(opts: {
		workspace: CaseWorkspace;
		caseInput: AgentCaseInput;
		config: AgentExecutionConfig;
		startedAt: string;
		signal?: AbortSignal;
	}): Promise<ExecutionResult> {
		const config = opts.config;
		const startedMs = Date.now();
		const sessionMode = this.options.sessionMode ?? "researcher";
		const fail = (errorKind: ExecutionResult["errorKind"], error: string, trace?: NativeSessionTrace): ExecutionResult => ({
			schema: "ocsid.execution-result.v1",
			status: errorKind === "timeout" ? "timed-out" : errorKind === "cancelled" ? "cancelled" : "failed",
			artifact: null,
			artifactSha256: null,
			usage: { ...(trace?.usage ?? {}), wallMs: Date.now() - startedMs },
			startedAt: opts.startedAt,
			endedAt: new Date().toISOString(),
			model: this.options.model ?? trace?.model ?? config.model,
			errorKind,
			error,
		});

		if (config.networkPolicy === "none") {
			return fail("environment", 'native session needs model network access, but this case declares networkPolicy "none"');
		}

		let outcome: NativeSessionRunOutcome;
		try {
			outcome = await runNativeSession({
				prompt: buildNativeCasePrompt(opts.caseInput.userRequest),
				cwd: opts.workspace.root,
				sessionMode,
				wallMs: this.options.timeoutMs ?? config.wallMs,
				skillSnapshotDir: opts.workspace.skillSnapshotDir,
				config,
				promptPath: tempPromptPath("case"),
				...(this.options.cliEntry !== undefined ? { cliEntry: this.options.cliEntry } : {}),
				...(this.options.nodePath !== undefined ? { nodePath: this.options.nodePath } : {}),
				...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
				...(this.options.model !== undefined ? { model: this.options.model } : {}),
				...(this.options.thinking !== undefined ? { thinking: this.options.thinking } : {}),
				...(this.options.extraArgs ? { extraArgs: this.options.extraArgs } : {}),
				...(this.options.env ? { env: this.options.env } : {}),
				...(this.options.launcher ? { launcher: this.options.launcher } : {}),
				...(opts.signal ? { signal: opts.signal } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail("environment", `native session launcher failed: ${message}`);
		}

		const { launched, trace } = outcome;
		this.trace = trace;
		this.promptPath = outcome.promptPath;
		this.options.onStream?.(launched.stdout, launched.stderr);
		const tail = (text: string): string => tailText(text);
		const wallMs = Date.now() - startedMs;
		trace.usage = { ...trace.usage, wallMs };
		if (launched.timedOut) return fail("timeout", `native session exceeded ${this.options.timeoutMs ?? config.wallMs} ms`, trace);
		if (launched.aborted || opts.signal?.aborted) return fail("cancelled", "native session was aborted before it settled", trace);
		if (trace.budgetStop) return fail("other", `native session exhausted ${trace.budgetStop}`, trace);
		if (launched.code !== 0) {
			return fail(launched.code === null ? "environment" : "model", `native session exited with code ${launched.code}: ${tail(launched.stderr)}`, trace);
		}
		if (trace.artifact.trim().length === 0) {
			const provider = trace.providerError ? `; provider error: ${trace.providerError}` : "";
			return fail("model", `native session produced no assistant text (${trace.eventCount} event(s), ${trace.malformedLines} malformed line(s))${provider}`, trace);
		}
		return {
			schema: "ocsid.execution-result.v1",
			status: "succeeded",
			artifact: trace.artifact,
			artifactSha256: createHash("sha256").update(trace.artifact, "utf8").digest("hex"),
			usage: trace.usage,
			startedAt: opts.startedAt,
			endedAt: new Date().toISOString(),
			model: this.options.model ?? trace.model ?? config.model,
		};
	}
}

/**
 * Creator-phase tool allowlist (audit vocabulary). The Creator is not the graded
 * phase 鈥?its output is checked structurally (SKILL.md frontmatter + tree digest)
 * 鈥?and distillation needs to inspect the source repository, so it defaults to a
 * usable set that callers may narrow or extend.
 */
export const CREATOR_TOOL_ALLOWLIST: readonly string[] = ["read_file", "write_file", "execute_command"];

export interface NativeCreatorOptions {
	sourceDir: string;
	outputDir: string;
	skillId: string;
	wallMs: number;
	request?: string;
	toolAllowlist?: readonly string[];
	provider?: string;
	model?: string;
	thinking?: string;
	cliEntry?: string;
	nodePath?: string;
	launcher?: NativeSessionLauncher;
	env?: Record<string, string>;
	onStream?: (stdout: string, stderr: string) => void;
}

export interface NativeCreatorOutcome {
	sessionId: string | null;
	mode: string | null;
	provider: string | null;
	model: string | null;
	skillDir: string;
	skillDigest: string;
	artifact: string;
	usage: ExecutionUsage;
}

/**
 * The P1-03 Creator phase: run a native Creator session that writes a skill
 * package, then verify the package is real (a `SKILL.md` with the frozen skill id
 * in its `name` field) before the Researcher phase is allowed to score it.
 */
export async function runNativeCreatorSession(options: NativeCreatorOptions): Promise<NativeCreatorOutcome> {
	const prompt = buildCreatorPrompt({ sourceDir: options.sourceDir, outputDir: options.outputDir, skillId: options.skillId, ...(options.request ? { request: options.request } : {}) });
	fs.mkdirSync(options.outputDir, { recursive: true });
	const outcome = await runNativeSession({
		prompt,
		cwd: options.outputDir,
		sessionMode: "creator",
		wallMs: options.wallMs,
		promptPath: tempPromptPath(`creator-${options.skillId}`),
		config: {
			model: options.model ?? "native/default",
			maxRounds: 0,
			maxToolCalls: 0,
			wallMs: options.wallMs,
			tokenBudget: 0,
			toolAllowlist: [...(options.toolAllowlist ?? CREATOR_TOOL_ALLOWLIST)],
			writeDirs: [],
			networkPolicy: "all",
		},
		...(options.provider !== undefined ? { provider: options.provider } : {}),
		...(options.model !== undefined ? { model: options.model } : {}),
		...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
		...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
		...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
		...(options.launcher ? { launcher: options.launcher } : {}),
		...(options.env ? { env: options.env } : {}),
	});
	options.onStream?.(outcome.launched.stdout, outcome.launched.stderr);
	const providerSuffix = outcome.trace.providerError ? `; provider error: ${outcome.trace.providerError}` : "";
	if (outcome.launched.timedOut) throw new Error(`creator session exceeded ${options.wallMs} ms${providerSuffix}; final message: ${tailText(outcome.trace.artifact)}`);
	if (outcome.launched.code !== 0) throw new Error(`creator session exited with code ${outcome.launched.code}${providerSuffix}: ${outcome.launched.stderr.trim().slice(-400)}`);
	const skillFile = path.join(options.outputDir, "SKILL.md");
	if (!fs.existsSync(skillFile) || !fs.lstatSync(skillFile).isFile()) {
		throw new Error(
			`creator session did not produce ${skillFile} (${outcome.trace.usage.toolCalls ?? 0} tool call(s)${providerSuffix}, final message: ${tailText(outcome.trace.artifact)})`,
		);
	}
	const declared = /^---\r?\n[\s\S]*?^name:\s*"?([^"\r\n]+)"?\s*$/m.exec(fs.readFileSync(skillFile, "utf8"));
	if (!declared || declared[1].trim() !== options.skillId) {
		throw new Error(`creator session produced a SKILL.md whose name is not "${options.skillId}"`);
	}
	return {
		sessionId: outcome.trace.sessionId,
		mode: outcome.trace.mode,
		provider: outcome.trace.provider,
		model: outcome.trace.model,
		skillDir: options.outputDir,
		skillDigest: digestTree(options.outputDir),
		artifact: outcome.trace.artifact,
		usage: { ...outcome.trace.usage, wallMs: outcome.launched.timedOut ? options.wallMs : outcome.trace.usage.wallMs },
	};
}

/** Deterministic digest of a produced skill tree (files only, sorted, symlinks rejected). */
export function digestTree(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			const stat = fs.lstatSync(full);
			if (stat.isSymbolicLink()) throw new Error(`skill tree contains a symbolic link: ${full}`);
			if (stat.isDirectory()) {
				walk(full);
				continue;
			}
			if (!stat.isFile()) continue;
			const relative = path.relative(root, full).split(path.sep).join("/");
			lines.push(`${relative}\t${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
		}
	};
	walk(root);
	lines.sort();
	return createHash("sha256").update(lines.join("\n") + "\n", "utf8").digest("hex");
}
