import { describe, expect, it } from "vitest";
import { resolveConfigValue, resolveConfigValueOrThrow } from "./resolve-config-value.ts";

describe("resolveConfigValue empty-string env semantics (H2)", () => {
	it("an explicitly-set empty-string env value resolves to '' (not unset)", () => {
		const env = { EMPTY: "" };
		expect(resolveConfigValue("$EMPTY", env)).toBe("");
		expect(resolveConfigValue("${EMPTY}", env)).toBe("");
	});

	it("a genuinely missing env var still resolves to undefined", () => {
		expect(resolveConfigValue("$MISSING", {})).toBeUndefined();
	});

	it("resolveConfigValueOrThrow accepts an empty-string env value", () => {
		const env = { EMPTY: "" };
		// Should NOT throw: "" is a resolved value, not a missing variable.
		expect(resolveConfigValueOrThrow("$EMPTY", "test", env)).toBe("");
	});
});
