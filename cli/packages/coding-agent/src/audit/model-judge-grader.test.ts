import { describe, expect, it } from "vitest";
import { modelJudgeGrader, buildJudgePrompt, parseJudgeVerdict, verdictToOutcomes, isEmptyArtifact } from "./model-judge-grader.ts";
import type { CaseRecord } from "./types.ts";

function mkCase(assertions: string[]): CaseRecord {
	return { skillId: "chemprop", caseId: "x", files: { userRequest: "u", assertionsText: JSON.stringify({ schema: "disco.usability-case.v1", target_skill_area: "x", target_capability: "y", difficulty: "basic", evidence_basis: [], expected_skill_files: [], assertions }) } };
}

/** A fetch that returns a canned chat-completion with the given content. */
function fakeFetch(json: string, status = 200): typeof fetch {
	return (async () => {
		return new Response(JSON.stringify({ choices: [{ message: { content: json } }] }), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

const MODEL = "DeepSeek-V4-Flash-0731";
const RUBRIC = "ar-ex-rsi.judge.v1";

function grader(fetchImpl: typeof fetch) {
	const grade = modelJudgeGrader({ baseUrl: "https://example.test/v1", apiKey: "test-secret-key", model: MODEL, rubricVersion: RUBRIC, fetchImpl });
	return {
		grade,
		...grade,
	};
}

describe("model judge grader (route B, offline)", () => {
	it("declares gradedBy 'model_grader'", () => {
		expect(modelJudgeGrader({ baseUrl: "u", apiKey: "k", model: "m" }).gradedBy).toBe("model_grader");
	});

	it("P0-3 ACCEPTANCE #5: an EMPTY artifact scores 0 WITHOUT any model call", async () => {
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			throw new Error("network must not be touched for an empty artifact");
		}) as typeof fetch;
		const g = modelJudgeGrader({ baseUrl: "https://example.test/v1", apiKey: "k", model: MODEL, rubricVersion: RUBRIC, fetchImpl });
		const grade = await g.grade(mkCase(["produces a forecast", "outputs numeric values"]), "   ");
		expect(called).toBe(false);
		for (const o of grade.perAssertion) {
			expect(o.outcome).toBe("fail");
			expect(o.score).toBe(0);
		}
	});

	it("records judge modelVersion + rubricVersion on every GradeSpec", async () => {
		const g = modelJudgeGrader({
			baseUrl: "https://example.test/v1",
			apiKey: "k",
			model: MODEL,
			rubricVersion: RUBRIC,
			fetchImpl: fakeFetch(JSON.stringify({ perAssertion: [{ assertion: "a", pass: true, reason: "ok" }] })),
		});
		const grade = await g.grade(mkCase(["a"]), "artifact satisfies a");
		expect(grade.judge).toEqual({ modelVersion: MODEL, rubricVersion: RUBRIC });
	});

	it("maps a judged pass/fail verdict onto outcomes", () => {
		const verdict = parseJudgeVerdict(`{"perAssertion":[{"assertion":"a","pass":true,"reason":"ok"},{"assertion":"b","pass":false,"reason":"missing"}]}`);
		const outcomes = verdictToOutcomes(["a", "b"], verdict);
		expect(outcomes[0]).toEqual({ assertion: "a", outcome: "pass", score: 1 });
		expect(outcomes[1]).toEqual({ assertion: "b", outcome: "fail", score: 0 });
	});

	it("P0-3 ACCEPTANCE #5 (offline): judge marks an unrelated/hollow artifact as fail — case does NOT get ~0.5", async () => {
		// A judge that correctly decides the artifact is off-topic: every assertion fails.
		const g = modelJudgeGrader({
			baseUrl: "https://example.test/v1",
			apiKey: "k",
			model: MODEL,
			rubricVersion: RUBRIC,
			fetchImpl: fakeFetch(JSON.stringify({ perAssertion: [{ assertion: "produces a hydrocarbon analysis", pass: false, reason: "artifact is about the weather" }] })),
		});
		const grade = await g.grade(mkCase(["produces a hydrocarbon analysis"]), "The autumn leaves are golden in the crisp morning air.");
		expect(grade.perAssertion[0].outcome).toBe("fail");
		expect(grade.perAssertion[0].score).toBe(0);
	});

	it("a judge that marks a relevant artifact pass yields score 1", async () => {
		const g = modelJudgeGrader({
			baseUrl: "https://example.test/v1",
			apiKey: "k",
			model: MODEL,
			rubricVersion: RUBRIC,
			fetchImpl: fakeFetch(JSON.stringify({ perAssertion: [{ assertion: "uses build_cli_command.py", pass: true, reason: "present" }] })),
		});
		const grade = await g.grade(mkCase(["uses build_cli_command.py"]), "used build_cli_command.py for validation");
		expect(grade.perAssertion[0].score).toBe(1);
	});

	it("transport failure fails conservatively (no inflated credit) and keeps judge meta", async () => {
		const fetchImpl = (async () => {
			throw new Error("connection refused");
		}) as typeof fetch;
		const g = modelJudgeGrader({ baseUrl: "https://example.test/v1", apiKey: "k", model: MODEL, rubricVersion: RUBRIC, fetchImpl });
		const grade = await g.grade(mkCase(["a"]), "some artifact");
		expect(grade.perAssertion[0].outcome).toBe("fail");
		expect(grade.perAssertion[0].score).toBe(0);
		expect(grade.judge?.modelVersion).toBe(MODEL);
	});

	it("parses fenced and bare JSON", () => {
		expect(parseJudgeVerdict('```json\n{"perAssertion":[{"assertion":"a","pass":true}]}\n```')).toEqual({ perAssertion: [{ assertion: "a", pass: true, reason: undefined }] });
		expect(parseJudgeVerdict("leading prose {\"perAssertion\":[{\"assertion\":\"a\",\"pass\":false}]} trailing")).toEqual({ perAssertion: [{ assertion: "a", pass: false, reason: undefined }] });
		expect(parseJudgeVerdict("not json at all")).toBeNull();
	});

	it("prompt embeds the user request, assertions, artifact, and rubric version", () => {
		const p = buildJudgePrompt(mkCase(["uses build_cli_command.py"]), ["uses build_cli_command.py"], "artifact text", RUBRIC);
		expect(p).toContain("artifact text");
		expect(p).toContain("uses build_cli_command.py");
		expect(p).toContain(RUBRIC);
	});

	it("isEmptyArtifact helper", () => {
		expect(isEmptyArtifact("")).toBe(true);
		expect(isEmptyArtifact("\n\t")).toBe(true);
		expect(isEmptyArtifact("x")).toBe(false);
	});
});
