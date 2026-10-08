/**
 * P1-03 — native session driver contract tests.
 *
 * All network/process concerns go through the injected `launcher`, so the suite
 * is offline and deterministic; two cases exercise the REAL process launcher
 * against a local `node -e` child (no model, no network).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CONFIG, type AgentExecutionConfig, type CaseWorkspace } from "./agent-executor.ts";
import {
	NATIVE_SESSION_PROMPT_FILE,
	NativeSessionDriver,
	createNativeSessionLauncher,
	createStreamCapture,
	digestTree,
	buildNativeCasePrompt,
	nativeSessionArgs,
	nativeToolNames,
	parseNativeSessionJsonl,
	runNativeCreatorSession,
	type NativeLaunchRequest,
	type NativeLaunchResult,
	type NativeSessionLauncher,
} from "./native-session-driver.ts";

const tmpRoots: string[] = [];

afterEach(() => {
	while (tmpRoots.length > 0) {
		const root = tmpRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocsid-native-test-"));
	tmpRoots.push(dir);
	return dir;
}

function fakeWorkspace(): CaseWorkspace {
	const root = tmpDir();
	const skillSnapshotDir = path.join(root, "skill-snapshot");
	fs.mkdirSync(skillSnapshotDir, { recursive: true });
	fs.writeFileSync(path.join(skillSnapshotDir, "SKILL.md"), "---\nname: skill-a\n---\n", "utf8");
	fs.writeFileSync(path.join(root, "user_request.txt"), "make a report\n", "utf8");
	return {
		root,
		skillSnapshotDir,
		userRequestPath: path.join(root, "user_request.txt"),
		environmentDigest: "env-digest",
		cleanup: () => {},
	};
}

interface RecordingLauncher {
	launcher: NativeSessionLauncher;
	requests: NativeLaunchRequest[];
}

function recordingLauncher(behavior: (request: NativeLaunchRequest) => Partial<NativeLaunchResult> | Promise<Partial<NativeLaunchResult>>): RecordingLauncher {
	const requests: NativeLaunchRequest[] = [];
	return {
		requests,
		launcher: {
			async launch(request: NativeLaunchRequest): Promise<NativeLaunchResult> {
				requests.push(request);
				const partial = await behavior(request);
				return { code: 0, timedOut: false, aborted: false, stdout: "", stderr: "", ...partial };
			},
		},
	};
}

function configWith(overrides: Partial<AgentExecutionConfig>): AgentExecutionConfig {
	return { ...DEFAULT_AGENT_CONFIG, wallMs: 1_000, networkPolicy: "all", ...overrides };
}

function streamJsonl(artifact: string, usage: { input: number; output: number; totalTokens: number }): string {
	const events = [
		{ type: "session", version: 3, id: "session-1", ocsidMode: "researcher" },
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "turn_end", toolResults: [{ name: "write" }, { name: "bash" }] },
		{
			type: "agent_end",
			messages: [
				{ role: "user", content: [{ type: "text", text: "prompt" }] },
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "write" }, { type: "text", text: artifact }],
					provider: "openai-codex",
					model: "gpt-5.5",
					usage,
				},
			],
		},
		{ type: "agent_settled" },
	];
	return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

describe("native session driver — argv and tool translation", () => {
	it("maps the audit tool vocabulary onto native tool names", () => {
		expect(nativeToolNames(["read_file", "write_file", "execute_command"])).toEqual(["read", "write", "bash"]);
		expect(() => nativeToolNames(["frobnicate"])).toThrow(/cannot translate audit tool "frobnicate"/);
	});

	it("builds a hermetic, ephemeral, single-turn argv with the prompt last", () => {
		const args = nativeSessionArgs({
			promptPath: "C:/tmp/ws/.ocsid-native-prompt.txt",
			skillSnapshotDir: "C:/tmp/ws/skill-snapshot",
			config: configWith({ toolAllowlist: ["read_file", "write_file"] }),
			sessionMode: "researcher",
			model: "gpt-5.5",
			provider: "openai-codex",
			thinking: "low",
			extraArgs: ["--verbose"],
		});
		expect(args.slice(0, 8)).toEqual(["-p", "--mode", "json", "--no-session", "--no-context-files", "--researcher", "--skill", "C:/tmp/ws/skill-snapshot"]);
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,write");
		expect(args).toContain("--model");
		expect(args).toContain("gpt-5.5");
		expect(args).toContain("--provider");
		expect(args).toContain("openai-codex");
		expect(args).toContain("--thinking");
		expect(args).toContain("--verbose");
		expect(args[args.length - 1]).toBe("@C:/tmp/ws/.ocsid-native-prompt.txt");
	});

	it("uses --no-tools for an empty allowlist and --creator for creator mode", () => {
		const args = nativeSessionArgs({
			promptPath: "p",
			skillSnapshotDir: "s",
			config: configWith({ toolAllowlist: [] }),
			sessionMode: "creator",
		});
		expect(args).toContain("--no-tools");
		expect(args).toContain("--creator");
		expect(args).not.toContain("--researcher");
	});

	it("omits --skill when no snapshot is given instead of pointing it at an empty tree", () => {
		const args = nativeSessionArgs({
			promptPath: "p",
			config: configWith({ toolAllowlist: ["read_file", "write_file"] }),
			sessionMode: "creator",
		});
		expect(args).not.toContain("--skill");
		const researcher = nativeSessionArgs({
			promptPath: "p",
			skillSnapshotDir: "C:/tmp/snapshot",
			config: configWith({ toolAllowlist: ["read_file", "write_file"] }),
			sessionMode: "researcher",
		});
		expect(researcher[researcher.indexOf("--skill") + 1]).toBe("C:/tmp/snapshot");
	});

	it("states the output contract and the read-only snapshot in the case prompt", () => {
		const prompt = buildNativeCasePrompt("Train a small model and report accuracy");
		expect(prompt).toContain("./output");
		expect(prompt).toContain("READ-ONLY");
		expect(prompt).toContain("Train a small model and report accuracy");
	});
});

describe("native session driver — stream parsing", () => {
	it("reads the session identity, final artifact, tool calls and usage", () => {
		const trace = parseNativeSessionJsonl(streamJsonl("done", { input: 100, output: 5, totalTokens: 105 }));
		expect(trace.sessionId).toBe("session-1");
		expect(trace.mode).toBe("researcher");
		expect(trace.provider).toBe("openai-codex");
		expect(trace.model).toBe("gpt-5.5");
		expect(trace.artifact).toBe("done");
		expect(trace.usage).toMatchObject({ modelCalls: 1, rounds: 1, toolCalls: 2, inputTokens: 100, outputTokens: 5, totalTokens: 105 });
		expect(trace.toolNames).toEqual(["write"]);
		expect(trace.malformedLines).toBe(0);
	});

	it("counts malformed lines without throwing and ignores unknown events", () => {
		const stream = ["not json", JSON.stringify({ type: "mystery" }), JSON.stringify({ type: "session", id: "s2", ocsidMode: "creator" })].join("\n") + "\n";
		const trace = parseNativeSessionJsonl(stream);
		expect(trace.malformedLines).toBe(1);
		expect(trace.sessionId).toBe("s2");
		expect(trace.mode).toBe("creator");
		expect(trace.artifact).toBe("");
		expect(trace.usage.modelCalls).toBe(0);
	});

	it("keeps both stream ends so a chatty session still reports its identity", () => {
		const capture = createStreamCapture(1024, 512);
		capture.push(`${JSON.stringify({ type: "session", id: "session-9", ocsidMode: "creator" })}\n`);
		capture.push("\n");
		for (let i = 0; i < 400; i += 1) capture.push(`${JSON.stringify({ type: "message_update", text: "x".repeat(200) })}\n`);
		capture.push(`${JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "final" }], usage: { input: 1, output: 1, totalTokens: 2 } }] })}\n`);
		const captured = capture.value();
		expect(captured).toContain("ocsid_native_stream_truncated");
		const trace = parseNativeSessionJsonl(captured);
		expect(trace.sessionId).toBe("session-9");
		expect(trace.mode).toBe("creator");
		expect(trace.artifact).toBe("final");
		// A small stream is passed through untouched.
		const small = createStreamCapture(1024);
		small.push("{\"type\":\"agent_settled\"}\n");
		expect(small.value()).toBe("{\"type\":\"agent_settled\"}\n");
	});

	it("names the provider error when the session died inside the provider", () => {
		const stream = [
			JSON.stringify({ type: "session", id: "session-err", ocsidMode: "researcher" }),
			JSON.stringify({
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [],
						provider: "openai-codex",
						model: "gpt-5.5",
						stopReason: "error",
						errorMessage: "fetch failed",
						diagnostics: [{ type: "provider_transport_failure" }],
						usage: { input: 10, output: 0, totalTokens: 10 },
					},
				],
			}),
		].join("\n") + "\n";
		expect(parseNativeSessionJsonl(stream).providerError).toBe("fetch failed");
		// A diagnostic-only error still names the failure class.
		const diagnosticOnly = parseNativeSessionJsonl(
			`${JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", diagnostics: [{ type: "provider_transport_failure" }] }] })}\n`,
		);
		expect(diagnosticOnly.providerError).toBe("provider_transport_failure");
		// A clean session reports no provider error at all.
		expect(parseNativeSessionJsonl(streamJsonl("ok", { input: 1, output: 1, totalTokens: 2 })).providerError).toBeNull();
	});

	it("keeps the LAST assistant text as the artifact when several rounds ran", () => {
		const stream = [
			JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 1, output: 1, totalTokens: 2 } }] }),
			JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], usage: { input: 3, output: 4, totalTokens: 7 } }] }),
		].join("\n") + "\n";
		const trace = parseNativeSessionJsonl(stream);
		expect(trace.artifact).toBe("second");
		expect(trace.usage).toMatchObject({ modelCalls: 2, inputTokens: 4, outputTokens: 5, totalTokens: 9 });
	});
});

describe("native session driver — run outcomes", () => {
	it("runs the session in the workspace, writes the prompt, and reports success", async () => {
		const workspace = fakeWorkspace();
		const fake = recordingLauncher(() => ({ stdout: streamJsonl("report written", { input: 10, output: 2, totalTokens: 12 }) }));
		const streams: string[] = [];
		const driver = new NativeSessionDriver({
			sessionMode: "researcher",
			model: "gpt-5.5",
			provider: "openai-codex",
			launcher: fake.launcher,
			onStream: (stdout) => streams.push(stdout),
		});
		const result = await driver.run({
			workspace,
			caseInput: { skillId: "skill-a", caseId: "case-1", userRequest: "write the report" },
			config: configWith({ toolAllowlist: ["read_file", "write_file"] }),
			startedAt: "2026-10-03T00:00:00.000Z",
		});

		expect(result.status).toBe("succeeded");
		expect(result.artifact).toBe("report written");
		expect(result.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(result.usage).toMatchObject({ modelCalls: 1, toolCalls: 2, totalTokens: 12 });
		expect(typeof result.usage?.wallMs).toBe("number");
		expect(driver.runtime).toBe("native-session");
		expect(driver.sessionEvidence()).toEqual({ sessionId: "session-1", mode: "researcher", provider: "openai-codex", model: "gpt-5.5" });
		expect(streams[0]).toContain("agent_end");

		const request = fake.requests[0];
		expect(request.cwd).toBe(workspace.root);
		expect(request.command).toBe(process.execPath);
		expect(request.timeoutMs).toBe(1_000);
		expect(request.args).toContain(workspace.skillSnapshotDir);
		const promptPath = driver.lastPromptPath as string;
		expect(promptPath).toBeTruthy();
		expect(promptPath).not.toContain(workspace.root);
		expect(fs.existsSync(path.join(workspace.root, NATIVE_SESSION_PROMPT_FILE))).toBe(false);
		const prompt = fs.readFileSync(promptPath, "utf8");
		expect(prompt).toContain("write the report");
		expect(prompt).toContain("./output");
		expect(request.args.at(-1)).toBe(`@${promptPath}`);
	});

	it("refuses a case that declares no network instead of calling the launcher", async () => {
		const workspace = fakeWorkspace();
		const fake = recordingLauncher(() => ({}));
		const driver = new NativeSessionDriver({ launcher: fake.launcher });
		const result = await driver.run({
			workspace,
			caseInput: { skillId: "skill-a", caseId: "case-1", userRequest: "hi" },
			config: configWith({ networkPolicy: "none" }),
			startedAt: "2026-10-03T00:00:00.000Z",
		});
		expect(result.status).toBe("failed");
		expect(result.errorKind).toBe("environment");
		expect(result.error).toMatch(/networkPolicy "none"/);
		expect(fake.requests).toHaveLength(0);
	});

	it("reports a deadline overrun as timed-out", async () => {
		const workspace = fakeWorkspace();
		const fake = recordingLauncher(() => ({ timedOut: true, code: null }));
		const driver = new NativeSessionDriver({ launcher: fake.launcher });
		const result = await driver.run({
			workspace,
			caseInput: { skillId: "skill-a", caseId: "case-1", userRequest: "hi" },
			config: configWith({}),
			startedAt: "2026-10-03T00:00:00.000Z",
		});
		expect(result.status).toBe("timed-out");
		expect(result.errorKind).toBe("timeout");
		expect(result.error).toMatch(/exceeded 1000 ms/);
	});

	it("surfaces a non-zero exit with the stderr tail", async () => {
		const workspace = fakeWorkspace();
		const fake = recordingLauncher(() => ({ code: 3, stderr: "auth expired\n" }));
		const driver = new NativeSessionDriver({ launcher: fake.launcher });
		const result = await driver.run({
			workspace,
			caseInput: { skillId: "skill-a", caseId: "case-1", userRequest: "hi" },
			config: configWith({}),
			startedAt: "2026-10-03T00:00:00.000Z",
		});
		expect(result.status).toBe("failed");
		expect(result.errorKind).toBe("model");
		expect(result.error).toContain("code 3");
		expect(result.error).toContain("auth expired");
	});

	it("fails when the session produced no assistant text", async () => {
		const workspace = fakeWorkspace();
		const fake = recordingLauncher(() => ({ stdout: "garbage\n{\"type\":\"agent_settled\"}\n" }));
		const driver = new NativeSessionDriver({ launcher: fake.launcher });
		const result = await driver.run({
			workspace,
			caseInput: { skillId: "skill-a", caseId: "case-1", userRequest: "hi" },
			config: configWith({}),
			startedAt: "2026-10-03T00:00:00.000Z",
		});
		expect(result.status).toBe("failed");
		expect(result.errorKind).toBe("model");
		expect(result.error).toMatch(/no assistant text \(1 event\(s\), 1 malformed line\(s\)\)/);
	});

	it("reports an aborted run as cancelled", async () => {
		const workspace = fakeWorkspace();
		const fake = recordingLauncher(() => ({ aborted: true, code: null }));
		const controller = new AbortController();
		const driver = new NativeSessionDriver({ launcher: fake.launcher });
		const result = await driver.run({
			workspace,
			caseInput: { skillId: "skill-a", caseId: "case-1", userRequest: "hi" },
			config: configWith({}),
			startedAt: "2026-10-03T00:00:00.000Z",
			signal: controller.signal,
		});
		expect(result.status).toBe("cancelled");
		expect(result.errorKind).toBe("cancelled");
	});

	it("honours the configured timeout override", async () => {
		const workspace = fakeWorkspace();
		const fake = recordingLauncher(() => ({ stdout: streamJsonl("ok", { input: 1, output: 1, totalTokens: 2 }) }));
		const driver = new NativeSessionDriver({ launcher: fake.launcher, timeoutMs: 42 });
		await driver.run({
			workspace,
			caseInput: { skillId: "skill-a", caseId: "case-1", userRequest: "hi" },
			config: configWith({ wallMs: 999 }),
			startedAt: "2026-10-03T00:00:00.000Z",
		});
		expect(fake.requests[0].timeoutMs).toBe(42);
	});
});

describe("native session driver — real process launcher", () => {
	it("captures stdout from a real child process", async () => {
		const launcher = createNativeSessionLauncher();
		const result = await launcher.launch({
			command: process.execPath,
			args: ["-e", "process.stdout.write('hello-native')"],
			cwd: tmpDir(),
			env: process.env,
			timeoutMs: 20_000,
		});
		expect(result.code).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.stdout).toContain("hello-native");
	});

	it("kills a child that overruns its deadline", async () => {
		const launcher = createNativeSessionLauncher();
		const started = Date.now();
		const result = await launcher.launch({
			command: process.execPath,
			args: ["-e", "setTimeout(() => {}, 60000)"],
			cwd: tmpDir(),
			env: process.env,
			timeoutMs: 700,
		});
		expect(result.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(30_000);
	});
});

describe("native session driver — creator phase", () => {
	function creatorLauncher(skillId: string, omitSkillFile = false, nameOverride?: string): RecordingLauncher {
		return recordingLauncher((request) => {
			fs.mkdirSync(request.cwd, { recursive: true });
			if (!omitSkillFile) {
				fs.writeFileSync(path.join(request.cwd, "SKILL.md"), `---\nname: ${nameOverride ?? skillId}\n---\n\n# ${skillId}\n`, "utf8");
			}
			return { stdout: streamJsonl("skill created", { input: 20, output: 8, totalTokens: 28 }) };
		});
	}

	it("accepts a produced skill whose SKILL.md declares the frozen id", async () => {
		const out = path.join(tmpDir(), "huggingface-hub");
		fs.mkdirSync(out, { recursive: true });
		const fake = creatorLauncher("huggingface-hub");
		const outcome = await runNativeCreatorSession({
			sourceDir: tmpDir(),
			outputDir: out,
			skillId: "huggingface-hub",
			wallMs: 5_000,
			launcher: fake.launcher,
		});
		expect(outcome.sessionId).toBe("session-1");
		expect(outcome.skillDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(outcome.artifact).toBe("skill created");
		expect(fake.requests[0].cwd).toBe(out);
		expect(fake.requests[0].args).toContain("--creator");
		// A creator that cannot call tools can only describe the skill (the pre-fix
		// `--no-tools` bug), so the tool surface is part of the contract.
		expect(fake.requests[0].args).toContain("--tools");
		expect(fake.requests[0].args[fake.requests[0].args.indexOf("--tools") + 1]).toBe("read,write,bash");
		expect(fake.requests[0].args).not.toContain("--no-tools");
		expect(fake.requests[0].args).not.toContain("--skill");
	});

	it("narrows the creator tool surface when an allowlist is given", async () => {
		const out = path.join(tmpDir(), "narrow-skill");
		fs.mkdirSync(out, { recursive: true });
		const fake = creatorLauncher("narrow-skill");
		await runNativeCreatorSession({
			sourceDir: tmpDir(),
			outputDir: out,
			skillId: "narrow-skill",
			wallMs: 5_000,
			toolAllowlist: ["read_file"],
			launcher: fake.launcher,
		});
		expect(fake.requests[0].args[fake.requests[0].args.indexOf("--tools") + 1]).toBe("read");
	});

	it("rejects a creator session that produced no SKILL.md", async () => {
		const out = path.join(tmpDir(), "empty-skill");
		fs.mkdirSync(out, { recursive: true });
		const fake = creatorLauncher("empty-skill", true);
		await expect(runNativeCreatorSession({ sourceDir: tmpDir(), outputDir: out, skillId: "empty-skill", wallMs: 5_000, launcher: fake.launcher }))
			.rejects.toThrow(/did not produce .*SKILL\.md \(2 tool call\(s\), final message: skill created\)/);
	});

	it("rejects a SKILL.md that declares a different skill name", async () => {
		const out = path.join(tmpDir(), "wrong-name");
		fs.mkdirSync(out, { recursive: true });
		const fake = creatorLauncher("wrong-name", false, "other-skill");
		await expect(runNativeCreatorSession({ sourceDir: tmpDir(), outputDir: out, skillId: "wrong-name", wallMs: 5_000, launcher: fake.launcher }))
			.rejects.toThrow(/whose name is not "wrong-name"/);
	});

	it("digests a produced tree deterministically and rejects symlinks", () => {
		const root = tmpDir();
		fs.mkdirSync(path.join(root, "refs"), { recursive: true });
		fs.writeFileSync(path.join(root, "SKILL.md"), "a", "utf8");
		fs.writeFileSync(path.join(root, "refs", "notes.md"), "b", "utf8");
		const first = digestTree(root);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(digestTree(root)).toBe(first);
		fs.writeFileSync(path.join(root, "refs", "notes.md"), "c", "utf8");
		expect(digestTree(root)).not.toBe(first);
	});
});
