import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { installNativeBudgetGuard } from "./native-budget-extension.ts";

function fixture(limits = { tokenBudget: 30, maxRounds: 3, maxToolCalls: 2 }) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const api = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	const abort = vi.fn();
	const ctx = { abort, model: { api: "openai-responses" } } as unknown as ExtensionContext;
	installNativeBudgetGuard(api, limits);
	return { handlers, ctx, abort };
}

describe("native evaluation execution budget", () => {
	it("caps completions to the remaining allocation on each provider call", () => {
		const { handlers, ctx } = fixture();
		const request = handlers.get("before_provider_request")!;
		expect(request({ payload: { max_output_tokens: 100 } }, ctx).max_output_tokens).toBe(30);
		handlers.get("message_end")!({ message: { role: "assistant", usage: { totalTokens: 12 } } }, ctx);
		expect(request({ payload: { max_output_tokens: 100 } }, ctx).max_output_tokens).toBe(18);
	});
	it("aborts before buying a further model call after its token allocation is spent", () => {
		const { handlers, ctx, abort } = fixture();
		handlers.get("message_end")!({ message: { role: "assistant", usage: { totalTokens: 30 } } }, ctx);
		expect(() => handlers.get("before_provider_request")!({ payload: {} }, ctx)).toThrow(/budget exhausted/);
		expect(abort).toHaveBeenCalled();
	});
	it("blocks additional tools after the declared tool allowance", () => {
		const { handlers, ctx, abort } = fixture();
		const tool = handlers.get("tool_call")!;
		expect(tool({}, ctx)).toBeUndefined();
		expect(tool({}, ctx)).toBeUndefined();
		expect(tool({}, ctx)).toMatchObject({ block: true });
		expect(abort).toHaveBeenCalled();
	});
	it("stops at the model-round limit before another provider request", () => {
		const { handlers, ctx, abort } = fixture({ tokenBudget: 30, maxRounds: 1, maxToolCalls: 2 });
		const request = handlers.get("before_provider_request")!;
		request({ payload: {} }, ctx);
		expect(() => request({ payload: {} }, ctx)).toThrow(/budget exhausted/);
		expect(abort).toHaveBeenCalled();
	});
	it("does not permit a free further call when the provider omits usage", () => {
		const { handlers, ctx, abort } = fixture();
		handlers.get("message_end")!({ message: { role: "assistant" } }, ctx);
		expect(() => handlers.get("before_provider_request")!({ payload: {} }, ctx)).toThrow(/budget exhausted/);
		expect(abort).toHaveBeenCalled();
	});
	it("refuses a Responses call whose minimum output allowance exceeds the budget", () => {
		const { handlers, ctx, abort } = fixture({ tokenBudget: 1, maxRounds: 3, maxToolCalls: 2 });
		expect(() => handlers.get("before_provider_request")!({ payload: {} }, ctx)).toThrow(/minimum provider output allowance/);
		expect(abort).toHaveBeenCalled();
	});
});
