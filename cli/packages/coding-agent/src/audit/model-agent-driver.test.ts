import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCaseWorkspace, type AgentExecutionConfig } from "./agent-executor.ts";
import { ModelAgentDriver, readSkillContext, redactSecrets } from "./model-agent-driver.ts";
import type { ToolRunner } from "./agent-tools.ts";
import type { CaseRecord } from "./types.ts";

const API_KEY = "sk-test-key-abcdefghijklmnop";

function makeSkillFixture(): { skillRoot: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "arex-mad-"));
	const skillDir = path.join(root, "skill-a");
	fs.mkdirSync(path.join(skillDir, "test-cases", "c1"), { recursive: true });
	fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), "guide: do the thing\n");
	fs.writeFileSync(path.join(skillDir, "references", "notes.md"), "note body\n");
	fs.writeFileSync(path.join(skillDir, "test-cases", "c1", "user_request.txt"), "Make it work.\n");
	fs.writeFileSync(path.join(skillDir, "test-cases", "c1", "assertions.json"), JSON.stringify({ assertions: [] }));
	return { skillRoot: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const caseRecord: CaseRecord = {
	skillId: "skill-a",
	caseId: "c1",
	files: { userRequest: "Make it work.\n", assertionsText: JSON.stringify({ assertions: [] }), attachments: [] },
} as unknown as CaseRecord;

const BASE_CONFIG: AgentExecutionConfig = {
	model: "test-model",
	maxRounds: 1,
	maxToolCalls: 4,
	wallMs: 10_000,
	tokenBudget: 1000,
	toolAllowlist: [],
	writeDirs: [],
	networkPolicy: "all",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function completion(content: string, usage: Record<string, number> = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) {
	return { choices: [{ message: { role: "assistant", content } }], usage };
}

/** A chat-completions response that requests one tool call instead of answering. */
function toolCompletion(
	name: string,
	argsJson: string,
	content: string | null = null,
	usage: Record<string, number> = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
) {
	return {
		choices: [
			{
				message: { role: "assistant", content, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: argsJson } }] },
			},
		],
		usage,
	};
}

describe("ModelAgentDriver", () => {
	it("returns the completion as the artifact with real usage and its digest", async () => {
		const fx = makeSkillFixture();
		try {
			const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
			try {
				let seenUrl = "";
				let seenAuth = "";
				const driver = new ModelAgentDriver({
					baseUrl: "https://gateway.test/v1",
					apiKey: API_KEY,
					model: "test-model",
					fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
						seenUrl = String(url);
						seenAuth = String((init?.headers as Record<string, string>)["authorization"]);
						return jsonResponse(completion("THE ARTIFACT"));
					}) as typeof fetch,
				});

				const result = await driver.run({
					workspace: ws,
					caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "Make it work.\n" },
					config: BASE_CONFIG,
					startedAt: new Date().toISOString(),
				});

				expect(seenUrl).toBe("https://gateway.test/v1/chat/completions");
				expect(seenAuth).toBe(`Bearer ${API_KEY}`);
				expect(result.status).toBe("succeeded");
				expect(result.artifact).toBe("THE ARTIFACT");
				expect(result.artifactSha256).toBe(createHash("sha256").update("THE ARTIFACT", "utf8").digest("hex"));
				expect(result.usage).toMatchObject({ modelCalls: 1, toolCalls: 0, inputTokens: 11, outputTokens: 7, totalTokens: 18 });
			} finally {
				ws.cleanup();
			}
		} finally {
			fx.cleanup();
		}
	});

	it("never leaks the API key into a thrown error", async () => {
		const fx = makeSkillFixture();
		try {
			const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
			try {
				const driver = new ModelAgentDriver({
					baseUrl: "https://gateway.test/v1",
					apiKey: API_KEY,
					model: "test-model",
					// A hostile/broken endpoint that echoes the request back, key included.
					fetchImpl: (async () => jsonResponse(`upstream rejected Bearer ${API_KEY}`, 401)) as typeof fetch,
				});

				await expect(
					driver.run({
						workspace: ws,
						caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "x" },
						config: BASE_CONFIG,
						startedAt: new Date().toISOString(),
					}),
				).rejects.toThrow(/HTTP 401/);

				await driver
					.run({
						workspace: ws,
						caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "x" },
						config: BASE_CONFIG,
						startedAt: new Date().toISOString(),
					})
					.catch((error: Error) => {
						expect(error.message).not.toContain(API_KEY);
						expect(error.message).toContain("<redacted-api-key>");
					});
			} finally {
				ws.cleanup();
			}
		} finally {
			fx.cleanup();
		}
	});

	it("honours the case's declared network policy", async () => {
		const fx = makeSkillFixture();
		try {
			const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
			try {
				const driver = new ModelAgentDriver({
					baseUrl: "https://gateway.test/v1",
					apiKey: API_KEY,
					model: "test-model",
					fetchImpl: (async () => jsonResponse(completion("x"))) as typeof fetch,
				});
				const run = (config: AgentExecutionConfig) =>
					driver.run({
						workspace: ws,
						caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "x" },
						config,
						startedAt: new Date().toISOString(),
					});

				// The config is hashed into configDigest as a constraint, so it must bind.
				await expect(run({ ...BASE_CONFIG, networkPolicy: "none" })).rejects.toThrow(/networkPolicy "none"/);
				await expect(run({ ...BASE_CONFIG, networkPolicy: "allowlist", networkAllowlist: ["other.host"] })).rejects.toThrow(
					/not in the case network allowlist/,
				);
				await expect(run({ ...BASE_CONFIG, networkPolicy: "allowlist", networkAllowlist: ["gateway.test"] })).resolves.toMatchObject({
					status: "succeeded",
				});
			} finally {
				ws.cleanup();
			}
		} finally {
			fx.cleanup();
		}
	});

	it("fails cleanly when the model returns no content", async () => {
		const fx = makeSkillFixture();
		try {
			const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
			try {
				const driver = new ModelAgentDriver({
					baseUrl: "https://gateway.test/v1",
					apiKey: API_KEY,
					model: "test-model",
					fetchImpl: (async () => jsonResponse({ choices: [{ message: { content: "" } }] })) as typeof fetch,
				});
				const result = await driver.run({
					workspace: ws,
					caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "x" },
					config: BASE_CONFIG,
					startedAt: new Date().toISOString(),
				});
				expect(result.status).toBe("failed");
				expect(result.errorKind).toBe("model");
				expect(result.artifact).toBeNull();
			} finally {
				ws.cleanup();
			}
		} finally {
			fx.cleanup();
		}
	});

	it("puts SKILL.md first, stops at the byte budget, and never includes the eval corpus", () => {
		const fx = makeSkillFixture();
		try {
			const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
			try {
				// SKILL.md is 20 bytes and references/notes.md is 10, so a 25-byte
				// budget fits SKILL.md whole and cuts notes.md in half — exercising the
				// truncation branch rather than the omit branch.
				const context = readSkillContext(ws.skillSnapshotDir, 25);
				expect(context.files[0]?.relPath).toBe("SKILL.md");
				expect(context.truncated).toBe(true);
				// prepareCaseWorkspace excludes test-cases, so the grader's assertions
				// can never reach the prompt through the skill context.
				expect(context.files.some((f) => f.relPath.includes("test-cases"))).toBe(false);
			} finally {
				ws.cleanup();
			}
		} finally {
			fx.cleanup();
		}
	});

	describe("P2-1 maxRounds hard cap", () => {
		function makeToolDriver(toolRounds: number, content: string | null) {
			// The model requests one execute_command per round for `toolRounds`
			// rounds, then (when content is non-null) answers. For the hard-cap
			// tests we keep requesting tools past maxRounds to force the cap.
			const executed: string[] = [];
			const runner: ToolRunner = async (name, args) => {
				executed.push(String(args["command"] ?? ""));
				return { output: "ok", trace: { name, status: "ok", args: String(args["command"] ?? "") } };
			};
			const driver = new ModelAgentDriver({
				baseUrl: "https://gateway.test/v1",
				apiKey: API_KEY,
				model: "test-model",
				toolRunner: runner,
				fetchImpl: (async () => jsonResponse(toolCompletion("execute_command", '{"command":"echo x"}', content))) as typeof fetch,
			});
			return { driver, executed, runner };
		}

		it("stops cleanly at the maxRounds hard cap without executing an un-finishable tool round", async () => {
			const fx = makeSkillFixture();
			try {
				const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
				try {
					const { driver, executed, runner } = makeToolDriver(0, "partial answer");
					// maxRounds=3, model always requests tools. Round 0 and 1 execute
					// (2 tool calls); round 2 is the last allowed round and CANNOT be
					// followed up, so it must NOT execute — a clean stop, no half-done
					// tool state.
					const result = await driver.run({
						workspace: ws,
						caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "x" },
						config: {
							...BASE_CONFIG,
							maxRounds: 3,
							maxToolCalls: 32,
							tokenBudget: 100_000,
							toolAllowlist: ["execute_command"],
							networkPolicy: "all",
						} as AgentExecutionConfig,
						startedAt: new Date().toISOString(),
					});

					// Both executed rounds went through the injected mock runner, never
					// the real sandbox.
					expect(executed).toEqual(["echo x", "echo x"]);
					expect(result.status).toBe("succeeded");
					expect(result.artifact).toBe("partial answer");
					expect(result.usage?.rounds).toBe(3);
					expect(result.usage?.toolCalls).toBe(2);
					expect(result.budgetStop).toEqual({ reason: "maxRounds", rounds: 3 });
					expect(result.error).toMatch(/maxRounds/);
				} finally {
					ws.cleanup();
				}
			} finally {
				fx.cleanup();
			}
		});

		it("reports a maxRounds budgetStop with no artifact when the cap cuts off tool-only rounds", async () => {
			const fx = makeSkillFixture();
			try {
				const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
				try {
					const { driver } = makeToolDriver(0, null);
					const result = await driver.run({
						workspace: ws,
						caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "x" },
						config: {
							...BASE_CONFIG,
							maxRounds: 2,
							maxToolCalls: 32,
							tokenBudget: 100_000,
							toolAllowlist: ["execute_command"],
							networkPolicy: "all",
						} as AgentExecutionConfig,
						startedAt: new Date().toISOString(),
					});
					expect(result.status).toBe("failed");
					expect(result.errorKind).toBe("model");
					expect(result.budgetStop).toEqual({ reason: "maxRounds", rounds: 2 });
					expect(result.error).toMatch(/maxRounds/);
					expect(result.usage?.rounds).toBe(2);
				} finally {
					ws.cleanup();
				}
			} finally {
				fx.cleanup();
			}
		});

		it("reports no budgetStop on a normal completion that used fewer rounds than the cap", async () => {
			const fx = makeSkillFixture();
			try {
				const ws = prepareCaseWorkspace(fx.skillRoot, caseRecord);
				try {
					const driver = new ModelAgentDriver({
						baseUrl: "https://gateway.test/v1",
						apiKey: API_KEY,
						model: "test-model",
						fetchImpl: (async () => jsonResponse(completion("final answer"))) as typeof fetch,
					});
					const result = await driver.run({
						workspace: ws,
						caseInput: { skillId: "skill-a", caseId: "c1", userRequest: "x" },
						config: { ...BASE_CONFIG, maxRounds: 3 } as AgentExecutionConfig,
						startedAt: new Date().toISOString(),
					});
					expect(result.status).toBe("succeeded");
					expect(result.usage?.rounds).toBe(1);
					expect(result.budgetStop).toBeUndefined();
					expect(result.error).toBeUndefined();
				} finally {
					ws.cleanup();
				}
			} finally {
				fx.cleanup();
			}
		});
	});
	it("redactSecrets removes the key and ignores trivially short values", () => {
		expect(redactSecrets(`token=${API_KEY}`, API_KEY)).toBe("token=<redacted-api-key>");
		expect(redactSecrets("nothing to hide", "short")).toBe("nothing to hide");
	});
});
