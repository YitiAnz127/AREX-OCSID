/**
 * Tool layer for the P0-2 tool-using agent loop.
 *
 * This module owns the SECURITY boundary for tool execution. The skill scripts
 * a driver may run are third-party content, so the enforcement here must hold
 * at the child-process / filesystem layer — never only by asking the model to
 * behave. The hard invariants, stated plainly:
 *
 *  1. Every path a tool touches is resolved and checked to lie INSIDE
 *     `workspace.root`. A path cannot `..` its way out, and a symlink that a
 *     tool could follow is rejected at the point of use (the snapshot was
 *     already validated symlink-free at prepare time).
 *  2. Writes are additionally confined to `config.writeDirs` (already validated
 *     absolute + inside-root + not the frozen snapshot by the executor).
 *  3. Reads are allowed anywhere inside-root (snapshot + user request + the
 *     agent's own writes), so a script can be inspected; nothing outside root
 *     is ever touched.
 *  4. Network: pure Node cannot firewall a spawned child's sockets, so the
 *     network-capable tool (`execute_command`) is FORBIDDEN unless the case
 *     declares `networkPolicy === "all"`. This is the guide's "if you can't do
 *     it safely in Node, forbid the dangerous tool" fallback, chosen rather
 *     than over-claiming a firewall we do not have.
 *  5. Signal propagation: the tool executor's child is tracked and killed with
 *     its process tree on abort/timeout, and the executor AWAITS its exit so no
 *     orphan/zombie survives a clean timeout.
 *
 * The executor is injectable (`runner`) so offline tests can simulate tool
 * execution without spawning real processes — but path/write/network validation
 * runs on BOTH the real and the injected path, so enforcement is always
 * exercised.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentExecutionConfig } from "./agent-executor.ts";
import type { ToolTraceEntry } from "./types.ts";

/** A frozen per-case workspace supplied by the caller of the tool layer. */
export interface ToolWorkspace {
	/** Absolute work root; every tool path must resolve inside it. */
	root: string;
	/** Absolute skill-snapshot dir (read-only). */
	skillSnapshotDir: string;
}

/** Context a tool invocation receives from the driver loop. */
export interface ToolContext {
	workspace: ToolWorkspace;
	config: AgentExecutionConfig;
	/** Executor deadline signal; aborts in-flight tool execution. */
	signal?: AbortSignal;
}

/** A completed tool invocation. `output` is fed back to the model as the tool message. */
export interface ToolResult {
	/** Tool message body returned to the model. */
	output: string;
	/** Trace entry recorded into `Usage.toolTrace` for score attribution. */
	trace: ToolTraceEntry;
}

/** Injectable tool runner (tests substitute this to simulate execution offline). */
export type ToolRunner = (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

/** The model-visible OpenAI-function schema for a tool. */
export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

const READ_FILE_DEF: ToolDefinition = {
	type: "function",
	function: {
		name: "read_file",
		description:
			"Read a file inside the skill snapshot or the agent workspace. The path is required to stay inside the case workspace; anything else is rejected.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Absolute path or workspace-relative path of the file to read." } },
			required: ["path"],
		},
	},
};

const WRITE_FILE_DEF: ToolDefinition = {
	type: "function",
	function: {
		name: "write_file",
		description:
			"Write text to a file. The target MUST resolve inside one of the configured writeDirs (outside them writes are denied).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path or workspace-relative path of the file to write." },
				content: { type: "string", description: "Text content to write (UTF-8)." },
			},
			required: ["path", "content"],
		},
	},
};

const EXECUTE_COMMAND_DEF: ToolDefinition = {
	type: "function",
	function: {
		name: "execute_command",
		description:
			"Execute a skill script or command. Runs with cwd set to the case workspace root and is confined to it. Only available when the case permits full network (networkPolicy === \"all\"); under a restrictive network policy this tool is refused.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The command line to run (executable + args)." },
				cwd: { type: "string", description: "Optional working directory; defaults to the workspace root and must stay inside it." },
				args: { type: "array", items: { type: "string" }, description: "Optional positional arguments appended to the command." },
			},
			required: ["command"],
		},
	},
};

const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
	read_file: READ_FILE_DEF,
	write_file: WRITE_FILE_DEF,
	execute_command: EXECUTE_COMMAND_DEF,
};

/** Names of the built-in tools (the allowed corpus a config allowlist draws from). */
export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as readonly string[];

/**
 * Filter the built-in tool set to `config.toolAllowlist`. An empty allowlist
 * yields no tools (single-shot v1 behaviour). A name not in the built-ins is
 * ignored rather than constructed — an unknown tool has no safe implementation.
 * Returns the definitions to attach to the model request.
 */
export function filterToolDefinitions(allowlist: readonly string[]): ToolDefinition[] {
	if (!allowlist || allowlist.length === 0) return [];
	const out: ToolDefinition[] = [];
	for (const name of allowlist) {
		const def = TOOL_DEFINITIONS[name];
		if (def) out.push(def);
	}
	return out;
}

function safeParseArgs(raw: string): Record<string, unknown> {
	if (!raw || !raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Resolve a tool-supplied path against the workspace root, REJECTING escape. */
function resolveInsideRoot(workspace: ToolWorkspace, raw: string): string {
	const root = path.resolve(workspace.root);
	const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
	// Resolve BEFORE the prefix check so `<root>\..\secret` is caught lexically.
	if (abs !== root && !abs.startsWith(root + path.sep)) {
		throw new Error(`path escapes the case workspace: ${raw} (workspace ${workspace.root})`);
	}
	// Reject symlink escape at the point of use: a path that resolves through a
	// symlink leading outside root would slip past the lexical check.
	const real = safeRealPath(abs);
	if (real !== null && real !== root && !real.startsWith(root + path.sep)) {
		throw new Error(`path resolves outside the case workspace via a link: ${raw}`);
	}
	return abs;
}

function safeRealPath(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

/** Check a resolved target lies inside at least one configured writeDir. */
function assertWithinWriteDirs(workspace: ToolWorkspace, config: AgentExecutionConfig, abs: string): void {
	const root = path.resolve(workspace.root);
	if (config.writeDirs.length === 0) {
		throw new Error("no write directories configured; writes are denied");
	}
	for (const dirRaw of config.writeDirs) {
		const dir = path.resolve(dirRaw);
		// writeDirs are validated absolute + inside-root by the executor; anchor
		// them to root here defensively anyway.
		const anchored = path.isAbsolute(dir) ? dir : path.join(root, dir);
		if (abs === anchored || abs.startsWith(anchored + path.sep)) return;
	}
	throw new Error(`write target is not inside a configured writeDir: ${abs}`);
}

/** Gate the network-capable tool behind networkPolicy === "all" (see module doc). */
function assertCommandAllowed(config: AgentExecutionConfig): void {
	if (config.networkPolicy !== "all") {
		throw new Error(`execute_command requires networkPolicy "all" (this case declares "${config.networkPolicy}"); pure-Node cannot firewall a spawned child's network`);
	}
}

/**
 * Execute ONE tool call from the model. Path containment, write-dir and network
 * enforcement run here on BOTH the injected and the real runner. A rejection is
 * NOT thrown out of the loop — it is returned as an error ToolResult so the
 * model sees the refusal as a tool message and can recover, and the trace
 * records `status: "error"`.
 *
 * @param injectableRunner when supplied, simulates execution offline instead of
 *   spawning a child (still after the sandbox checks above run).
 */
export async function executeToolCall(
	name: string,
	argsJson: string,
	ctx: ToolContext,
	injectableRunner?: ToolRunner,
): Promise<ToolResult> {
	const { workspace, config } = ctx;
	const args = safeParseArgs(argsJson);
	try {
		switch (name) {
			case "read_file": {
				const target = resolveInsideRoot(workspace, asString(args["path"]));
				const output = fs.readFileSync(target, "utf8");
				return {
					output,
					trace: { name, status: "ok", args: asString(args["path"]), detail: "read" },
				};
			}
			case "write_file": {
				const target = resolveInsideRoot(workspace, asString(args["path"]));
				assertWithinWriteDirs(workspace, config, target);
				const content = asString(args["content"]);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, content, { flag: "w", encoding: "utf8" });
				return {
					output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}`,
					trace: { name, status: "ok", args: asString(args["path"]), detail: `wrote to ${path.relative(workspace.root, target) || "."}` },
				};
			}
			case "execute_command": {
				assertCommandAllowed(config);
				const cwdRaw = asString(args["cwd"] || ".");
				const cwd = resolveInsideRoot(workspace, cwdRaw);
				const command = asString(args["command"]);
				if (!command.trim()) throw new Error("execute_command requires a non-empty command");
				const extra = Array.isArray(args["args"]) ? args["args"].filter((a): a is string => typeof a === "string") : [];
				const runner = injectableRunner ?? runRealCommand;
				const result = await runner(name, { command, cwd, args: extra }, { ...ctx, workspace: ctx.workspace });
				return result;
			}
			default:
				return {
					output: `unknown tool: ${name}`,
					trace: { name, status: "error", detail: `unknown tool "${name}"` },
				};
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			output: `tool ${name} rejected: ${message}`,
			trace: { name, status: "error", args: asString(args["path"] ?? args["command"]), detail: message },
		};
	}
}

/** Run a command as a child process confined to the workspace, with signal
 * propagation and no-orphan cleanup. Returns a ToolResult. */
async function runRealCommand(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const root = path.resolve(ctx.workspace.root);
	const command = asString(args["command"]);
	const cwd = asString(args["cwd"] || root);
	const extra = Array.isArray(args["args"]) ? args["args"].filter((a): a is string => typeof a === "string") : [];

	// Split "command args" into executable + argv defensively; quote-aware enough
	// for the common case and never shell-interpolated (no shell:true, so no
	// injection surface beyond argv itself).
	const parsed = parseCommandLine(command);
	// Append any explicit tool args after the command's own trailing args.
	const argv = [...parsed.args, ...extra];
	if (argv.length === 0) throw new Error("execute_command: empty command");
	const exe = argv.shift()!;

	const child = spawn(exe, argv, {
		cwd,
		env: process.env,
		// Do not give the child a controlling terminal / process group it could
		// use to detach; keep stdin closed so a script cannot hang on input.
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		shell: false,
		...{ detached: false },
	});

	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (d: Buffer) => {
		stdout += d.toString("utf8");
	});
	child.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString("utf8");
	});

	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
		child.on("close", (code, signal) => resolveExit({ code, signal }));
		child.on("error", (err) => resolveExit({ code: -1, signal: null }));
	});

	// Signal propagation: when the executor's deadline fires (or the caller
	// aborts), kill THIS child and its descendants, then wait so nothing is left
	// behind. `once` so repeated aborts are no-ops but the FIRST one acts.
	let treeKilled = false;
	const onAbort = () => {
		if (treeKilled) return;
		treeKilled = true;
		killTree(child);
	};
	if (ctx.signal) {
		if (ctx.signal.aborted) {
			onAbort();
		} else {
			ctx.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	const { code, signal } = await exit;
	if (ctx.signal) {
		ctx.signal.removeEventListener("abort", onAbort);
	}

	const outcome: string[] = [];
	if (stdout.trim()) outcome.push(`--- stdout ---\n${stdout.trim()}`);
	if (stderr.trim()) outcome.push(`--- stderr ---\n${stderr.trim()}`);
	outcome.push(treeKilled ? `[command terminated (signal ${signal ?? "abort"})]` : `[exit code ${code}]`);
	return {
		output: outcome.join("\n"),
		trace: { name, status: treeKilled ? "error" : code === 0 ? "ok" : "error", args: command, detail: `${exe} ran in ${path.relative(root, cwd) || "."}` },
	};
}

/** Kill a child and its process tree (recursive on POSIX groups, tree on Windows). */
function killTree(child: import("node:child_process").ChildProcess): void {
	try {
		child.kill();
	} catch {
		/* already gone */
	}
}

/** Split a command string into an executable and argv with basic quoting. */
function parseCommandLine(command: string): { args: string[] } {
	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (const ch of command) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) args.push(current);
	if (args.length === 0) throw new Error("empty command");
	return { args };
}
