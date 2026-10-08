#!/usr/bin/env node
/**
 * A local, deterministic OpenAI **Responses** API double.
 *
 * Why this exists (P1-03): the native session driver (`NativeSessionDriver`)
 * launches a real child process, so proving the Creator→Researcher path needs a
 * real provider endpoint. When the machine's outbound proxy is down, every real
 * provider call fails with `fetch failed` — which says nothing about OCSID. This
 * server speaks just enough of the Responses API (SSE) to let a *real* session,
 * driving *real* tools, in a *real* workspace, complete deterministically.
 *
 * It is a test double, never a measurement: every run that uses it must be
 * labelled as such (the smoke prints that label).
 *
 * Usage:
 *   node scripts/mock-openai-responses.mjs [--port=0]
 *
 * Then point the Azure-compatible provider at it:
 *   AZURE_OPENAI_BASE_URL=http://127.0.0.1:<port>
 *   AZURE_OPENAI_API_KEY=mock
 *   AZURE_OPENAI_API_VERSION=v1
 *   ocsid ... --provider azure-openai-responses --model gpt-4.1
 *
 * Scripted behaviour (keyed off the prompt the session actually sends):
 *   - Creator phase  (prompt contains "Create an OCSID skill package"): one
 *     `write` tool call that creates `SKILL.md` whose frontmatter `name` is the
 *     skill id from the prompt, then a final text turn.
 *   - Researcher phase (anything else): one `write` tool call that creates
 *     `output/answer.md` containing `NATIVE-E2E`, then a final text turn.
 */
import http from "node:http";

const portArg = process.argv.slice(2).find((value) => value.startsWith("--port="));
const requestedPort = portArg ? Number(portArg.slice("--port=".length)) : 0;
const CREATOR_MARKER = "Create an OCSID skill package";
const RESEARCHER_ARTIFACT = "# Answer\n\nNATIVE-E2E\n";

function usage(inputTokens = 120, outputTokens = 20) {
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: inputTokens + outputTokens,
		input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	};
}

/** Decide the single scripted turn for this request. */
function planTurn(body) {
	const text = JSON.stringify(body ?? {});
	const alreadyRanATool = text.includes("function_call_output");
	if (text.includes(CREATOR_MARKER)) {
		if (alreadyRanATool) return { kind: "text", text: "creator finished: SKILL.md written" };
		const match = /exactly "([^"]+)"/.exec(text);
		const skillId = match ? match[1] : "mock-skill";
		return {
			kind: "tool",
			name: "write",
			arguments: {
				path: "SKILL.md",
				content: `---\nname: ${skillId}\ndescription: deterministic mock package (P1-03 harness)\n---\n\n# ${skillId}\n\nCreated by the local Responses-API double; not a real distillation.\n`,
			},
		};
	}
	if (alreadyRanATool) return { kind: "text", text: "researcher finished: output/answer.md written" };
	return { kind: "tool", name: "write", arguments: { path: "output/answer.md", content: RESEARCHER_ARTIFACT } };
}

function sendEvent(response, type, payload) {
	response.write(`event: ${type}\n`);
	response.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function finish(response, output) {
	sendEvent(response, "response.completed", {
		response: { id: "resp_mock", status: "completed", output, usage: usage() },
	});
	response.write("data: [DONE]\n\n");
	response.end();
}

function emitText(response, text) {
	const item = { type: "message", id: "msg_mock", status: "completed", role: "assistant", content: [] };
	sendEvent(response, "response.created", { response: { id: "resp_mock", status: "in_progress", output: [] } });
	sendEvent(response, "response.output_item.added", { output_index: 0, item });
	sendEvent(response, "response.output_text.delta", { output_index: 0, item_id: item.id, delta: text });
	const done = { ...item, content: [{ type: "output_text", text, annotations: [] }] };
	sendEvent(response, "response.output_item.done", { output_index: 0, item: done });
	finish(response, [done]);
}

function emitToolCall(response, plan) {
	const item = { type: "function_call", id: "fc_mock", call_id: "call_mock", name: plan.name, arguments: "" };
	const argsJson = JSON.stringify(plan.arguments);
	sendEvent(response, "response.created", { response: { id: "resp_mock", status: "in_progress", output: [] } });
	sendEvent(response, "response.output_item.added", { output_index: 0, item });
	sendEvent(response, "response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: argsJson });
	sendEvent(response, "response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: argsJson });
	const done = { ...item, arguments: argsJson, status: "completed" };
	sendEvent(response, "response.output_item.done", { output_index: 0, item: done });
	finish(response, [done]);
}

const server = http.createServer((request, response) => {
	if (request.method !== "POST") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ object: "list", data: [] }));
		return;
	}
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			body = {};
		}
		const plan = planTurn(body);
		process.stderr.write(`[mock-openai-responses] ${request.url} -> ${plan.kind}${plan.kind === "tool" ? ` ${plan.name}` : ""}\n`);
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		if (plan.kind === "tool") emitToolCall(response, plan);
		else emitText(response, plan.text);
	});
});

server.listen(requestedPort, "127.0.0.1", () => {
	const address = server.address();
	process.stdout.write(`MOCK_OPENAI_RESPONSES_URL=http://127.0.0.1:${address.port}\n`);
});
