import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { writeRawStdout } from "../core/output-guard.ts";

export interface NativeExecutionLimits {
	tokenBudget: number;
	maxRounds: number;
	maxToolCalls: number;
}

/** Enforce an audit allowance inside the child session, between provider calls. */
export function installNativeBudgetGuard(api: ExtensionAPI, limits: NativeExecutionLimits): void {
	let tokens = 0;
	let rounds = 0;
	let tools = 0;
	let stopped = false;
	const stop = (reason: string, ctx: ExtensionContext): void => {
		if (!stopped) {
			stopped = true;
			writeRawStdout(`${JSON.stringify({ type: "ocsid_native_budget_stop", reason })}\n`);
		}
		ctx.abort();
	};
	api.on("before_provider_request", (event, ctx) => {
		if (stopped || tokens >= limits.tokenBudget || rounds >= limits.maxRounds) {
			stop(tokens >= limits.tokenBudget ? "tokenBudget" : "maxRounds", ctx);
			throw new Error("native evaluation budget exhausted before provider request");
		}
		rounds += 1;
		const payload = event.payload as Record<string, unknown>;
		const remaining = limits.tokenBudget - tokens;
		const cap = (value: unknown): number => typeof value === "number" ? Math.min(value, remaining) : remaining;
		if (ctx.model?.api.includes("responses") || "max_output_tokens" in payload) {
			// The installed Responses adapter requires at least 16 output tokens.
			// Refuse a smaller remaining allowance instead of rounding above it.
			if (remaining < 16) {
				stop("tokenBudget", ctx);
				throw new Error("native evaluation budget cannot fund the minimum provider output allowance");
			}
			return { ...payload, max_output_tokens: cap(payload.max_output_tokens) };
		}
		if ("max_completion_tokens" in payload) return { ...payload, max_completion_tokens: cap(payload.max_completion_tokens) };
		if ("generationConfig" in payload) {
			const generation = payload.generationConfig as Record<string, unknown>;
			return { ...payload, generationConfig: { ...generation, maxOutputTokens: cap(generation.maxOutputTokens) } };
		}
		if ("inferenceConfig" in payload) {
			const inference = payload.inferenceConfig as Record<string, unknown>;
			return { ...payload, inferenceConfig: { ...inference, maxTokens: cap(inference.maxTokens) } };
		}
		if ("max_tokens" in payload || ctx.model?.api.includes("completions") || ctx.model?.api === "anthropic-messages") {
			return { ...payload, max_tokens: cap(payload.max_tokens) };
		}
		// Unknown provider schemas still get the round/token continuation guard;
		// do not add unsupported request fields to them.
		return payload;
	});
	api.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const usage = event.message.usage;
		// Unknown usage must not permit additional unaccounted model calls.
		const spent = usage?.totalTokens ?? (usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : undefined);
		tokens += spent !== undefined && Number.isFinite(spent) && spent >= 0 ? spent : limits.tokenBudget;
	});
	api.on("tool_call", (_event, ctx) => {
		if (stopped || tokens >= limits.tokenBudget || rounds >= limits.maxRounds || tools >= limits.maxToolCalls) {
			const reason = tokens >= limits.tokenBudget ? "tokenBudget" : rounds >= limits.maxRounds ? "maxRounds" : "maxToolCalls";
			stop(reason, ctx);
			return { block: true, reason: `native evaluation ${reason} exhausted` };
		}
		tools += 1;
	});
}

export default function nativeBudgetExtension(api: ExtensionAPI): void {
	const limits = JSON.parse(process.env.OCSID_EVAL_BUDGET ?? "{}") as NativeExecutionLimits;
	if (!Number.isSafeInteger(limits.tokenBudget) || limits.tokenBudget < 1 ||
		!Number.isSafeInteger(limits.maxRounds) || limits.maxRounds < 1 ||
		!Number.isSafeInteger(limits.maxToolCalls) || limits.maxToolCalls < 0) {
		throw new Error("native evaluation requires valid execution limits");
	}
	installNativeBudgetGuard(api, limits);
}
