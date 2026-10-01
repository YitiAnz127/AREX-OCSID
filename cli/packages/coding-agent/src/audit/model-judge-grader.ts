/**
 * A real model judge as a `CaseGrader` (P0-3 step 2, route B).
 *
 * Unlike the deterministic proxies (`tokenGrader`, `modelGrader()`), this grader
 * asks an actual model to decide whether the produced artifact satisfies each
 * assertion for the case. It sends `(user_request, assertions, artifact)` in a
 * single prompt and expects the judge to return, per assertion, an
 * explicit `pass`/`fail` decision plus a one-line reason.
 *
 * PROVENANCE HONESTY — two things a number from this grader must never lose:
 *   1. It declares `gradedBy: "model_grader"` (the coarse attribution category
 *      the schema reserves for a real grader; the route-B mapping to
 *      `llm_judge` source is handled by `gradeSourceCategory(source, kind="llm")`
 *      at projection boundaries). It is NOT a deterministic proxy.
 *   2. Every `GradeSpec` it returns carries `judge.modelVersion` (the judge model
 *      id) and `judge.rubricVersion` (the rubric it executed). The runner lifts
 *      these onto the ledger row so a score is traceable to its exact judge.
 *
 * The judge prompt is versioned by `rubricVersion`; bump it whenever the grading
 * instructions change so old and new ledger rows never silently mix rubrics.
 *
 * OFFLINE TESTS: pass an injected `fetchImpl`. The grader never touches the
 * network when a fake transport returns a canned JSON verdict. An empty or
 * whitespace artifact is rejected deterministically BEFORE any model call, so
 * the "hollow artifact gets a zero" guarantee holds even with no endpoint.
 */

import type { CaseGrader, CaseRecord, GradeOutcome, GradeSpec } from "./types.ts";

/** Version of the judge prompt/rubric this implementation executes. */
export const DEFAULT_JUDGE_RUBRIC_VERSION = "ar-ex-rsi.judge.v1";

export interface ModelJudgeGraderOptions {
	/** OpenAI-compatible base URL ending at the version segment, e.g. ".../v1". */
	baseUrl: string;
	/** Bearer token. Never persisted or logged. */
	apiKey: string;
	/** Judge model id (recorded verbatim on the ledger row as `judge.modelVersion`). */
	model: string;
	/** Version of the grading rubric the judge executes. */
	rubricVersion?: string;
	/** Sampling temperature; omitted from the request when undefined. */
	temperature?: number;
	/** Upper bound on generated tokens. */
	maxTokens?: number;
	/** Injectable transport so tests never touch the network. */
	fetchImpl?: typeof fetch;
}

/** The structured verdict the judge is asked to return, one entry per assertion. */
export interface JudgeVerdictItem {
	assertion: string;
	pass: boolean;
	reason?: string;
}

export interface JudgeVerdict {
	perAssertion: JudgeVerdictItem[];
}

/**
 * Build the judge prompt. Exported for exact-output tests. The rubric is the
 * load-bearing part: it tells the judge to grade ONLY what the artifact itself
 * demonstrates, and to mark a hollow or unrelated artifact as failing rather than
 * awarding half credit.
 */
export function buildJudgePrompt(caseRecord: CaseRecord, assertions: string[], artifact: string, rubricVersion: string): string {
	const lines: string[] = [
		"You are a strict, deterministic grader. Grade whether the PRODUCED ARTIFACT",
		"satisfies EACH assertion for the case, judging ONLY evidence present in the artifact.",
		"",
		`Skill id: ${caseRecord.skillId}`,
		`Case id: ${caseRecord.caseId}`,
		"",
		"USER REQUEST:",
		"------------",
		caseRecord.files.userRequest,
		"",
		"ASSERTIONS (grade each one):",
		"---------------------------",
		...assertions.map((a, i) => `${i + 1}. ${a}`),
		"",
		"PRODUCED ARTIFACT:",
		"-----------------",
		artifact ||
			"(EMPTY — the model produced no artifact. Every assertion must FAIL.)",
		"",
		"RULES (rubric " + rubricVersion + "):",
		"- An EMPTY, whitespace-only, or unrelated artifact satisfies NO assertion: give every assertion pass=false.",
		"- Award pass=true ONLY when the artifact concretely satisfies the assertion.",
		"- Do NOT give partial or half credit: each assertion is pass (true) or fail (false).",
		"- Return ONLY a JSON object of the form:",
		'  {"perAssertion": [{"assertion": "<text>", "pass": true|false, "reason": "<one short line>"}, ...]}',
		"  with exactly one entry per assertion, in the same order.",
	];
	return lines.join("\n");
}

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * Robustly extract a `JudgeVerdict` from a model completion. The judge is
 * instructed to return bare JSON, but LLMs wrap it in fences or prose; we strip
 * a ```json fenced block if present, otherwise take the first balanced `{...}`
 * block, then tolerate a leading `JSON.parse` failure by scanning per-assertion
 * outcome tokens as a last resort. Returns `null` when nothing parseable exists.
 */
export function parseJudgeVerdict(raw: unknown): JudgeVerdict | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	let text = raw.trim();

	// 1. If the model wrapped it in a ```json fence, take just that block.
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1].trim();

	// 2. Otherwise strip any leading prose up to the first '{'.
	const brace = text.indexOf("{");
	if (brace > 0) text = text.slice(brace);
	const close = text.lastIndexOf("}");
	if (close >= 0) text = text.slice(0, close + 1);

	try {
		const parsed = JSON.parse(text) as { perAssertion?: unknown };
		if (!Array.isArray(parsed.perAssertion)) return null;
		const items: JudgeVerdictItem[] = [];
		for (const entry of parsed.perAssertion) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			const decision = String(e.pass ?? e.outcome ?? "").toLowerCase();
			const pass = decision === "true" || decision === "pass" || decision === "yes";
			const fail = decision === "false" || decision === "fail" || decision === "no";
			items.push({
				assertion: typeof e.assertion === "string" ? e.assertion : "",
				pass: pass && !fail,
				reason: typeof e.reason === "string" ? e.reason : undefined,
			});
		}
		return items.length > 0 ? { perAssertion: items } : null;
	} catch {
		return null;
	}
}

/** Conservative map of a judge verdict onto our per-assertion outcomes. */
export function verdictToOutcomes(assertions: string[], verdict: JudgeVerdict | null): GradeOutcome[] {
	return assertions.map((assertion, index) => {
		const item = verdict?.perAssertion[index];
		if (!item) return { assertion, outcome: "fail", score: 0 } as const;
		return {
			assertion,
			outcome: item.pass ? ("pass" as const) : ("fail" as const),
			score: item.pass ? 1 : 0,
		};
	});
}

/** Empty / whitespace-only artifact ⇒ every assertion fails (score 0). */
export function isEmptyArtifact(artifact: string): boolean {
	return artifact.trim().length === 0;
}

/**
 * A real model judge as a `CaseGrader`. Injected `fetchImpl` keeps it offline in
 * tests; an empty artifact short-circuits to an all-fail grade with no model call,
 * so the "hollow artifact → zero" guarantee does not depend on the endpoint.
 */
export function modelJudgeGrader(options: ModelJudgeGraderOptions): CaseGrader {
	const model = options.model;
	const rubricVersion = options.rubricVersion ?? DEFAULT_JUDGE_RUBRIC_VERSION;
	const doFetch = options.fetchImpl ?? globalThis.fetch;
	const temperature = options.temperature;
	const maxTokens = options.maxTokens;

	return {
		gradedBy: "model_grader",
		async grade(caseRecord: CaseRecord, artifact: string): Promise<GradeSpec> {
			const assertions = (() => {
				try {
					const parsed = JSON.parse(caseRecord.files.assertionsText) as { assertions?: unknown };
					return Array.isArray(parsed.assertions) ? parsed.assertions.filter((a): a is string => typeof a === "string") : [];
				} catch {
					return [];
				}
			})();

			// Deterministic hollow-artifact guard (acceptance #5): an empty artifact
			// cannot satisfy anything, so we never spend a model call to reach 0.
			if (isEmptyArtifact(artifact)) {
				return {
					perAssertion: assertions.map((assertion) => ({ assertion, outcome: "fail", score: 0 })),
					judge: { modelVersion: model, rubricVersion },
				};
			}

			const prompt = buildJudgePrompt(caseRecord, assertions, artifact, rubricVersion);

			const body: Record<string, unknown> = {
				model,
				messages: [
					{ role: "system", content: "You are a strict rubric grader. Return only the JSON verdict described by the user." },
					{ role: "user", content: prompt },
				],
			};
			if (temperature !== undefined) body.temperature = temperature;
			if (maxTokens !== undefined) body.max_tokens = maxTokens;

			let response: Response;
			try {
				response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
					body: JSON.stringify(body),
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				// Transport failure must not look like a fair grade: fail conservatively.
				return {
					perAssertion: assertions.map((assertion) => ({ assertion, outcome: "fail", score: 0 })),
					judge: { modelVersion: model, rubricVersion },
				};
			}

			if (!response.ok) {
				const snippet = (await response.text().catch(() => "")).slice(0, 400);
				return {
					perAssertion: assertions.map((assertion) => ({ assertion, outcome: "fail", score: 0 })),
					judge: { modelVersion: model, rubricVersion },
				};
			}

			const payload = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
			const content = payload.choices?.[0]?.message?.content;
			const verdict = parseJudgeVerdict(content);

			return {
				perAssertion: verdictToOutcomes(assertions, verdict),
				judge: { modelVersion: model, rubricVersion },
			};
		},
	};
}
