import { describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "./experimental.ts";

// H4: DISCO_* boolean env toggles should accept the same truthy set
// ("1"/"true"/"yes", case-insensitive) as the other DISCO_* flags.
describe("areExperimentalFeaturesEnabled truthy-env coercion (H4)", () => {
	const original = process.env.DISCO_EXPERIMENTAL;
	afterEach(() => {
		if (original === undefined) delete process.env.DISCO_EXPERIMENTAL;
		else process.env.DISCO_EXPERIMENTAL = original;
	});

	it("accepts '1'", () => {
		process.env.DISCO_EXPERIMENTAL = "1";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("accepts 'true' (case-insensitive)", () => {
		process.env.DISCO_EXPERIMENTAL = "true";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
		process.env.DISCO_EXPERIMENTAL = "TRUE";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("accepts 'yes'", () => {
		process.env.DISCO_EXPERIMENTAL = "yes";
		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("rejects falsy/absent", () => {
		process.env.DISCO_EXPERIMENTAL = "0";
		expect(areExperimentalFeaturesEnabled()).toBe(false);
		delete process.env.DISCO_EXPERIMENTAL;
		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
