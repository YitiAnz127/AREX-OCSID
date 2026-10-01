import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "child_process";
import { minimatch } from "minimatch";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { isEscapingRelative, pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

/**
 * `--no-require-git` was added in fd 9.0. Distro packages still ship 8.x
 * (Debian bookworm: 8.6), and fd treats an unknown flag as a hard error —
 * "Found argument '--no-require-git' which wasn't expected" — exiting 2 with no
 * results at all. So the flag cannot be passed unconditionally: probe the
 * binary once and remember the answer.
 *
 * Defaults to false when the version cannot be read: omitting the flag only
 * changes .gitignore handling OUTSIDE a git repo, whereas passing it on an old
 * fd breaks the search entirely.
 *
 * CONSEQUENCE OF THE FALLBACK — read before changing: with fd < 9 and a search
 * path that is not inside a git repo, fd does NOT apply .gitignore at all, so
 * `find` will list ignored files (commonly .env, credentials, build output).
 * That is exactly the behaviour issue #3303's regression test pins, and it
 * cannot be reproduced on fd 8.x because the mechanism IS the flag. The tool
 * manager normally downloads fd 10.x, so this only bites an offline host that
 * falls back to a distro fd (Debian/Ubuntu still ship 8.6). Surfacing the
 * limitation to the caller is a product decision, so it is documented rather
 * than silently worked around.
 */
const fdGitFlagSupport = new Map<string, boolean>();
export function fdSupportsNoRequireGit(fdPath: string): boolean {
	const cached = fdGitFlagSupport.get(fdPath);
	if (cached !== undefined) return cached;
	let supported = false;
	try {
		const probe = spawnSync(fdPath, ["--version"], { encoding: "utf8" });
		const match = /(\d+)\.\d+\.\d+/.exec(`${probe.stdout ?? ""}${probe.stderr ?? ""}`);
		supported = match !== null && Number(match[1]) >= 9;
	} catch {
		supported = false;
	}
	fdGitFlagSupport.set(fdPath, supported);
	return supported;
}

/** Walk up from `startPath` looking for the `.git` marker of an enclosing repo. */
async function isInsideGitRepo(startPath: string): Promise<boolean> {
	for (let current = startPath; ; ) {
		if (await pathExists(path.join(current, ".git"))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * Warn that .gitignore rules are being skipped.
 *
 * With fd < 9 the `--no-require-git` flag cannot be passed (fd treats it as an
 * unknown argument and exits 2), and without it fd applies NO .gitignore rules
 * outside a git repository. `find` then silently lists files the user expects to
 * be hidden — commonly `.env`, credentials and build output.
 *
 * Reported rather than worked around: reimplementing hierarchical .gitignore
 * handling in-process is what issue #3303 replaced, and refusing to search at
 * all would break every non-repo directory on those hosts. The notice fires only
 * when all three hold — old fd, not a repo, and a .gitignore that actually has
 * rules to skip — so it stays out of the way everywhere else.
 */
export async function ignoredRulesNotice(fdPath: string, searchPath: string): Promise<string | null> {
	if (fdSupportsNoRequireGit(fdPath)) return null;
	if (await isInsideGitRepo(searchPath)) return null;
	if (!(await pathExists(path.join(searchPath, ".gitignore")))) return null;
	return "fd < 9 does not support --no-require-git, so .gitignore rules were NOT applied (the search root is not a git repository); ignored files such as .env may appear above. Install fd >= 9 to restore ignore handling";
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
}

/**
 * List files under `searchPath` via fd WITHOUT applying a glob, so that fd's
 * native traversal semantics (respecting .gitignore per subtree, honoring
 * --hidden, --no-require-git outside repos) are preserved exactly. Returns
 * absolute paths up to `maxResults` lines.
 *
 * This is the safe primitive for path-containing globs: fd 10.5.0 hard-rejects
 * glob patterns that contain a path separator (it prints
 * `[fd error] ... path-separation character` to stderr and returns nothing),
 * so full-path matching is done in-process with minimatch instead.
 */
function listFilesViaFd(options: {
	fdPath: string;
	searchPath: string;
	maxResults: number;
	signal?: AbortSignal;
}): Promise<{ lines: string[]; stderr: string; code: number | null }> {
	const { fdPath, searchPath, maxResults, signal } = options;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		// fd [FLAGS] [PATTERN=.] [PATH]; empty/'.' pattern lists everything.
		// --no-require-git is version-gated: on fd 8.x it is an unknown flag and
		// aborts the whole listing.
		const fdArgs = ["--color=never", "--hidden"];
		if (fdSupportsNoRequireGit(fdPath)) fdArgs.push("--no-require-git");
		fdArgs.push("--type", "f", "--max-results", String(maxResults), ".", searchPath);
		const child = spawn(fdPath, fdArgs, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const lines: string[] = [];
		let stderr = "";
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			rl.close();
			fn();
		};
		const onAbort = () => {
			if (!child.killed) child.kill();
			settle(() => reject(new Error("Operation aborted")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		rl.on("line", (line) => {
			if (lines.length < maxResults) lines.push(line);
		});
		child.stderr?.on("data", (c) => {
			stderr += c.toString();
		});
		child.on("error", (error) => {
			settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
		});
		child.on("close", (code) => {
			settle(() => resolve({ lines, stderr, code }));
		});
	});
}

/**
 * True when `relativePath` (posix, relative to search root) matches a
 * user-supplied find pattern. Handles path-containing and baseline globs with
 * full-path semantics; preserves a leading negating `/` if present.
 */
function fileMatchesPattern(pattern: string, relativePath: string): boolean {
	let p = pattern;
	if (p.startsWith("/")) p = p.slice(1);
	return minimatch(relativePath, p, { dot: true });
}

/**
 * Relativize one line of fd output against the search root, returning a posix
 * relative path — or `null` when the result escapes the root and must be
 * dropped. Results above the root are reachable only through a symlink
 * traversal, so surfacing one would report an out-of-workspace file as an
 * ordinary in-root match. (P0-02 containment.)
 *
 * The prefix test requires a separator: a sibling directory that merely shares
 * the prefix (`/proj/a` vs `/proj/ab/x`) is NOT under the root, and stripping by
 * raw length would mangle it into a bogus in-root name instead of falling
 * through to path.relative.
 */
export function relativizeFindResult(line: string, searchPath: string): string | null {
	const isUnderRoot =
		line !== searchPath && (line.startsWith(`${searchPath}/`) || line.startsWith(`${searchPath}${path.sep}`));
	const relativePath = isUnderRoot ? line.slice(searchPath.length + 1) : path.relative(searchPath, line);
	if (isEscapingRelative(relativePath)) return null;
	return toPosixPath(relativePath) || null;
}

function formatFindCall(args: { pattern: string; path?: string; limit?: number } | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let settled = false;
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							// Relativize paths against the search root for stable output.
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
								return toPosixPath(path.relative(searchPath, p));
							});
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							return;
						}

						// Default implementation uses fd.
						//
						// fd 10.5.0 hard-rejects glob patterns containing a path
						// separator (prints "[fd error] ... path-separation character"
						// to stderr and returns nothing), so path-containing globs are
						// handled by listing candidates with fd (preserving its native
						// .gitignore/hidden traversal semantics) and matching the full
						// relative path in-process with minimatch. Basename globs keep
						// the established fd --glob path below.
						if (pattern.includes("/")) {
							const fdPath = await ensureTool("fd", true);
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!fdPath) {
								settle(() => reject(new Error("fd is not available and could not be downloaded")));
								return;
							}
							// Cap candidate listing high enough to find `limit` matches
							// while bounding pathological trees; matching is in-process.
							const candidateCap = Math.max(effectiveLimit * 20, 10_000);
							const res = await listFilesViaFd({
								fdPath,
								searchPath,
								maxResults: candidateCap,
								signal,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (res.code !== 0 && res.lines.length === 0) {
								const errorMsg = res.stderr.trim() || `fd exited with code ${res.code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							const matched: string[] = [];
							for (const rawLine of res.lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								// Relativize + containment: an escaping result (only reachable via
								// symlink traversal) is dropped rather than let a `*/*.txt`-style
								// pattern match `..` and surface an out-of-root file. Mirrors the
								// containment check on the basename-glob branch below. (P0-02)
								const posix = relativizeFindResult(line, searchPath);
								if (posix === null) continue;
								if (fileMatchesPattern(pattern, posix)) matched.push(posix);
							}
							const totalMatches = matched.length;
							if (totalMatches === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}
							const selected = matched.slice(0, effectiveLimit);
							const resultLimitReached = totalMatches > effectiveLimit;
							const rawOutput = selected.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							const ignoreNotice = await ignoredRulesNotice(fdPath, searchPath);
							if (ignoreNotice) notices.push(ignoreNotice);
							if (resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							return;
						}

						const fdPath = await ensureTool("fd", true);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}

						const args: string[] = ["--glob", "--color=never", "--hidden"];

						// fd normally ignores .gitignore outside git repos, so keep --no-require-git
						// there. Inside repos, use fd's default git-aware behavior so parent
						// .gitignore rules stop at nested repo boundaries:
						// https://github.com/earendil-works/pi/issues/5960
						let insideGitRepo = false;
						for (let current = searchPath; ; ) {
							if (await pathExists(path.join(current, ".git"))) {
								insideGitRepo = true;
								break;
							}
							const parent = path.dirname(current);
							if (parent === current) break;
							current = parent;
						}
						// Version-gated: fd 8.x (still what Debian/Ubuntu ship) errors out
						// on this flag instead of ignoring it.
						if (!insideGitRepo && fdSupportsNoRequireGit(fdPath)) args.push("--no-require-git");
						// Computed HERE, not at the result site: the result is assembled
						// inside child.on("close", ...) below, which is not an async context.
						const ignoreNotice = await ignoredRulesNotice(fdPath, searchPath);
						args.push("--max-results", String(effectiveLimit));

						// fd --glob matches against the basename unless --full-path is set; in --full-path
						// mode it matches against the absolute candidate path, so a path-containing
						// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
						let effectivePattern = pattern;
						if (pattern.includes("/")) {
							args.push("--full-path");
							if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
								effectivePattern = `**/${pattern}`;
							}
						}
						args.push("--", effectivePattern, searchPath);

						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const output = lines.join("\n");
							if (code !== 0) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
								let relativePath = line;
								if (line.startsWith(searchPath)) {
									relativePath = line.slice(searchPath.length + 1);
								} else {
									relativePath = path.relative(searchPath, line);
								}
								// Containment: fd can return a path above the search root only via
								// symlink traversal — drop such escaping results rather than surface
								// an out-of-root match. (P0-02)
								if (isEscapingRelative(relativePath)) {
									continue;
								}
								if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
								relativized.push(toPosixPath(relativePath));
							}

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (ignoreNotice) notices.push(ignoreNotice);
							if (resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
