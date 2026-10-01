import { describe, expect, it } from "vitest";
import { generateCodebaseAuditWorkflow } from "./deep-research.ts";

describe("generateCodebaseAuditWorkflow (P0-02 template-injection hardening)", () => {
	it("interpolates a check description safely (raw break is escaped)", () => {
		const script = generateCodebaseAuditWorkflow("app", ["x'; process.exit(1); //"]);
		// The adversarial payload must be escaped inside the generated string literal.
		expect(script).not.toContain("Audit x'; process.exit(1); //");
		expect(script).toContain("Audit x\\'; process.exit(1); //");
		expect(script.match(/process\.exit\(1\)/g)?.length).toBe(1);
	});

	it("escapes the scope into a single-line const literal", () => {
		const script = generateCodebaseAuditWorkflow("scope\n'); evil(); //", []);
		const scopeLine = script.split("\n").find((l) => l.includes("const scope = "));
		expect(scopeLine).toContain("scope\\n\\'); evil(); //'");
		expect(scopeLine).not.toMatch(/\n/);
	});

	it("keeps the label sanitized for adversarial check text", () => {
		const script = generateCodebaseAuditWorkflow("app", ["Upgrade!! deps & fix"]);
		expect(script).toContain("{ label: 'upgrade-deps-fix' }");
	});
});
