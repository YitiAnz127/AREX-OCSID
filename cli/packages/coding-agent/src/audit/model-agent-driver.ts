/**
 * A real `AgentDriver` backed by an OpenAI-compatible chat-completions endpoint.
 *
 * This is the "external prerequisite" agent-executor.ts names: `FakeAgentDriver`
 * proved the plumbing, this one actually runs a model over a case so a benchmark
 * measures skill behaviour rather than candidate-text keyword overlap.
 *
 * SCOPE OF v2 (P0-2), stated plainly — read before trusting a number it produces:
 * `run` is now a MULTI-ROUND, TOOL-USING loop, not the v1 single call. It
 * attaches tool definitions (filtered by `config.toolAllowlist`; an empty
 * allowlist means no tools → a single v1-style shot), executes model-requested
 * tool calls inside the workspace root under the sandbox in `agent-tools.ts`
 * (write-dir confined reads/writes, network-gated command execution, signal
 * propagation), feeds tool results back as `tool` messages, and only stops when
 * the model stops requesting tools (taking `content` as the artifact) or a
 * budget is exhausted (`maxRounds` / `maxToolCalls` / `tokenBudget` / `wallMs`).
 *
 * ATTRIBUTION: with tools in play a v2 score reflects the skill being *used*
 * (scripts run, files read), which is a different — and stronger — thing than
 * the v1 "did the model produce plausible text" signal measured for the same
 * artifact. The tool trajectory is recorded (`usage.toolTrace`) so a reader can
 * see exactly what ran; do NOT compare a v2 tool-loop score directly to a v1
 * single-call score as if they measured the same behaviour.
 *
 * CREDENTIAL HANDLING: the key is supplied by the caller, used only in the
 * Authorization header, and never logged, persisted, or embedded in a thrown
 * error. `redactSecrets` scrubs it from any message that could carry it.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentCaseInput,
	AgentDriver,
	AgentExecutionConfig,
	CaseWorkspace,
} from "./agent-executor.ts";
import type { AgentBudgetStop, ExecutionResult, ExecutionUsage, ToolTraceEntry } from "./types.ts";
import { executeToolCall, filterToolDefinitions } from "./agent-tools.ts";

export interface ModelAgentDriverOptions {
	/** OpenAI-compatible base URL ending at the version segment, e.g. ".../v1". */
	baseUrl: string;
	/** Bearer token. Never persisted or logged. */
	apiKey: string;
	/** Model id to request. */
	model: string;
	/** Sampling temperature; omitted from the request when undefined. */
	temperature?: number;
	/** Upper bound on generated tokens. */
	maxTokens?: number;
	/** Injectable transport so tests never touch the network. */
	fetchImpl?: typeof fetch;
	/**
	 * Byte budget for skill files injected into the prompt. The snapshot is
	 * bounded so a large skill cannot silently blow the token budget before the
	 * run even starts — SKILL.md is always included first, then siblings in
	 * deterministic order until the budget is spent.
	 */
	maxSkillContextBytes?: number;
	/**
	 * Injectable tool runner (offline tests simulate tool execution with this
	 * instead of spawning real child processes). When omitted, tools execute for
	 * real under the `agent-tools.ts` sandbox. Path/write/network validation runs
	 * on BOTH paths, so enforcement is always exercised.
	 */
	toolRunner?: import("./agent-tools.ts").ToolRunner;
	/** Driver name reported in the run record. */
	name?: string;
}

const DEFAULT_MAX_SKILL_CONTEXT_BYTES = 60_000;

/** Remove the API key from any string that might reach a log or the ledger. */
export function redactSecrets(text: string, apiKey: string): string {
	if (!apiKey || apiKey.length < 8) return text;
	return text.split(apiKey).join("<redacted-api-key>");
}

interface SkillFile {
	readonly relPath: string;
	readonly content: string;
}

/**
 * Read the frozen skill snapshot into prompt context, deterministically and
 * within a byte budget. Only regular files are considered; the snapshot was
 * already validated symlink-free at prepare time.
 */
export function readSkillContext(snapshotDir: string, byteBudget: number): { files: SkillFile[]; omitted: number; truncated: boolean } {
	const collected: Array<{ rel: string; abs: string }> = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile()) {
				collected.push({ rel: path.relative(snapshotDir, abs).split(path.sep).join("/"), abs });
			}
		}
	};
	walk(snapshotDir);

	// SKILL.md carries the skill's actual instructions, so it is never dropped for
	// a sibling that merely sorts earlier.
	collected.sort((a, b) => {
		if (a.rel === "SKILL.md") return -1;
		if (b.rel === "SKILL.md") return 1;
		return a.rel.localeCompare(b.rel);
	});

	const files: SkillFile[] = [];
	let spent = 0;
	let omitted = 0;
	let truncated = false;
	for (const { rel, abs } of collected) {
		if (spent >= byteBudget) {
			omitted += 1;
			continue;
		}
		let content: string;
		try {
			content = fs.readFileSync(abs, "utf8");
		} catch {
			omitted += 1;
			continue;
		}
		// Binary-ish content would just waste the budget; skip anything with NULs.
		if (content.includes("\u0000")) {
			omitted += 1;
			continue;
		}
		const remaining = byteBudget - spent;
		if (content.length > remaining) {
			content = content.slice(0, remaining);
			truncated = true;
		}
		spent += content.length;
		files.push({ relPath: rel, content });
	}
	return { files, omitted, truncated };
}

/** Build the two messages sent to the model. Exported for exact-output tests. */
export function buildCaseMessages(
	workspace: CaseWorkspace,
	caseInput: AgentCaseInput,
	byteBudget: number,
): { system: string; user: string; omitted: number; truncated: boolean } {
	const { files, omitted, truncated } = readSkillContext(workspace.skillSnapshotDir, byteBudget);

	const parts: string[] = [
		"You are completing a task with the help of a skill. Use the skill's files below as reference material.",
		"Answer with the artifact the task asks for, and nothing else.",
		"",
		`Skill id: ${caseInput.skillId}`,
		`Case id: ${caseInput.caseId}`,
		"",
		"--- BEGIN SKILL FILES ---",
	];
	for (const file of files) {
		parts.push(`### ${file.relPath}`, file.content, "");
	}
	if (truncated) parts.push("[note: skill context truncated to fit the prompt budget]");
	if (omitted > 0) parts.push(`[note: ${omitted} skill file(s) omitted to fit the prompt budget]`);
	parts.push("--- END SKILL FILES ---");

	return { system: parts.join("\n"), user: caseInput.userRequest, omitted, truncated };
}

interface ToolCallPayload {
	id?: unknown;
	function?: { name?: unknown; arguments?: unknown };
}

interface ChatMessagePayload {
	content?: unknown;
	tool_calls?: ToolCallPayload[] | null;
}

interface ChatCompletionResponse {
	choices?: Array<{ message?: ChatMessagePayload }>;
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
}

/** Narrow the OpenAI usage block into our own counters, ignoring junk. */
function usageFrom(raw: ChatCompletionResponse["usage"]): Pick<ExecutionUsage, "inputTokens" | "outputTokens" | "totalTokens"> {
	const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
	const inputTokens = num(raw?.prompt_tokens);
	const outputTokens = num(raw?.completion_tokens);
	const totalTokens = num(raw?.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
	return { inputTokens, outputTokens, totalTokens };
}

/**
 * Enforce the case's declared network policy. The config is hashed into
 * configDigest as a constraint, so a driver that ignored it would be attesting
 * to something it never checked.
 */
export function assertNetworkAllowed(baseUrl: string, config: AgentExecutionConfig): void {
	if (config.networkPolicy === "none") {
		throw new Error('agent driver needs network access but this case declares networkPolicy "none"');
	}
	if (config.networkPolicy === "allowlist") {
		const host = new URL(baseUrl).host;
		const allowed = config.networkAllowlist ?? [];
		if (!allowed.includes(host)) {
			throw new Error(`agent driver host "${host}" is not in the case network allowlist`);
		}
	}
}

export class ModelAgentDriver implements AgentDriver {
	readonly name: string;
	private readonly options: ModelAgentDriverOptions;

	constructor(options: ModelAgentDriverOptions) {
		if (!options.baseUrl) throw new Error("ModelAgentDriver requires a baseUrl");
		if (!options.apiKey) throw new Error("ModelAgentDriver requires an apiKey");
		if (!options.model) throw new Error("ModelAgentDriver requires a model id");
		this.options = options;
		this.name = options.name ?? `model-agent:${options.model}`;
	}

	async run(opts: {
		workspace: CaseWorkspace;
		caseInput: AgentCaseInput;
		config: AgentExecutionConfig;
		startedAt: string;
		signal?: AbortSignal;
	}): Promise<ExecutionResult> {
		const { baseUrl, apiKey, model, fetchImpl, maxSkillContextBytes, toolRunner } = this.options;
		const doFetch = fetchImpl ?? globalThis.fetch;
		assertNetworkAllowed(baseUrl, opts.config);

		const startedMs = Date.now();
		const config = opts.config;

		// P0-2: attach tool definitions filtered by the CASE's tool allowlist. An
		// empty allowlist yields no tools → a single v1-style shot.
		const tools = filterToolDefinitions(config.toolAllowlist);
		const bodyBase: Record<string, unknown> = { model };
		if (this.options.temperature !== undefined) bodyBase.temperature = this.options.temperature;
		if (this.options.maxTokens !== undefined) bodyBase.max_tokens = this.options.maxTokens;
		if (tools.length > 0) bodyBase.tools = tools;

		const seed = buildCaseMessages(opts.workspace, opts.caseInput, maxSkillContextBytes ?? DEFAULT_MAX_SKILL_CONTEXT_BYTES);
		const messages: Array<Record<string, unknown>> = [
			{ role: "system", content: seed.system },
			{ role: "user", content: seed.user },
		];

		// Budget accounting (P0-2). Each model call is one round; each executed
		// tool call counts against maxToolCalls. Token budget accumulates the
		// per-round total tokens reported by the endpoint. P2-1: maxRounds is a
		// HARD cap — the loop stops cleanly at the cap and never begins a tool
		// execution it cannot follow up within the cap (no half-done tool state,
		// no orphaned child processes).
		let round = 0;
		// Accurate model-call count (== usage.rounds); incremented on every send.
		let callsMade = 0;
		let executedToolCalls = 0;
		let accumulatedInput = 0;
		let accumulatedOutput = 0;
		let accumulatedTotal = 0;
		let usageComplete = true;
		let lastContent: string | null = null;
		const trace: ToolTraceEntry[] = [];
		// P2-1: structured record of which budget cap stopped the loop, if any.
		// Present ONLY on a budget-cap stop; null on normal completion.
		let budgetStop: AgentBudgetStop | null = null;

		async function send(): Promise<ChatCompletionResponse> {
			const body: Record<string, unknown> = { ...bodyBase, messages };
			const remainingTokens = config.tokenBudget - Math.max(accumulatedTotal, accumulatedInput + accumulatedOutput);
			body.max_tokens = Math.max(1, Math.min(typeof bodyBase.max_tokens === "number" ? bodyBase.max_tokens : remainingTokens, remainingTokens));
			let response: Response;
			try {
				response = await doFetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
					body: JSON.stringify(body),
					signal: opts.signal,
				});
			} catch (error) {
				// An abort is the executor's deadline firing, not a driver failure — let
				// it propagate so the run is recorded as timed-out rather than failed.
				if (opts.signal?.aborted) throw error;
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(redactSecrets(`model request failed: ${detail}`, apiKey));
			}
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				const snippet = text.slice(0, 400);
				throw new Error(redactSecrets(`model endpoint returned HTTP ${response.status}: ${snippet}`, apiKey));
			}
			return (await response.json()) as ChatCompletionResponse;
		}

		// Shared helper to project tool_calls back onto the message list so the
		// model always sees its own request alongside the tool results.
		function pushAssistantTrace(message: ChatMessagePayload | undefined, callPayloads: ToolCallPayload[]): void {
			messages.push({
				role: "assistant",
				content: message?.content ?? null,
				tool_calls: callPayloads.map((tc, i) => ({
					id: typeof tc.id === "string" ? tc.id : `call_${round}_${i}`,
					type: "function",
					function: {
						name: typeof tc.function?.name === "string" ? tc.function.name : "unknown",
						arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
					},
				})),
			});
		}

		// The main loop: keep calling the model until it stops asking for tools
		// (no tool_calls on this round) or a hard budget cap is hit. Tool results
		// are appended as `tool` messages so the conversation stays coherent.
		// P2-1 hard round cap: when the model requests tools on the LAST allowed
		// round (no follow-up round available within maxRounds), we do NOT execute
		// them — executing would leave half-done tool state the loop can never
		// finish. We stop cleanly and record a "maxRounds" budgetStop.
		for (; round < Math.max(1, config.maxRounds); round += 1) {
			// Token budget is enforced between rounds: do not spend another model
			// call once the accumulated tokens would exhaust the budget.
			if (
				accumulatedInput + accumulatedOutput >= Math.max(0, config.tokenBudget) ||
				accumulatedTotal >= Math.max(0, config.tokenBudget)
			) {
				if (callsMade > 0) budgetStop = { reason: "tokenBudget", rounds: callsMade };
				break;
			}

			const payload = await send();
			callsMade += 1;
			const u = usageFrom(payload.usage);
			if (u.totalTokens === undefined) usageComplete = false;
			if (typeof u.inputTokens === "number") accumulatedInput += u.inputTokens;
			if (typeof u.outputTokens === "number") accumulatedOutput += u.outputTokens;
			if (typeof u.totalTokens === "number") accumulatedTotal += u.totalTokens;
			else if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") accumulatedTotal = accumulatedInput + accumulatedOutput;

			if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

			const message = payload.choices?.[0]?.message;
			if (typeof message?.content === "string" && message.content.length > 0) lastContent = message.content;
			const callPayloads = Array.isArray(message?.tool_calls) ? message.tool_calls : null;

			// Model produced a final answer and requested no more tools → done.
			if (!callPayloads || callPayloads.length === 0) break;
			if (!usageComplete || Math.max(accumulatedTotal, accumulatedInput + accumulatedOutput) >= config.tokenBudget) {
				budgetStop = { reason: "tokenBudget", rounds: callsMade };
				break;
			}

			// P2-1 hard round cap: this round wants tools but has no follow-up
			// round left — stop before executing (clean, no half-done tool state).
			if (round + 1 >= Math.max(1, config.maxRounds)) {
				budgetStop = { reason: "maxRounds", rounds: callsMade };
				break;
			}

			// Tool budget: stop executing when we would exceed maxToolCalls. We
			// still answer the model with a refusal so the conversation terminates.
			const wouldExceed = executedToolCalls + callPayloads.length > Math.max(0, config.maxToolCalls);
			if (wouldExceed) {
				budgetStop = { reason: "maxToolCalls", rounds: callsMade };
				pushAssistantTrace(message, callPayloads);
				for (const tc of callPayloads) {
					const name = typeof tc.function?.name === "string" ? tc.function.name : "unknown";
					messages.push({
						role: "tool",
						tool_call_id: typeof tc.id === "string" ? tc.id : `call_${round}_${executedToolCalls}`,
						content: `[${name} not executed: maxToolCalls budget exhausted]`,
					});
				}
				break;
			}

			// Execute each requested tool call inside the sandboxed workspace.
			// Tool results are fed back as `tool` messages in call order.
			for (const tc of callPayloads) {
				const name = typeof tc.function?.name === "string" ? tc.function.name : "unknown";
				const argsJson = typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {});
				const toolId = typeof tc.id === "string" ? tc.id : `call_${round}_${executedToolCalls}`;
				const result = await executeToolCall(name, argsJson, { workspace: opts.workspace, config, signal: opts.signal }, toolRunner);
				trace.push(result.trace);
				executedToolCalls += 1;
				messages.push({ role: "tool", tool_call_id: toolId, content: result.output });
				if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
			}
			// Reflect the assistant's tool request back so the model sees results.
			pushAssistantTrace(message, callPayloads);
		}

		const wallMs = Date.now() - startedMs;
		const rounds = callsMade;
		const usage: ExecutionUsage = {
			modelCalls: rounds,
			rounds,
			toolCalls: executedToolCalls,
			inputTokens: usageComplete ? accumulatedInput || undefined : undefined,
			outputTokens: usageComplete ? accumulatedOutput || undefined : undefined,
			totalTokens: usageComplete ? accumulatedTotal || undefined : undefined,
			wallMs,
			...(trace.length > 0 ? { toolTrace: trace } : {}),
		};

		const artifact = lastContent;
		const stopDetail = budgetStop
			? budgetStop.reason === "maxRounds"
				? "agent loop stopped early: maxRounds exhausted while the model still requested tools"
				: budgetStop.reason === "maxToolCalls"
					? "agent loop stopped early: maxToolCalls exhausted while the model still requested tools"
					: "agent loop stopped early: token budget exhausted before the model finished"
			: undefined;

		if (typeof artifact !== "string" || artifact.trim().length === 0) {
			return {
				schema: "ocsid.execution-result.v1",
				status: "failed",
				artifact: null,
				artifactSha256: null,
				usage,
				startedAt: opts.startedAt,
				endedAt: new Date().toISOString(),
				model,
				errorKind: "model",
				error: budgetStop === null ? "model returned no message content" : `${stopDetail} and produced no final content`,
				...(budgetStop ? { budgetStop } : {}),
			};
		}

		return {
			schema: "ocsid.execution-result.v1",
			status: "succeeded",
			artifact,
			// Digest the artifact here so the ledger records what was actually
			// produced; nothing downstream recomputes it.
			artifactSha256: createHash("sha256").update(artifact, "utf8").digest("hex"),
			usage,
			startedAt: opts.startedAt,
			endedAt: new Date().toISOString(),
			model,
			error: stopDetail,
			...(budgetStop ? { budgetStop } : {}),
		};
	}
}
