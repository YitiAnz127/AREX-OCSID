import { describe, expect, it } from "vitest";
import { generateMultiPerspectiveWorkflow } from "./adversarial-review.ts";

describe("generateMultiPerspectiveWorkflow (P0-02 template-injection hardening)", () => {
	it("does not interpolate malicious content into a breaking single-quote context", () => {
		const script = generateMultiPerspectiveWorkflow("legal topic", ["legal perspective"]);
		// Sanity: normal inputs produce a script with the topic + one agent call.
		expect(script).toContain("const topic = 'legal topic';");
		expect(script).toContain("Analyze from legal perspective perspective");
	});

	it("escapes an adversarial topic so it cannot break out of the JS string literal", () => {
		const topic = "x'); process.exit(1); //";
		const script = generateMultiPerspectiveWorkflow(topic, []);
		// The raw break must NOT appear as a literal closing quote inside the topic literal.
		expect(script).toContain("const topic = 'x\\'); process.exit(1); //';");
		// The adversarial payload must remain inside the string, not become live code:
		// there must be a single occurrence forming the fully-escaped literal.
		expect(script.match(/process\.exit\(1\)/g)?.length).toBe(1);
	});

	it("escapes adversarial perspective names used in both prompt and label", () => {
		const script = generateMultiPerspectiveWorkflow("topic", ["x'; evil(); //"]);
		// The perspective payload must be escaped inside the generated string literal.
		expect(script).not.toContain("Analyze from x'; evil(); //");
		expect(script).toContain("Analyze from x\\'; evil(); //");
		// label is built from the same escaped value (lowercased)
		expect(script).toContain("{ label: 'x\\'; evil(); //' }");
	});

	it("does not leak an unterminated string or stray backslash for multiline input", () => {
		const script = generateMultiPerspectiveWorkflow("a\nb\r", ["c\nd"]);
		expect(script).not.toMatch(/\n\s*const topic = 'a\nb/);
		// Newlines inside inputs are escaped, so the topic literal stays on one line.
		const topicLine = script.split("\n").find((l) => l.includes("const topic = "));
		expect(topicLine).toContain("a\\nb\\r");
	});
});
